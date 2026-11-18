import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { upstream, agentsDrift, compareVersions, namesLayout, followHerdr, followLayout, followWarnings, patchLayout, saveBase } from "../mods/super-agent/lib/follow.mjs";

const MOD = "super-agent";
const NODE = "/usr/bin/node";

function shipped({ extra = false } = {}) {
  return {
    id: "root",
    type: "row",
    children: [
      { id: "sidebar", type: "column", size: { px: 268 }, children: [{ id: "agents", type: "block", content: { mod: "agents" } }] },
      { id: "main", type: "block", content: { tab: "active" }, ...(extra ? { padding: 12 } : {}) },
    ],
  };
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-follow-"));
  mkdirSync(join(dir, "layouts"), { recursive: true });
  return dir;
}

const put = (dir, name, layout) => writeFileSync(join(dir, "layouts", `${name}.json`), JSON.stringify(layout));
const get = (dir, name) => JSON.parse(readFileSync(join(dir, "layouts", `${name}.json`), "utf8"));

// A Super Agent clone of `source` as setup leaves it, with its base remembered.
function install(dir, source, { base = true } = {}) {
  const clone = { cloned_from: { name: "main", version: "0.1.11" }, ...patchLayout(structuredClone(source), MOD, NODE) };
  put(dir, "super-agent-main", clone);
  if (base) saveBase(dir, MOD, "super-agent-main", source);
}

const follow = (dir, options = {}) => followLayout({ appHome: dir, modName: MOD, layoutName: "super-agent-main", herdrVersion: "0.1.17", ...options });

const UPSTREAM = upstream();

test("upstream.json records the Agents mod kept in upstream/", () => {
  const sha = createHash("sha256").update(readFileSync(resolve("upstream/agents-main.js"))).digest("hex");
  assert.equal(UPSTREAM.agents_sha256, sha);
  assert.match(readFileSync(resolve("mods/super-agent/NOTICE"), "utf8"), new RegExp(`version ${UPSTREAM.herdr.replaceAll(".", "\\.")}\\.`));
});

test("a layout matching its source is current and remembers that source", () => {
  const dir = home();
  put(dir, "main", shipped());
  install(dir, shipped(), { base: false });
  assert.equal(follow(dir).state, "current");
  assert.ok(existsSync(join(dir, "data", MOD, "layout-bases", "super-agent-main.json")));
});

test("an untouched layout is rebuilt from its changed source, keeping its Agents block", () => {
  const dir = home();
  install(dir, shipped());
  put(dir, "main", shipped({ extra: true }));
  const result = follow(dir);
  assert.equal(result.state, "updated");
  assert.equal(result.backup, null);
  const layout = get(dir, "super-agent-main");
  assert.equal(layout.children[1].padding, 12);
  assert.deepEqual(layout.children[0].children[0].content, { mod: MOD, props: { role: "agents", mod: MOD, node: NODE } });
  assert.deepEqual(layout.cloned_from, { name: "main", version: "0.1.17" });
  assert.equal(layout.id, "root");
  assert.equal(follow(dir).state, "current");
  // Matching its source again refreshes the remembered base, so the next Herdr change rebuilds it.
  put(dir, "main", shipped());
  assert.equal(follow(dir).state, "updated");
});

test("a layout with its own edits is left alone until a refresh, which keeps a backup", () => {
  const dir = home();
  install(dir, shipped());
  const edited = get(dir, "super-agent-main");
  edited.children[0].size.px = 300;
  put(dir, "super-agent-main", edited);
  put(dir, "main", shipped({ extra: true }));
  assert.deepEqual([follow(dir).state, follow(dir).known], ["edited", true]);
  assert.equal(get(dir, "super-agent-main").children[0].size.px, 300);
  const result = follow(dir, { refresh: true, now: 7 });
  assert.equal(result.state, "refreshed");
  assert.match(followWarnings({ layouts: [{ ...result, state: "edited", known: true }], agents: { state: "current" } }).join(), /--layout super-agent-main --refresh-layout/);
  assert.equal(JSON.parse(readFileSync(result.backup, "utf8")).children[0].size.px, 300);
  assert.equal(get(dir, "super-agent-main").children[1].padding, 12);
});

test("without a remembered base a differing layout counts as edited", () => {
  const dir = home();
  install(dir, shipped(), { base: false });
  put(dir, "main", shipped({ extra: true }));
  assert.deepEqual([follow(dir).state, follow(dir).known], ["edited", false]);
});

test("a dry run reports a rebuild without writing it", () => {
  const dir = home();
  install(dir, shipped());
  put(dir, "main", shipped({ extra: true }));
  assert.equal(follow(dir, { dryRun: true }).state, "updated");
  assert.equal(get(dir, "super-agent-main").children[1].padding, undefined);
});

test("a layout without a usable source is left alone", () => {
  const dir = home();
  install(dir, shipped());
  assert.equal(follow(dir).state, "no-source");
  const twoAgents = shipped();
  twoAgents.children.push({ type: "block", content: { mod: "agents" } });
  put(dir, "main", twoAgents);
  assert.equal(follow(dir).state, "no-source");
});

test("Agents mod drift compares Herdr's shipped mod with the followed version", () => {
  const dir = home();
  assert.equal(agentsDrift({ appHome: dir, modName: MOD }).state, "unknown");
  mkdirSync(join(dir, "mods", "agents"), { recursive: true });
  writeFileSync(join(dir, "mods", "agents", "main.js"), readFileSync(resolve("upstream/agents-main.js")));
  assert.equal(agentsDrift({ appHome: dir, modName: MOD }).state, "current");
  writeFileSync(join(dir, "mods", "agents", "main.js"), "// newer\n");
  const drift = agentsDrift({ appHome: dir, modName: MOD });
  assert.deepEqual(drift, { state: "behind", follows: UPSTREAM.herdr, herdr: null });
  assert.match(followWarnings({ layouts: [], agents: drift }).join(), /Agents sidebar has changed/);
  const older = agentsDrift({ appHome: dir, modName: MOD, herdrVersion: "0.1.12" });
  assert.equal(older.state, "herdr-older");
  assert.match(followWarnings({ layouts: [], agents: older }).join(), /Update Herdr/);
  assert.equal(agentsDrift({ appHome: dir, modName: MOD, herdrVersion: "9.0.0" }).state, "behind");
});

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.1.9", "0.1.16"), -1);
  assert.equal(compareVersions("0.1.16", "0.1.16"), 0);
  assert.equal(compareVersions("0.2.0-beta", "0.1.16"), 1);
  assert.equal(compareVersions(null, "0.1.16"), null);
});

test("a rebuilt layout Herdr reports an error for is put back", () => {
  const dir = home();
  install(dir, shipped());
  put(dir, "main", shipped({ extra: true }));
  const before = readFileSync(join(dir, "layouts", "super-agent-main.json"), "utf8");
  const herdrApp = (args) => args[0] === "--version" ? "herdr-app 0.1.17\n" : JSON.stringify({ errors: [{ file: "super-agent-main.json", message: "bad" }] });
  const result = followHerdr({ appHome: dir, modName: MOD, herdrApp, settle: 0 });
  assert.equal(result.herdr, "0.1.17");
  assert.equal(result.layouts[0].state, "failed");
  assert.equal(result.layouts[0].previous, undefined);
  assert.equal(readFileSync(join(dir, "layouts", "super-agent-main.json"), "utf8"), before);
  // The old base stays, so the next run tries again instead of calling the clone edited.
  assert.equal(follow(dir, { dryRun: true }).state, "updated");
});

test("an error for another layout does not put this one back", () => {
  const dir = home();
  install(dir, shipped());
  const second = { cloned_from: { name: "main", version: "0.1.11" }, ...patchLayout(shipped(), MOD, NODE) };
  put(dir, "super-agent-main-2", second);
  saveBase(dir, MOD, "super-agent-main-2", shipped());
  put(dir, "main", shipped({ extra: true }));
  const herdrApp = (args) => args[0] === "--version" ? "herdr-app 0.1.17" : JSON.stringify({ errors: [{ message: "bad layout super-agent-main-2.json" }] });
  const states = Object.fromEntries(followHerdr({ appHome: dir, modName: MOD, herdrApp, settle: 0 }).layouts.map((l) => [l.layout, l.state]));
  assert.deepEqual(states, { "super-agent-main": "updated", "super-agent-main-2": "failed" });
  assert.equal(namesLayout("x super-agent-main.json", "super-agent-main"), true);
  assert.equal(namesLayout("x super-agent-main-2.json", "super-agent-main"), false);
});

test("a rebuild that cannot be checked with herdr-app status is put back", () => {
  const dir = home();
  install(dir, shipped());
  put(dir, "main", shipped({ extra: true }));
  const herdrApp = (args) => { if (args[0] === "status") throw new Error("herdr-app: not found"); return "herdr-app 0.1.17"; };
  const result = followHerdr({ appHome: dir, modName: MOD, herdrApp, settle: 0 }).layouts[0];
  assert.equal(result.state, "failed");
  assert.match(result.error, /could not check it.*not found/);
  assert.equal(get(dir, "super-agent-main").children[1].padding, undefined);
  assert.match(followWarnings({ layouts: [result], agents: { state: "current" } }).join(), /could not follow main/);
});

test("a clone whose source is gone says so; a layout that is not Super Agent's is refused", () => {
  const dir = home();
  install(dir, shipped());
  const gone = follow(dir);
  assert.deepEqual([gone.state, gone.reason], ["no-source", "missing"]);
  assert.match(followWarnings({ layouts: [gone], agents: { state: "current" } }).join(), /main is gone/);
  put(dir, "mine", shipped());
  assert.throws(() => followLayout({ appHome: dir, modName: MOD, layoutName: "mine" }), /mine is not a super-agent layout/);
  assert.throws(() => followLayout({ appHome: dir, modName: MOD, layoutName: "nope" }), /no layout named nope/);
});

test("the CLI follows every installed layout and reports warnings", () => {
  const dir = home();
  install(dir, shipped());
  put(dir, "main", shipped({ extra: true }));
  put(dir, "other", shipped());
  const fake = join(dir, "herdr-app.mjs");
  writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(process.argv[2] === "--version" ? "herdr-app 0.1.17\\n" : '{"errors":[]}');\n`, { mode: 0o755 });
  const run = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", resolve("mods/super-agent/bin/super-agent.mjs"), "follow-herdr"], {
    encoding: "utf8",
    env: { ...process.env, HERDR_APP_HOME: dir, SUPER_AGENT_HERDR_APP: fake },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.layouts.map((layout) => [layout.layout, layout.state]), [["super-agent-main", "updated"]]);
  assert.match(out.warnings.join(), /rebuilt from Herdr's current main/);
  assert.equal(get(dir, "super-agent-main").children[1].padding, 12);
});
