import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CoreClient, SEND_TIMEOUT } from "../mods/super-agent/lib/core.mjs";
import { RECONCILE_AFTER } from "../mods/super-agent/lib/store.mjs";

const origin = { terminal: "t1", app: "pi", pid: 7 };

// A fake hc: `get` reports the state in the `state` file; `send` runs `onSend` (a script body
// with `args`, `dir` and the fs helpers in scope) after logging its arguments.
function fakeCore({ state = "idle", onSend = "process.exit(0);", getDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-core-"));
  const executable = join(dir, "hc.mjs");
  writeFileSync(join(dir, "state"), state);
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
if (args[0] === "get") {
  setTimeout(() => {
    const state = readFileSync(dir + "/state", "utf8");
    process.stdout.write(JSON.stringify({ address: "t1", state: "live", status: { app: "pi", state }, foreground: { pid: 7 } }));
    process.exit(0);
  }, ${getDelayMs});
} else {
  appendFileSync(dir + "/sends", JSON.stringify(args) + "\\n");
  ${onSend}
}
`);
  chmodSync(executable, 0o755);
  return {
    core: new CoreClient({ executable, timeout: 2_000 }),
    sends: () => existsSync(join(dir, "sends"))
      ? readFileSync(join(dir, "sends"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [],
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const mismatch = `process.stderr.write(JSON.stringify({ error: { kind: "status_mismatch", message: "t1 is working, not idle" } }));`;

test("a pending delivery is reconciled only after any send could have finished", () => {
  // Each attempt checks the terminal (`hc get`, up to 5 s) before the send's shared deadline.
  assert.ok(RECONCILE_AFTER > SEND_TIMEOUT + 4 * 5_000);
});

test("a send whose agent turned working during core's hold is retried, fenced on the new state", () => {
  const f = fakeCore({
    onSend: `if (args[2] === "idle") { writeFileSync(dir + "/state", "working"); ${mismatch} process.exit(10); } process.exit(0);`,
  });
  try {
    f.core.send(origin, "hello");
    assert.deepEqual(f.sends().map((args) => args.slice(0, 3)), [["send", "--if", "idle"], ["send", "--if", "working"]]);
  } finally {
    f.close();
  }
});

test("a send keeps refusing after repeated state changes", () => {
  const f = fakeCore({ onSend: `${mismatch} process.exit(10);` });
  try {
    assert.throws(() => f.core.send(origin, "hello"), (error) => error.code === "send_failed");
    assert.equal(f.sends().length, 3);
  } finally {
    f.close();
  }
});

test("a send core holds past the limit may still arrive", () => {
  const f = fakeCore({ onSend: "setTimeout(() => process.exit(0), 5000);" });
  try {
    assert.throws(
      () => f.core.send(origin, "hello", { timeout: 300 }),
      (error) => error.code === "timeout" && /may still arrive/.test(error.message),
    );
  } finally {
    f.close();
  }
});

test("an agent in an unknown state is refused without typing", () => {
  const f = fakeCore({ state: "starting" });
  try {
    assert.throws(() => f.core.send(origin, "hello"), (error) => error.code === "origin_unavailable");
    assert.deepEqual(f.sends(), []);
  } finally {
    f.close();
  }
});

test("a check that times out before typing is a failure, not an unknown delivery", () => {
  const f = fakeCore({ getDelayMs: 5_000 });
  try {
    assert.throws(() => f.core.send(origin, "hello"), (error) => error.code === "validate_timeout");
    assert.deepEqual(f.sends(), []);
  } finally {
    f.close();
  }
});
