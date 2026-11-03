import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { InboxStore } from "../mods/super-agent/lib/store.mjs";
import { saveClipboardImage } from "../mods/super-agent/lib/clipboard.mjs";
import { attachments, formatMessage, renderMarkdown, runThread } from "../mods/super-agent/lib/thread.mjs";

const owner = { terminal: "t1", app: "pi", pid: 101 };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits for a condition instead of a fixed delay, so a slow machine (CI) cannot race the
// thread's asynchronous steps; fails rather than hanging.
async function until(condition, what, ms = 3000) {
  for (const start = Date.now(); !condition(); await tick(5)) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
  }
}
const finished = (f) => Promise.race([f.done, tick(3000).then(() => assert.fail("thread did not end"))]);
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

function fixture({ failSend = false, saveImage, platform = "darwin", withDb = true } = {}) {
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
  // Aborted on close, so a failed assertion cannot leave the thread's timers running
  // (which would keep the test process alive forever).
  const abort = new AbortController();
  const done = runThread({ store, core, id: request.id, dbPath: withDb ? dbPath : null, terminal: input, output, saveImage, platform, hide: () => { hides += 1; }, pollMs: 20, signal: abort.signal });
  return {
    store, request, sent, input, output, done, dir, dbPath,
    get screen() { return screen; },
    get hides() { return hides; },
    close() {
      abort.abort();
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
    await until(() => f.sent.length > 0, "the reply to be sent");
    await until(() => f.hides === 1, "the dialog to hide");
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], /^\[super-agent reply request=req_.* message=msg_.*\]\nStaging\nfor now$/);
    assert.equal(f.store.request(f.request.id).status, "waiting-agent");
    assert.match(f.screen, /\x1b\[48;5;236m Staging/);
    assert.equal(f.hides, 1);

    f.input.keys("\x1b");
    assert.equal(f.hides, 2);

    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await finished(f);
    assert.match(f.screen, /Resolved\./);
  } finally {
    f.close();
  }
});

test("drafts persist while typing and /resolve ends the thread at once", async () => {
  const f = fixture();
  try {
    f.input.keys("half an answer");
    await until(() => f.store.getDraft(f.request.id).body === "half an answer", "the draft to save");
    assert.equal(f.store.getDraft(f.request.id).body, "half an answer");

    f.input.keys("\x15", "/resolve", "\r");
    await until(() => f.sent.length > 0, "the reply to be sent");
    assert.match(f.sent[0], /^\[super-agent resolved request=/);
    assert.equal(f.store.request(f.request.id).status, "resolved");
    await finished(f);
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
    await until(() => /delivery was refused/.test(f.screen), "the delivery failure");
    assert.match(f.screen, /Not delivered/);
    assert.match(f.screen, /delivery was refused/);
    assert.equal(f.store.getDraft(f.request.id).body, "Production");
    assert.equal(f.hides, 0);
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await finished(f);
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
    // The hint is re-wrapped for 40 columns: its first row is padded to exactly 40.
    const hint = stripAnsi(after).split("\r\n")[1];
    assert.ok(hint.length > 40);
    assert.match(hint.slice(0, 40), /\s$/);
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await finished(f);
  } finally {
    f.close();
  }
});

test("Ctrl+V saves a clipboard image and the reply names its file", async () => {
  const f = fixture({ saveImage: async (path) => { writeFileSync(path, "png"); return true; } });
  try {
    f.input.keys("look ", "\x16");
    await until(() => f.screen.includes("[image 1]"), "the image marker");
    f.input.keys("\r");
    await until(() => f.sent.length > 0, "the reply to be sent");
    const file = join(f.dir, "attachments", f.request.id, "1.png");
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0], new RegExp(`\\nlook \\[image 1: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`));
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await finished(f);
  } finally {
    f.close();
  }
});

test("Ctrl+V with no image says so and leaves the draft alone", async () => {
  const f = fixture({ saveImage: async () => false });
  try {
    f.input.keys("draft", "\x16");
    await until(() => stripAnsi(f.screen).includes("No image on the clipboard."), "the no-image note");
    f.input.keys("\r");
    await until(() => f.sent.length > 0, "the reply to be sent");
    assert.match(f.sent[0], /\ndraft$/);
    f.store.resolveAgent({ id: f.request.id, origin: owner });
    await finished(f);
  } finally {
    f.close();
  }
});

const end = async (f) => {
  f.store.resolveAgent({ id: f.request.id, origin: owner });
  await finished(f);
};

test("a second Ctrl+V while one is saving is ignored, so numbers never repeat", async () => {
  let release;
  const f = fixture({ saveImage: (path) => new Promise((resolve) => { release = () => { writeFileSync(path, "png"); resolve(true); }; }) });
  try {
    f.input.keys("\x16", "\x16");
    release();
    await until(() => f.screen.includes("[image 1]"), "the first image marker");
    f.input.keys("\x16");
    release();
    await until(() => f.screen.includes("[image 2]"), "the second image marker");
    f.input.keys("\r");
    await until(() => f.sent.length > 0, "the reply to be sent");
    assert.match(f.sent[0], /\[image 1: .*1\.png\]\[image 2: .*2\.png\]$/);
    await end(f);
  } finally {
    f.close();
  }
});

test("Enter on a /resolve suggestion only fills it in", async () => {
  const f = fixture();
  try {
    f.input.keys("/re");
    await until(() => stripAnsi(f.screen).includes("Resolve this request"), "the /resolve suggestion");
    f.input.keys("\r");
    await until(() => stripAnsi(f.screen).includes("/resolve"), "the filled-in command");
    await tick(50);
    assert.equal(f.sent.length, 0);
    assert.notEqual(f.store.request(f.request.id).status, "resolved");
    f.input.keys("\r");
    await until(() => f.sent.length > 0, "the resolve to be sent");
    assert.match(f.sent[0], /^\[super-agent resolved request=/);
    await finished(f);
  } finally {
    f.close();
  }
});

test("Esc closes suggestions before it hides the thread", async () => {
  const f = fixture();
  try {
    f.input.keys("/");
    await until(() => stripAnsi(f.screen).includes("Resolve this request"), "the /resolve suggestion");
    f.input.keys("\x1b");
    assert.equal(f.hides, 0);
    f.input.keys("\x1b");
    assert.equal(f.hides, 1);
    await end(f);
  } finally {
    f.close();
  }
});

test("Ctrl+C clears the reply", async () => {
  const f = fixture();
  try {
    f.input.keys("oops", "\x03", "fine", "\r");
    await until(() => f.sent.length > 0, "the reply to be sent");
    assert.match(f.sent[0], /\nfine$/);
    await end(f);
  } finally {
    f.close();
  }
});

test("a failed send keeps the [image N] marker, not the expanded path", async () => {
  const f = fixture({ failSend: true, saveImage: async (path) => { writeFileSync(path, "png"); return true; } });
  try {
    f.input.keys("see ", "\x16");
    await until(() => f.screen.includes("[image 1]"), "the image marker");
    f.input.keys("\r");
    await until(() => /delivery was refused/.test(f.screen), "the delivery failure");
    assert.equal(f.store.getDraft(f.request.id).body, "see [image 1]");
    await end(f);
  } finally {
    f.close();
  }
});

test("Ctrl+V reports clipboard errors and unavailable paste", async () => {
  const failing = fixture({ saveImage: async () => { throw new Error("Image paste is only available on macOS for now."); } });
  try {
    failing.input.keys("\x16");
    await until(() => stripAnsi(failing.screen).includes("only available on macOS"), "the clipboard error");
    assert.match(stripAnsi(failing.screen), /only available on macOS/);
    await end(failing);
  } finally {
    failing.close();
  }
  const noStore = fixture({ withDb: false });
  try {
    noStore.input.keys("\x16");
    await until(() => stripAnsi(noStore.screen).includes("isn't available here"), "the unavailable note");
    assert.match(stripAnsi(noStore.screen), /Image paste isn't available here\./);
    await end(noStore);
  } finally {
    noStore.close();
  }
  await assert.rejects(saveClipboardImage("/tmp/x.png", { platform: "linux" }), /only available on macOS/);
});

test("the Ctrl+V hint shows only where image paste works", async () => {
  const f = fixture({ platform: "linux" });
  try {
    assert.doesNotMatch(stripAnsi(f.screen), /Ctrl\+V/);
    await end(f);
  } finally {
    f.close();
  }
});

test("a failed draft save stays on screen until a save succeeds", async () => {
  const f = fixture();
  const setDraft = f.store.setDraft.bind(f.store);
  try {
    f.store.setDraft = () => { throw new Error("database is locked"); };
    f.input.keys("x");
    await until(() => stripAnsi(f.screen).includes("Draft not saved"), "the draft error");
    assert.match(stripAnsi(f.screen), /Draft not saved: database is locked/);
    const before = f.screen.length;
    f.input.keys("y");
    await tick(5);
    assert.match(stripAnsi(f.screen.slice(before)), /Draft not saved/);
    f.store.setDraft = setDraft;
    await until(() => f.store.getDraft(f.request.id).body === "xy", "the draft to save");
    await end(f);
  } finally {
    f.close();
  }
});

test("a fully typed /resolve + Enter resolves even with its suggestion showing", async () => {
  const f = fixture();
  try {
    f.input.keys("/resolve");
    await until(() => stripAnsi(f.screen).includes("Resolve this request"), "the /resolve suggestion");
    f.input.keys("\r");
    await finished(f);
    assert.equal(f.store.request(f.request.id).status, "resolved");
  } finally {
    f.close();
  }
});
