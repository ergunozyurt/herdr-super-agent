// Keeps an installed Super Agent layout in step with the layout it was cloned from, and reports
// when Herdr's shipped Agents mod has moved past the version agents-view.js follows.
// Herdr never updates a clone, so without this the clone stays frozen at its first Herdr version.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));

// The Herdr version agents-view.js was last merged with, and the hash of that version's
// shipped mods/agents/main.js. scripts/follow-herdr.mjs --merge updates it.
export const UPSTREAM = JSON.parse(readFileSync(join(here, "upstream.json"), "utf8"));

export function nodes(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node?.children ?? []) nodes(child, predicate, found);
  return found;
}

const isOwnBlock = (modName) => (node) =>
  node?.type === "block" && node.content?.mod === modName && node.content?.props?.role === "agents";
const isShippedAgents = (node) => node?.type === "block" && node.content?.mod === "agents";

export function inspectLayout(layout, modName) {
  const ownBlocks = nodes(layout, isOwnBlock(modName));
  if (ownBlocks.length === 1) return { installed: true, agentBlock: ownBlocks[0] };
  const agentBlocks = nodes(layout, isShippedAgents);
  if (agentBlocks.length !== 1) {
    throw new Error(`expected one shipped Agents block or one installed ${modName} Agents block.`);
  }
  return { installed: false, agentBlock: agentBlocks[0] };
}

export function patchLayout(layout, modName, node) {
  const { agentBlock } = inspectLayout(layout, modName);
  agentBlock.content = { mod: modName, props: { role: "agents", mod: modName, node } };
  return layout;
}

// A layout as text that ignores key order, clone bookkeeping and which Agents mod it shows,
// so a Super Agent layout compares equal to the layout it was made from.
export function canonical(layout, modName) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "cloned_from") continue;
      out[key] = walk(value[key]);
    }
    if (isOwnBlock(modName)(value)) out.content = { mod: "agents" };
    return out;
  };
  return JSON.stringify(walk(layout));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

const layoutText = (layout) => `${JSON.stringify(layout, null, 2)}\n`;

export function paths(appHome, modName) {
  return {
    layouts: join(appHome, "layouts"),
    bases: join(appHome, "data", modName, "layout-bases"),
    shippedAgents: join(appHome, "mods", "agents", "main.js"),
  };
}

// Remembers the source layout a Super Agent layout was built from, so a later run can tell
// the person's own edits from Herdr's.
export function saveBase(appHome, modName, layoutName, source) {
  writeAtomic(join(paths(appHome, modName).bases, `${layoutName}.json`), layoutText(source));
}

export function installedLayouts(appHome, modName) {
  const dir = paths(appHome, modName).layouts;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((name) => {
    try {
      return nodes(readJson(join(dir, `${name}.json`)), isOwnBlock(modName)).length === 1;
    } catch {
      return false;
    }
  });
}

// What a Super Agent layout should be now: its source layout as it is today, with this mod's
// Agents block. States:
//   current     already matches its source
//   updated     its source changed and it had no edits of its own, so it was rebuilt
//   edited      its source changed, but so did it (or it can't tell): left alone unless refresh
//   refreshed   rebuilt on request despite its own edits; the old file is kept as backup
//   no-source   it records no source layout, or that layout is gone or has no single Agents block
export function followLayout({ appHome, modName, layoutName, node, herdrVersion = null, refresh = false, dryRun = false, now = Date.now() }) {
  const { layouts } = paths(appHome, modName);
  const file = join(layouts, `${layoutName}.json`);
  const basePath = join(paths(appHome, modName).bases, `${layoutName}.json`);
  const current = readJson(file);
  const sourceName = current.cloned_from?.name;
  const result = { layout: layoutName, source: sourceName ?? null };
  const sourceFile = sourceName && join(layouts, `${sourceName}.json`);
  if (!sourceName || sourceName === layoutName || !existsSync(sourceFile)) return { ...result, state: "no-source" };
  const source = readJson(sourceFile);
  if (nodes(source, isOwnBlock(modName)).length || nodes(source, isShippedAgents).length !== 1) return { ...result, state: "no-source" };

  const mine = canonical(current, modName);
  if (mine === canonical(source, modName)) {
    if (!dryRun && !existsSync(basePath)) saveBase(appHome, modName, layoutName, source);
    return { ...result, state: "current" };
  }
  const base = existsSync(basePath) ? readJson(basePath) : null;
  const untouched = Boolean(base) && mine === canonical(base, modName);
  if (!untouched && !refresh) return { ...result, state: "edited", known: Boolean(base) };

  const ownNode = nodes(current, isOwnBlock(modName))[0].content.props.node;
  const next = {
    ...structuredClone(source),
    id: current.id ?? source.id,
    cloned_from: { name: sourceName, version: herdrVersion ?? current.cloned_from.version ?? null },
  };
  patchLayout(next, modName, node ?? ownNode);
  const backup = untouched ? null : `${file}.old-${now}`;
  if (dryRun) return { ...result, state: untouched ? "updated" : "refreshed", backup: null, dryRun: true };
  const previous = readFileSync(file, "utf8");
  if (backup) writeFileSync(backup, previous);
  writeAtomic(file, layoutText(next));
  saveBase(appHome, modName, layoutName, source);
  return { ...result, state: untouched ? "updated" : "refreshed", backup, previous };
}

export function restoreLayout(appHome, layoutName, previous) {
  writeAtomic(join(appHome, "layouts", `${layoutName}.json`), previous);
}

// herdr-app's version, or null when it can't be asked.
export function herdrVersion(herdrApp) {
  try {
    return herdrApp(["--version"]).match(/(\d+\.\d+\.\d+\S*)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// Brings every installed Super Agent layout (or just `layouts`) up to date with its source and
// reports Agents mod drift. `herdrApp(args)` runs herdr-app and returns its stdout. A rebuilt layout
// that Herdr reports an error for is put back as it was.
export function followHerdr({ appHome, modName, herdrApp, layouts = null, node = null, refresh = false, dryRun = false, settle = 1000 }) {
  const version = herdrVersion(herdrApp);
  const results = (layouts ?? installedLayouts(appHome, modName)).map((layoutName) => {
    try {
      return followLayout({ appHome, modName, layoutName, node, herdrVersion: version, refresh, dryRun });
    } catch (error) {
      return { layout: layoutName, state: "failed", error: error.message };
    }
  });
  const rebuilt = results.filter((result) => result.previous);
  if (rebuilt.length) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settle);
    let errors = [];
    try {
      errors = JSON.parse(herdrApp(["status"])).errors ?? [];
    } catch {}
    for (const result of rebuilt) {
      const mine = errors.filter((error) => JSON.stringify(error).includes(result.layout));
      if (mine.length) {
        restoreLayout(appHome, result.layout, result.previous);
        Object.assign(result, { state: "failed", error: JSON.stringify(mine) });
      }
    }
  }
  for (const result of results) delete result.previous;
  return { herdr: version, layouts: results, agents: agentsDrift({ appHome, modName, herdrVersion: version }) };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// -1, 0 or 1 for dotted versions such as 0.1.16; null when either can't be read.
export function compareVersions(a, b) {
  const parse = (v) => (/^\d+(\.\d+)*/.exec(v ?? "")?.[0].split(".").map(Number)) ?? null;
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

// Whether Herdr ships the same Agents mod that agents-view.js was last merged with:
// "behind" when Herdr's is newer, "herdr-older" when this Herdr predates the followed one.
export function agentsDrift({ appHome, modName, herdrVersion = null }) {
  const shipped = paths(appHome, modName).shippedAgents;
  const follows = UPSTREAM.herdr;
  if (!existsSync(shipped)) return { state: "unknown", follows };
  if (sha256(shipped) === UPSTREAM.agents_sha256) return { state: "current", follows };
  return { state: compareVersions(herdrVersion, follows) === -1 ? "herdr-older" : "behind", follows, herdr: herdrVersion };
}

// What the person should know after a follow run: an edited layout left behind, or a sidebar
// that follows an older Agents mod than the one Herdr ships.
export function followWarnings({ layouts, agents }) {
  const warnings = [];
  for (const result of layouts) {
    if (result.state === "edited") {
      warnings.push(`${result.layout} differs from Herdr's current ${result.source}${result.known ? " and has edits of its own" : ", and Super Agent cannot tell whether you edited it"}. Run \`herdr-super-agent follow-herdr --refresh-layout\` to rebuild it from ${result.source}; the old file is kept beside it.`);
    }
    if (result.state === "updated") warnings.push(`${result.layout} was rebuilt from Herdr's current ${result.source}.`);
    if (result.state === "refreshed") warnings.push(`${result.layout} was rebuilt from Herdr's current ${result.source}; your previous version is ${result.backup}.`);
    if (result.state === "failed") warnings.push(`${result.layout} could not follow ${result.source ?? "its source"}: ${result.error}`);
  }
  if (agents.state === "herdr-older") {
    warnings.push(`Super Agent's sidebar is built for Herdr ${agents.follows} or newer, and this is Herdr ${agents.herdr}. Update Herdr.`);
  }
  if (agents.state === "behind") {
    warnings.push(`Herdr's Agents sidebar has changed since ${agents.follows}, the version Super Agent's sidebar follows; Super Agent's sidebar lacks those changes until Super Agent is updated.`);
  }
  return warnings;
}
