#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const modName = basename(here);
const appHome = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const layoutsDir = join(appHome, "layouts");
const cli = join(here, "bin", "super-agent.mjs");
const link = join(homedir(), ".local", "bin", "herdr-super-agent");
const skillSource = join(here, "skill", "SKILL.md");
const skillTargets = [
  join(homedir(), ".pi", "agent", "skills", "super-agent", "SKILL.md"),
  join(homedir(), ".claude", "skills", "super-agent", "SKILL.md"),
  join(homedir(), ".codex", "skills", "super-agent", "SKILL.md"),
];
const installSkill = process.argv.includes("--install-skill");
const launcher = `#!/bin/sh\nHERDR_APP_HOME='${appHome.replaceAll("'", "'\\''")}' exec '${process.execPath.replaceAll("'", "'\\''")}' --no-warnings=ExperimentalWarning '${cli.replaceAll("'", "'\\''")}' \"$@\"\n`;

function command(program, args, { json = true } = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: appHome } });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `${program} exited with ${result.status}.`);
  }
  if (!json) return result.stdout;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${program} returned invalid JSON.`);
  }
}

function nodes(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node?.children ?? []) nodes(child, predicate, found);
  return found;
}

function layoutPath(name) {
  return join(layoutsDir, `${name}.json`);
}

function availableClone(source) {
  const base = `super-agent-${source}`;
  if (!existsSync(layoutPath(base))) return base;
  for (let i = 2; ; i += 1) if (!existsSync(layoutPath(`${base}-${i}`))) return `${base}-${i}`;
}

function inspectLayout(layout) {
  const ownBlocks = nodes(layout, (node) =>
    node?.type === "block" && node.content?.mod === modName && node.content?.props?.role === "agents",
  );
  if (ownBlocks.length === 1) return { installed: true, agentBlock: ownBlocks[0] };
  const agentBlocks = nodes(layout, (node) => node?.type === "block" && node.content?.mod === "agents");
  if (agentBlocks.length !== 1) {
    throw new Error(`expected one shipped Agents block or one installed ${modName} Agents block.`);
  }
  return { installed: false, agentBlock: agentBlocks[0] };
}

function preflightLink() {
  if (!existsSync(link)) return;
  const stat = lstatSync(link);
  if (stat.isSymbolicLink() && readlinkSync(link) === cli) return;
  if (stat.isFile() && readFileSync(link, "utf8") === launcher) return;
  throw new Error(`${link} already exists and is not this installation.`);
}

function preflightSkills() {
  if (!installSkill) return;
  for (const target of skillTargets) {
    if (!existsSync(target)) continue;
    const content = readFileSync(target, "utf8");
    if (!/^---\s*$[\s\S]*?^name:\s*super-agent\s*$/m.test(content)) {
      throw new Error(`${target} already exists and is not the Super Agent skill.`);
    }
  }
}

function patchLayout(layout) {
  const { agentBlock } = inspectLayout(layout);
  agentBlock.content = {
    mod: modName,
    props: { role: "agents", mod: modName, node: process.execPath },
  };
}

async function main() {
  let source = null;
  let clone = null;
  let linkCreated = false;
  const skillsCreated = [];
  const skillBackups = new Map();
  try {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error(`Node >=22.19 is required; found ${process.versions.node}.`);
    if (!existsSync(cli)) throw new Error(`missing CLI at ${cli}.`);
    preflightLink();
    preflightSkills();

    const before = command("herdr-app", ["status"]);
    source = before.layout;
    if (!source) throw new Error("Herdr has no shown layout.");
    const sourceFile = layoutPath(source);
    if (!existsSync(sourceFile)) throw new Error(`cannot find ${sourceFile}.`);
    const inspection = inspectLayout(JSON.parse(readFileSync(sourceFile, "utf8")));
    let targetLayout = source;

    if (!inspection.installed) {
      clone = availableClone(source);
      command("herdr-app", ["do", "layout.clone", "--name", source, "--as", clone]);
      const cloneFile = layoutPath(clone);
      if (!existsSync(cloneFile)) throw new Error(`layout clone did not create ${cloneFile}.`);

      const layout = JSON.parse(readFileSync(cloneFile, "utf8"));
      patchLayout(layout);
      const temporary = `${cloneFile}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(layout, null, 2)}\n`);
      renameSync(temporary, cloneFile);
      targetLayout = clone;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    const after = command("herdr-app", ["status"]);
    const relevantErrors = (after.errors ?? []).filter((error) => JSON.stringify(error).includes(targetLayout) || JSON.stringify(error).includes(modName));
    if (relevantErrors.length) throw new Error(JSON.stringify(relevantErrors));

    command(process.execPath, ["--no-warnings=ExperimentalWarning", cli, "snapshot"]);

    if (installSkill) {
      for (const target of skillTargets) {
        if (existsSync(target)) skillBackups.set(target, readFileSync(target, "utf8"));
        else skillsCreated.push(target);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(skillSource, target);
      }
    }

    if (!existsSync(link) || lstatSync(link).isSymbolicLink()) {
      mkdirSync(dirname(link), { recursive: true });
      rmSync(link, { force: true });
      writeFileSync(link, launcher);
      chmodSync(link, 0o755);
      linkCreated = true;
    }

    process.stdout.write(`${JSON.stringify({
      layout: targetLayout,
      mod: modName,
      cli: link,
      skills: installSkill ? skillTargets : [],
    }, null, 2)}\n`);
  } catch (error) {
    if (source && clone) {
      try { command("herdr-app", ["do", "layout.switch", "--name", source]); } catch {}
      rmSync(layoutPath(clone), { force: true });
      rmSync(join(layoutsDir, ".state", `${clone}.json`), { force: true });
    }
    if (linkCreated) rmSync(link, { force: true });
    for (const target of skillsCreated) rmSync(target, { force: true });
    for (const [target, content] of skillBackups) writeFileSync(target, content);
    process.stderr.write(`Super Agent setup stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}

await main();
