import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { InboxStore } from "../mods/super-agent/lib/store.mjs";
import { attachments, formatMessage, renderMarkdown, runThread } from "../mods/super-agent/lib/thread.mjs";

const owner = { terminal: "t1", app: "pi", pid: 101 };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

// pi-tui's Terminal, fed one key sequence at a time as its stdin buffer would.
function fakeTerminal() {
  return {
    start(onInput, onResize) { this.onInput = onInput; this.onResize = onResize; },
    stop() {},
    keys(...sequences) {
      for (const sequence of sequences) {
        if (sequence.startsWith("\x1b") || sequence.length === 1) this.onInput(sequence);
        else for (const char of sequence) this.onInput(char);
      }
    },
  };
}

function fixture({ failSend = false, saveImage } = {}) {
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
  const input = fakeTerminal();
  const output = new PassThrough();
  output.columns = 80;
  let screen = "";
  output.on("data", (chunk) => { screen += chunk; });
  let hides = 0;
  const dbPath = join(dir, "inbox.sqlite");
  const done = runThread({ store, core, id: request.id, dbPath, terminal: input, output, saveImage, hide: () => { hides += 1; }, pollMs: 20 });
  return {
    store, request, sent, input, output, done, dir, dbPath,
    get screen() { return screen; },
    get hides() { return hides; },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("message formatting keeps paragraphs and drops per-message headers", () => {
  const rendered = stripAnsi(formatMessage({
    author: "agent",
    body: "Context\n\n- first option\n- second option",
    kind: "message",
    delivery_status: null,
    created_at: 0,
  }, 100));
  assert.deepEqual(rendered.split("\n").slice(0, 4), ["Context", "", "- first option", "- second option"]);
});

test("your messages are shaded blocks with a blank shaded row above and below", () => {
  const rendered = formatMessage({ author: "human", body: "Staging", kind: "message", delivery_status: null, created_at: 0 }, 40);
  const rows = rendered.split("\n").slice(0, 3);
  assert.ok(rows.every((row) => row.startsWith("\x1b[48;5;236m") && row.includes("\x1b[K")));
  assert.deepEqual(rows.map(stripAnsi), [" ", " Staging", " "]);
});

test("message bodies wrap at words without newlines, so copying keeps one line", () => {
  const body = "the quick brown fox jumps over the lazy dog";
  const line = stripAnsi(formatMessage({ author: "agent", body, kind: "message", delivery_status: null, created_at: 0 }, 12)).split("\n")[0];
  assert.equal(line.replace(/ +/g, " "), body);
  assert.deepEqual(line.match(/.{1,12}/g), ["the quick   ", "brown fox   ", "jumps over  ", "the lazy    ", "dog"]);
});

test("agent markdown renders styled, without its syntax and without wrapping", () => {
  const long = "word ".repeat(40).trim();
  const rendered = renderMarkdown(`## Title\n\n**bold** and \`code\`\n\n${long}`);
  const lines = stripAnsi(rendered).split("\n");
  assert.deepEqual(lines, ["Title", "", "bold and code", "", long]);
  assert.match(rendered, /\x1b\[1mbold\x1b\[22m/);
});

test("image markers expand to their saved files when sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-images-"));
  try {
    const images = attachments(join(dir, "inbox.sqlite"), "req_1");
    assert.equal(images.next(), 1);
    writeFileSync(images.path(1), "png");
    assert.equal(images.next(), 2);
    assert.equal(images.expand("see [image 1] and [image 2]"), `see [image 1: ${images.path(1)}] and [image 2]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("thread shows history, sends a reply, and keeps running after Esc", async () => {
  const f = fixture();
  try {
    assert.match(f.screen, /Deploy\?/);
    assert.match(f.screen, /Staging or production\?/);

    f.input.keys("Staging", "\x1b[13;2u", "for now", "\r");
    await tick(10);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /^\[super-agent reply request=req_.* message=msg_.*\]\nStaging\nfor now$/);
    assert.equal(f.store.request(f.request.id).status, "waiting-agent");
    assert.match(f.screen, /\x1b\[48;5;236m Staging/);
    assert.equal(f.hides, 1);

    f.input.keys("\x1b");
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
    f.input.keys("half an answer");
    await tick(400);
    assert.equal(f.store.getDraft(f.request.id).body, "half an answer");

    f.input.keys("\x15", "/resolve", "\r");
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
    f.input.keys("Production", "\r");
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
    f.input.onResize();
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

test("Ctrl+V saves a clipboard image and the reply names its file", async () => {
  const f = fixture({ saveImage: async (path) => { writeFileSync(path, "png"); return true; } });
  try {
    f.input.keys("look ", "\x16");
    await tick(10);
    f.input.keys("\r");
    await tick(10);
    const file = join(f.dir, "attachments", f.request.id, "1.png");
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], new RegExp(`\\nlook \\[image 1: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`));
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await f.done;
  } finally {
    f.close();
  }
});

test("Ctrl+V with no image says so and leaves the draft alone", async () => {
  const f = fixture({ saveImage: async () => false });
  try {
    f.input.keys("draft", "\x16");
    await tick(10);
    assert.match(stripAnsi(f.screen), /No image on the clipboard\./);
    f.input.keys("\r");
    await tick(10);
    assert.match(f.sent[0], /\ndraft$/);
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await f.done;
  } finally {
    f.close();
  }
});
