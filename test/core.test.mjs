import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CoreClient, SEND_TIMEOUT } from "../mods/super-agent/lib/core.mjs";

test("a send outlasts Herdr Core's wait for the person's unsent draft", () => {
  // Core holds a send for up to 60 s after the person's last key in the agent's prompt.
  assert.ok(SEND_TIMEOUT > 60_000);
});

test("a send Herdr Core holds past the limit names the unsent text", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-core-"));
  try {
    const fakeHc = join(dir, "hc.mjs");
    writeFileSync(fakeHc, `#!/usr/bin/env node
if (process.argv[2] === "get") {
  process.stdout.write(JSON.stringify({ address: "t1", state: "live", status: { app: "pi", state: "idle" }, foreground: { pid: 7 } }));
  process.exit(0);
}
setTimeout(() => process.exit(0), 5000);
`);
    chmodSync(fakeHc, 0o755);
    const core = new CoreClient({ executable: fakeHc });
    assert.throws(
      () => core.send({ terminal: "t1", app: "pi", pid: 7 }, "hello", { timeout: 300 }),
      (error) => error.code === "timeout" && /unsent text/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
