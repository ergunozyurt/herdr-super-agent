import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.mjs") ? [resolve(path)] : [];
  });
}

const e2e = process.argv.includes("--e2e");
const result = spawnSync(process.execPath, [
  "--no-warnings=ExperimentalWarning",
  "--test",
  "--test-timeout=120000", // a hung test fails instead of stalling CI
  ...testFiles(resolve("test")),
], {
  env: { ...process.env, ...(e2e ? { SUPER_AGENT_E2E: "1" } : {}) },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
