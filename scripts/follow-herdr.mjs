#!/usr/bin/env node
// Keeps agents-view.js, our derivative of Herdr's shipped Agents mod, in step with it.
//   node scripts/follow-herdr.mjs           report whether the installed Herdr ships a different Agents mod
//   node scripts/follow-herdr.mjs --merge   merge Herdr's changes into agents-view.js (three-way, with
//                                           upstream/agents-main.js as the common base), then record the
//                                           new version as the base
// HERDR_APP_HOME picks the Herdr home to read the shipped mod from.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const appHome = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const shipped = join(appHome, "mods", "agents", "main.js");
const base = join(root, "upstream", "agents-main.js");
const fork = join(root, "mods", "super-agent", "agents-view.js");
const upstreamJson = join(root, "mods", "super-agent", "upstream.json");
const notice = join(root, "mods", "super-agent", "NOTICE");

const upstream = JSON.parse(readFileSync(upstreamJson, "utf8"));
const shippedText = readFileSync(shipped, "utf8");
const sha = createHash("sha256").update(shippedText).digest("hex");
const version = spawnSync("herdr-app", ["--version"], { encoding: "utf8" }).stdout?.match(/(\d+\.\d+\.\d+\S*)/)?.[1];

if (sha === upstream.agents_sha256) {
  console.log(`agents-view.js follows Herdr ${upstream.herdr}, the Agents mod this Herdr (${version ?? "unknown version"}) ships.`);
  process.exit(0);
}

if (!process.argv.includes("--merge")) {
  console.log(`Herdr ${version ?? "(unknown version)"} ships a different Agents mod than ${upstream.herdr}, which agents-view.js follows.`);
  console.log(spawnSync("git", ["diff", "--no-index", "--stat", base, shipped], { encoding: "utf8" }).stdout.trim());
  console.log("Run npm run follow-herdr -- --merge to merge it.");
  process.exit(1);
}

if (!version) throw new Error("herdr-app --version gave no version; cannot record what was merged.");
const merge = spawnSync("git", ["merge-file", "-L", "agents-view.js", "-L", `herdr ${upstream.herdr}`, "-L", `herdr ${version}`, fork, base, shipped], { encoding: "utf8" });
if (merge.status < 0 || merge.error) throw merge.error ?? new Error(merge.stderr);
writeFileSync(base, shippedText);
writeFileSync(upstreamJson, `${JSON.stringify({ herdr: version, agents_sha256: sha }, null, 2)}\n`);
writeFileSync(notice, readFileSync(notice, "utf8").replace(/shipped \`agents\` mod, version [^.\s]+(\.[0-9]+)*\./, `shipped \`agents\` mod, version ${version}.`));
if (merge.status > 0) {
  console.log(`Merged Herdr ${upstream.herdr} → ${version} into agents-view.js with ${merge.status} conflict(s); resolve the <<<<<<< markers, then test in Herdr.`);
  process.exit(1);
}
console.log(`Merged Herdr ${upstream.herdr} → ${version} into agents-view.js cleanly; review the diff and test in Herdr.`);
