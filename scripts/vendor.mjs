#!/usr/bin/env node
// Copies pi-tui and its runtime dependencies into mods/super-agent/vendor/node_modules,
// so the catalog mod installs by copying its folder: no npm install, no network.
//
//   npm run vendor          refresh vendor/ from the version pinned in package.json
//   npm run vendor:check    fail if vendor/ does not match that version (CI)
//
// Only this maintainer step uses the network. Native prebuilds, source maps and type
// declarations are left out: the mod reads the clipboard with osascript instead.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "mods", "super-agent", "vendor");
const PACKAGE = "@earendil-works/pi-tui";
const SKIP = [/\.map$/, /\.d\.[cm]?ts$/, /^native$/, /^bin$/, /^man$/, /^CHANGELOG\.md$/i];

const pinned = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.[PACKAGE];
if (!/^\d+\.\d+\.\d+$/.test(pinned ?? "")) throw new Error(`Pin ${PACKAGE} to an exact version in package.json devDependencies.`);

function copyFiltered(from, to) {
  for (const name of readdirSync(from)) {
    if (SKIP.some((pattern) => pattern.test(name))) continue;
    const source = join(from, name);
    if (statSync(source).isDirectory()) copyFiltered(source, join(to, name));
    else cpSync(source, join(to, name));
  }
}

function files(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, base) : [relative(base, path)];
  });
}

function build(into) {
  const scratch = mkdtempSync(join(tmpdir(), "super-agent-vendor-"));
  try {
    execFileSync("npm", ["install", "--prefix", scratch, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `${PACKAGE}@${pinned}`], { stdio: "inherit" });
    const modules = join(scratch, "node_modules");
    const packages = [];
    for (const entry of readdirSync(modules).sort()) {
      if (entry.startsWith(".")) continue;
      const names = entry.startsWith("@") ? readdirSync(join(modules, entry)).sort().map((name) => `${entry}/${name}`) : [entry];
      for (const name of names) {
        const meta = JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8"));
        copyFiltered(join(modules, name), join(into, "node_modules", name));
        packages.push({ name, version: meta.version, license: meta.license });
      }
    }
    // The pi-tui npm package carries no LICENSE file; MIT needs the notice, so take it
    // from the release tag.
    const license = execFileSync("curl", ["-fsSL", `https://raw.githubusercontent.com/earendil-works/pi/v${pinned}/LICENSE`]);
    writeFileSync(join(into, "node_modules", PACKAGE, "LICENSE"), license);
    writeFileSync(join(into, "MANIFEST.json"), `${JSON.stringify({ pinned: `${PACKAGE}@${pinned}`, packages }, null, 2)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv.includes("--check")) {
  const fresh = mkdtempSync(join(tmpdir(), "super-agent-vendor-check-"));
  try {
    build(fresh);
    const want = files(fresh);
    const have = files(target);
    const differ = [...new Set([...want, ...have])].filter((path) => {
      const a = join(fresh, path);
      const b = join(target, path);
      return !existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b));
    });
    if (differ.length) {
      console.error(`vendor/ does not match ${PACKAGE}@${pinned}; run npm run vendor. Differs:\n  ${differ.slice(0, 20).join("\n  ")}`);
      process.exit(1);
    }
    console.log(`vendor/ matches ${PACKAGE}@${pinned}.`);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
} else {
  rmSync(target, { recursive: true, force: true });
  build(target);
  console.log(`Vendored ${PACKAGE}@${pinned} into ${relative(root, target)}.`);
}
