// One request's conversation in a terminal: messages print once into native scrollback,
// and pi-tui's Editor stays pinned below them for the reply. Esc only hides the overlay
// showing this terminal; the thread ends when the agent resolves the request (or it is
// retired). /resolve (or the header's ✓) resolves it; the agent can reopen it.
//
// pi-tui (vendored in ../vendor) owns key decoding, paste and editing. Its own renderer
// is not used: it hard-wraps every line, which would break copying a paragraph. So
// messages print as logical lines, word-wrapped by padding (wrap.mjs), and the editor's
// rendered rows are redrawn below them.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as pi from "../vendor/node_modules/@earendil-works/pi-tui/dist/index.js";
import { saveClipboardImage } from "./clipboard.mjs";
import { deliverHuman } from "./delivery.mjs";
import { padWrap } from "./wrap.mjs";

const sgr = (open, close) => (text) => `\x1b[${open}m${text}\x1b[${close}m`;
const dim = sgr(2, 22);
const bold = sgr(1, 22);
const cyan = sgr(36, 39);
const red = sgr(31, 39);
const crlf = (text) => text.replace(/\r?\n/g, "\r\n");

const DRAFT_DELAY = 300;
const POLL = 2000;
// The APC marker pi-tui puts at its cursor; we place the hardware cursor there instead.
const PI_MARKER = /\x1b_pi:[^\x07]*\x07/g;
const CURSOR = "\x1b_pi:c\x07";

function deliveryNote(message) {
  if (message.delivery_status === "failed") return red("Not delivered. The agent may have exited, changed, or be blocked.");
  if (message.delivery_status === "unknown") return red("Delivery timed out; it may not have arrived and was not retried.");
  return null;
}

// Standard ANSI colours, so the person's Herdr theme decides the actual shades.
const MARKDOWN_THEME = {
  heading: sgr("1;36", "22;39"),
  link: sgr(4, 24),
  linkUrl: dim,
  code: cyan,
  codeBlock: (text) => text,
  codeBlockBorder: dim,
  quote: sgr(3, 23),
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: sgr(3, 23),
  strikethrough: sgr(9, 29),
  underline: sgr(4, 24),
};
// Wide enough that pi-tui never wraps a paragraph; padWrap wraps it instead. pi-tui pads
// every row to that width, so the padding is trimmed.
const UNWRAPPED = 10000;

/** Renders an agent's markdown as styled logical lines. Throws if pi-tui cannot. */
export function renderMarkdown(body) {
  return new pi.Markdown(body, 0, 0, MARKDOWN_THEME).render(UNWRAPPED)
    .map((line) => line.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1"))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// Your messages sit on a shaded block, the agent's render as markdown; no per-message header.
const SHADE = "\x1b[48;5;236m";
const UNSHADE = "\x1b[49m";

// One shaded row per logical line, filled to the edge with erase-in-line. A row the text
// fills exactly is skipped: erasing there (pending wrap) would remove its last character.
function shaded(text, width) {
  return text.split("\n").map((line) => {
    const row = padWrap(` ${line}`, width);
    const used = pi.visibleWidth(row);
    return `${SHADE}${row}${used % width ? "\x1b[K" : ""}${UNSHADE}`;
  });
}

// Bodies print as logical lines, word-wrapped by padding rather than newlines, so copying
// a wrapped paragraph from the thread gives back one line. If markdown cannot render, the
// plain text is shown and `onError` hears why.
export function formatMessage(message, width = 100, onError = () => {}) {
  const lines = [];
  if (message.body) {
    if (message.author === "human") lines.push(...shaded(`\n${message.body}\n`, width));
    else {
      let text = message.body;
      try {
        text = renderMarkdown(message.body);
      } catch (error) {
        onError(error);
      }
      lines.push(...text.split("\n").map((line) => padWrap(line, width)));
    }
  }
  if (message.kind === "resolve") lines.push(dim("You resolved this request."));
  const note = deliveryNote(message);
  if (note) lines.push(note);
  return `${lines.join("\n")}\n\n`;
}

// Pasted images live beside the store, one folder per request, numbered in paste order:
// the draft keeps "[image N]" and the sent reply names the file, which agents can open.
const IMAGE_MARKER = /\[image (\d+)\]/g;

export function attachments(dbPath, id) {
  if (!dbPath) return null;
  const dir = join(dirname(dbPath), "attachments", id);
  const path = (n) => join(dir, `${n}.png`);
  return {
    path,
    next() {
      mkdirSync(dir, { recursive: true });
      const taken = readdirSync(dir).map((name) => Number.parseInt(name, 10)).filter(Number.isInteger);
      return Math.max(0, ...taken) + 1;
    },
    expand(text) {
      return text.replace(IMAGE_MARKER, (marker, n) => existsSync(path(n)) ? `[image ${n}: ${path(n)}]` : marker);
    },
  };
}

// Only /resolve is a command; pi-tui's file completion is not wanted here.
const COMMANDS = [{ value: "resolve", label: "/resolve", description: "Resolve this request" }];
const slashCommands = {
  triggerCharacters: ["/"],
  async getSuggestions(lines, cursorLine, cursorCol) {
    const before = lines[cursorLine].slice(0, cursorCol);
    if (cursorLine !== 0 || !/^\/\w*$/.test(before)) return null;
    const items = COMMANDS.filter((item) => item.value.startsWith(before.slice(1)));
    return items.length ? { items, prefix: before } : null;
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const line = lines[cursorLine];
    const start = cursorCol - prefix.length;
    const next = [...lines];
    next[cursorLine] = `${line.slice(0, start)}/${item.value}${line.slice(cursorCol)}`;
    return { lines: next, cursorLine, cursorCol: start + item.value.length + 1 };
  },
};

/**
 * Runs the thread UI until the request is resolved or gone. Resolves when it has
 * restored the terminal; the caller then closes the store. `terminal` (pi-tui's
 * Terminal: start/stop) and `saveImage` are injectable for tests.
 */
export function runThread({
  store,
  core,
  id,
  dbPath,
  mod = "super-agent",
  output = process.stdout,
  terminal = null,
  saveImage = saveClipboardImage,
  hide = null,
  platform = process.platform,
  pollMs = POLL,
  agentName = null,
}) {
  const ownsTerminal = !terminal;
  hide ??= defaultHide(mod, id, (error) => {
    status = red(`Couldn't hide the thread: ${error.message}`);
    render();
  });
  terminal ??= new pi.ProcessTerminal();
  // The Editor only needs the terminal height and a way to ask for a repaint.
  const host = { terminal: { get rows() { return output.rows || 24; } }, requestRender: () => render() };
  const editor = new pi.Editor(host, {
    borderColor: dim,
    selectList: { selectedPrefix: cyan, selectedText: cyan, description: dim, scrollInfo: dim, noMatch: dim },
  });
  editor.focused = true;
  editor.setAutocompleteProvider(slashCommands);
  const images = attachments(dbPath, id);
  const printed = new Set();
  // Everything above the editor, so a width change can reprint it: the terminal reflows
  // rows on resize (a hidden thread is resized when first shown), which leaves the old
  // editor region impossible to erase in place and the padding in the wrong places.
  const shown = [];
  let header = "";
  let lastWidth = 0;
  let request = null;
  let status = "";
  let cursorInRegion = 0;
  let drawn = false;
  let draftTimer = null;
  let savedDraft = "";
  let finished = false;
  let restoring = false;
  let pasting = false;
  let draftFailed = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });

  const width = () => output.columns || 100;
  const write = (text) => output.write(`\x1b[?2026h${text}\x1b[?2026l`);
  const value = () => editor.getExpandedText();

  function eraseRegion() {
    if (!drawn) return "";
    drawn = false;
    return `${cursorInRegion ? `\x1b[${cursorInRegion}A` : ""}\r\x1b[J`;
  }

  function regionText() {
    if (finished) return "";
    const w = width();
    const rendered = editor.render(Math.max(2, w - 1));
    const lines = status ? [rendered[0], status.slice(0, w - 1), ...rendered.slice(1)] : rendered;
    let row = lines.findIndex((line) => line.includes(CURSOR));
    let col = 0;
    if (row === -1) row = lines.length - 1;
    else col = pi.visibleWidth(lines[row].slice(0, lines[row].indexOf(CURSOR)).replace(PI_MARKER, ""));
    const clean = lines.map((line) => line.replace(PI_MARKER, ""));
    const up = clean.length - 1 - row;
    cursorInRegion = row;
    drawn = true;
    return `${clean.join("\r\n")}${up ? `\x1b[${up}A` : ""}\x1b[${col + 1}G`;
  }

  const render = () => { if (!finished) write(eraseRegion() + regionText()); };
  const print = (text) => write(eraseRegion() + crlf(text) + regionText());
  const markdownFailed = (error) => { status = red(`Markdown not rendered: ${error.message}`); };
  const transcript = () => crlf(header + shown.map((message) => formatMessage(message, width(), markdownFailed)).join(""));

  function resized() {
    if (finished) return;
    if (width() === lastWidth) return render();
    lastWidth = width();
    drawn = false;
    header = heading();
    editor.invalidate();
    write(`\x1b[2J\x1b[3J\x1b[H${transcript()}${regionText()}`);
  }

  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    const body = value();
    if (body === savedDraft || !request || request.status === "resolved") return;
    try {
      store.setDraft({ id, body });
      savedDraft = body;
      if (draftFailed) status = "";
      draftFailed = false;
    } catch (error) {
      // Kept on screen until a save succeeds, so the person knows the draft is at risk.
      draftFailed = true;
      status = red(`Draft not saved: ${error.message}`);
    }
    render();
  }

  function stop(reason) {
    if (finished) return;
    saveDraft();
    finished = true;
    clearTimeout(draftTimer);
    clearInterval(poller);
    watcher?.close();
    write(eraseRegion() + (reason ? crlf(`${dim(reason)}\n`) : ""));
    terminal.stop();
    output.write("\x1b[?25h");
    if (ownsTerminal) process.stdin.pause();
    finish();
  }

  function refresh() {
    if (finished) return;
    let thread;
    try {
      thread = store.thread(id);
    } catch (error) {
      status = red(error.message);
      return render();
    }
    if (!thread) return stop("This request no longer exists.");
    request = thread;
    const fresh = thread.messages.filter((message) => !printed.has(message.id));
    for (const message of fresh) {
      printed.add(message.id);
      shown.push(message);
    }
    if (fresh.length) print(fresh.map((message) => formatMessage(message, width(), markdownFailed)).join(""));
    if (thread.status === "resolved") stop("Resolved.");
  }

  // pi-tui's Editor has already cleared itself (and its undo stack) when this runs.
  function send(submitted) {
    const text = submitted.replace(/\s+$/, "");
    if (!text.trim() || !request) return;
    const suggestResolve = text.trim() === "/resolve";
    let draft;
    try {
      // "/resolve" is a command, not a draft: clear it rather than keep it as one.
      draft = store.setDraft({ id, body: suggestResolve ? "" : text });
      savedDraft = suggestResolve ? "" : text;
    } catch (error) {
      restore(text);
      status = red(error.message);
      return render();
    }
    status = dim("Sending…");
    render();
    // Let the frame reach the terminal before the synchronous send blocks.
    setImmediate(() => {
      let result = null;
      let failure = "";
      try {
        result = deliverHuman({
          store,
          core,
          id,
          kind: suggestResolve ? "resolve" : "message",
          body: suggestResolve ? "" : images ? images.expand(text) : text,
          expectedRevision: store.requireRequest(id).revision,
          draftRevision: suggestResolve ? null : draft.revision,
        });
        failure = result.delivery === "submitted" ? "" : result.error?.message ?? "Not delivered.";
      } catch (error) {
        failure = error.message;
      }
      if (failure && value() === "" && !suggestResolve) restore(text);
      status = failure ? red(failure) : "";
      savedDraft = result?.delivery === "submitted" ? "" : value();
      refresh();
      render();
      if (result?.delivery === "submitted" && !suggestResolve) hide();
    });
  }

  function restore(text) {
    restoring = true;
    editor.setText(text);
    restoring = false;
  }

  // One paste at a time: the number is chosen before the clipboard is read.
  async function pasteImage() {
    if (pasting) return;
    if (!images) {
      status = red("Image paste isn't available here.");
      return render();
    }
    pasting = true;
    try {
      const n = images.next();
      if (await saveImage(images.path(n), { platform })) {
        editor.insertTextAtCursor(`[image ${n}]`);
        status = "";
      } else {
        status = dim("No image on the clipboard.");
      }
    } catch (error) {
      status = red(error.message);
    } finally {
      pasting = false;
    }
    render();
  }

  function onInput(data) {
    if (finished || pi.isKeyRelease(data)) return;
    // With suggestions open, Esc closes them and Enter only accepts one (as Tab does), so
    // "/re" + Enter fills in "/resolve" rather than resolving at once.
    const suggesting = editor.capturesViewportInput;
    if (pi.matchesKey(data, "escape") && !suggesting) {
      saveDraft();
      hide();
      return;
    }
    if (pi.matchesKey(data, "enter") && suggesting) data = "\t";
    if (pi.matchesKey(data, "ctrl+v")) {
      pasteImage();
      return;
    }
    if (pi.matchesKey(data, "ctrl+c")) {
      restore("");
      render();
      return;
    }
    editor.handleInput(data);
    render();
  }

  editor.onSubmit = send;
  editor.onChange = () => {
    if (!restoring && !draftFailed) status = "";
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, DRAFT_DELAY);
  };

  // Header, history, and the saved draft.
  const first = store.thread(id);
  if (!first) {
    output.write("This request no longer exists.\r\n");
    return Promise.resolve();
  }
  const agent = agentName || first.origin_app;
  const hint = ["From " + agent, "Esc hides this", ...(platform === "darwin" ? ["Ctrl+V pastes an image"] : []), "/resolve resolves it"].join(" · ");
  const heading = () => `${padWrap(bold(first.title), width())}\n${padWrap(dim(hint), width())}\n\n`;
  header = heading();
  lastWidth = width();
  output.write(crlf(header));
  editor.setText(first.draft?.body ?? "");
  savedDraft = value();

  terminal.start(onInput, resized);

  let watcher = null;
  if (dbPath) {
    try {
      const signal = basename(`${dbPath}.revision`);
      watcher = watch(dirname(dbPath), (_event, name) => { if (name === signal) refresh(); });
    } catch (error) {
      // Polling still picks up new messages, only more slowly.
      status = dim(`Watching for changes failed (${error.message}); checking every ${pollMs / 1000}s.`);
    }
  }
  const poller = setInterval(refresh, pollMs);
  refresh();
  render();

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.once(signal, () => stop());
  return done;
}

function defaultHide(mod, id, onError) {
  return () => {
    spawn("herdr-app", ["do", `${mod}.hide-${id}`], { stdio: "ignore", detached: true })
      .on("error", onError)
      .unref();
  };
}
