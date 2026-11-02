import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { InboxStore } from "../mods/super-agent/lib/store.mjs";
import { formatMessage, runThread } from "../mods/super-agent/lib/thread.mjs";

const owner = { terminal: "t1", app: "pi", pid: 101 };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function fixture({ failSend = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-thread-"));
  const store = new InboxStore(join(dir, "inbox.sqlite"));
  const request = store.createRequest({ origin: owner, title: "Deploy?", body: "Staging or production?", now: 1 });
  const sent = [];
  const core = {
    validateOriginBinding() {},
    send(_origin, text) {
      if (failSend) throw Object.assign(new Error("The originating agent changed; delivery was refused."), { code: "origin_changed" });
      sent.push(text);
    },
  };
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 80;
  let screen = "";
  output.on("data", (chunk) => { screen += chunk; });
  let hides = 0;
  const done = runThread({ store, core, id: request.id, input, output, hide: () => { hides += 1; }, pollMs: 20 });
  return {
    store, request, sent, input, output, done,
    get screen() { return screen; },
    get hides() { return hides; },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("message formatting preserves paragraphs and separates the header from the body", () => {
  const rendered = stripAnsi(formatMessage({
    author: "agent",
    body: "Context\n\n- first option\n- second option",
    kind: "message",
    delivery_status: null,
    created_at: 0,
  }, "Agent", 100));
  const lines = rendered.split("\n");
  assert.equal(lines[1], "");
  assert.deepEqual(lines.slice(2, 6), ["Context", "", "- first option", "- second option"]);
});

test("thread shows history, sends a reply, and keeps running after Esc", async () => {
  const f = fixture();
  try {
    assert.match(f.screen, /Deploy\?/);
    assert.match(f.screen, /Staging or production\?/);

    f.input.write("Staging\x1b[13;2ufor now\r");
    await tick(10);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /^\[super-agent reply request=req_.* message=msg_.*\]\nStaging\nfor now$/);
    assert.equal(f.store.request(f.request.id).status, "waiting-agent");
    assert.match(f.screen, /You/);
    assert.equal(f.hides, 1);

    f.input.write("\x1b[27u");
    await tick(10);
    assert.equal(f.hides, 2);

    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await Promise.race([f.done, tick(500).then(() => assert.fail("thread did not end on resolve"))]);
    assert.match(f.screen, /Resolved\./);
  } finally {
    f.close();
  }
});

test("drafts persist while typing and /resolve ends the thread at once", async () => {
  const f = fixture();
  try {
    f.input.write("half an answer");
    await tick(400);
    assert.equal(f.store.getDraft(f.request.id).body, "half an answer");

    f.input.write("\x15/resolve\r");
    await tick(10);
    assert.match(f.sent[0], /^\[super-agent resolved request=/);
    assert.equal(f.store.request(f.request.id).status, "resolved");
    await Promise.race([f.done, tick(500).then(() => assert.fail("thread did not end on /resolve"))]);
    assert.match(f.screen, /You resolved this request\./);
    assert.equal(f.store.getDraft(f.request.id).body, "");
  } finally {
    f.close();
  }
});

test("a failed delivery restores the text and reports why", async () => {
  const f = fixture({ failSend: true });
  try {
    f.input.write("Production\r");
    await tick(10);
    assert.match(f.screen, /Not delivered/);
    assert.match(f.screen, /delivery was refused/);
    assert.equal(f.store.getDraft(f.request.id).body, "Production");
    assert.equal(f.hides, 0);
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await f.done;
  } finally {
    f.close();
  }
});

test("a width change clears the screen and reprints the conversation", async () => {
  const f = fixture();
  try {
    f.output.columns = 40;
    f.output.emit("resize");
    await tick(5);
    const after = f.screen.slice(f.screen.lastIndexOf("\x1b[2J\x1b[3J\x1b[H"));
    assert.match(after, /Deploy\?/);
    assert.match(after, /Staging or production\?/);
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await f.done;
  } finally {
    f.close();
  }
});
