// One request's conversation in a terminal: messages print once into native scrollback,
// and the reply editor stays pinned below them. Esc only hides the overlay showing this
// terminal; the thread ends when the agent resolves the request (or it is retired).
// /resolve (or the header's ✓) resolves it; the agent can reopen it by following up.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { deliverHuman } from "./delivery.mjs";
import { Editor, layout, wrapText } from "./editor.mjs";
import { parseKeys } from "./keys.mjs";

const dim = (text) => `\x1b[2m${text}\x1b[22m`;
const bold = (text) => `\x1b[1m${text}\x1b[22m`;
const cyan = (text) => `\x1b[36m${text}\x1b[39m`;
const red = (text) => `\x1b[31m${text}\x1b[39m`;
const crlf = (text) => text.replace(/\r?\n/g, "\r\n");

const DRAFT_DELAY = 300;
const POLL = 2000;

function time(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function deliveryNote(message) {
  if (message.delivery_status === "failed") return red("Not delivered. The agent may have exited, changed, or be blocked.");
  if (message.delivery_status === "unknown") return red("Delivery timed out; it may not have arrived and was not retried.");
  return null;
}

export function formatMessage(message, agentName, width = 100) {
  const human = message.author === "human";
  const head = `${human ? cyan("You") : bold(agentName)} ${dim(time(message.created_at))}`;
  const lines = [head];
  if (message.body) lines.push("", wrapText(message.body, width - 1));
  if (message.kind === "resolve") lines.push(dim("You resolved this request."));
  const note = deliveryNote(message);
  if (note) lines.push(note);
  return `${lines.join("\n")}\n\n`;
}

/**
 * Runs the thread UI until the request is resolved or gone. Resolves when it has
 * restored the terminal; the caller then closes the store.
 */
export function runThread({
  store,
  core,
  id,
  dbPath,
  mod = "super-agent",
  input = process.stdin,
  output = process.stdout,
  hide = defaultHide(mod, id),
  pollMs = POLL,
  agentName = null,
}) {
  const editor = new Editor();
  const printed = new Set();
  // Everything above the editor, so a width change can reprint it: the terminal reflows
  // wrapped rows on resize (a hidden thread is resized when first shown), which leaves
  // the old editor region impossible to erase in place.
  const shown = [];
  let header = "";
  let lastWidth = 0;
  let request = null;
  let status = "";
  let cursorInRegion = 0;
  let drawn = false;
  let draftTimer = null;
  let savedDraft = "";
  let pending = "";
  let escapeTimer = null;
  let finished = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });

  const width = () => output.columns || 100;
  const write = (text) => output.write(`\x1b[?2026h${text}\x1b[?2026l`);

  function eraseRegion() {
    if (!drawn) return "";
    drawn = false;
    return `${cursorInRegion ? `\x1b[${cursorInRegion}A` : ""}\r\x1b[J`;
  }

  function regionText() {
    if (finished) return "";
    const w = width();
    const { rows, cursorRow, cursorCol } = layout(editor, w, { first: `${cyan("❯")} `, next: "  " });
    const top = [dim("─".repeat(Math.max(1, w - 1)))];
    if (status) top.push(status.slice(0, w - 1));
    const lines = [...top, ...rows];
    const editorRow = top.length + cursorRow;
    const up = lines.length - 1 - editorRow;
    cursorInRegion = editorRow;
    drawn = true;
    return `${lines.join("\r\n")}${up ? `\x1b[${up}A` : ""}\x1b[${cursorCol + 1}G`;
  }

  const render = () => write(eraseRegion() + regionText());

  function transcript() {
    return crlf(header + shown.map((message) => formatMessage(message, agent, width())).join(""));
  }

  function resized() {
    if (finished) return;
    if (width() === lastWidth) return render();
    lastWidth = width();
    drawn = false;
    write(`\x1b[2J\x1b[3J\x1b[H${transcript()}${regionText()}`);
  }
  const print = (text) => write(eraseRegion() + crlf(text) + regionText());

  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    const body = editor.value;
    if (body === savedDraft || !request || request.status === "resolved") return;
    try {
      store.setDraft({ id, body });
      savedDraft = body;
    } catch (error) {
      status = red(`Draft not saved: ${error.message}`);
    }
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, DRAFT_DELAY);
  }

  function stop(reason) {
    if (finished) return;
    saveDraft();
    finished = true;
    clearTimeout(draftTimer);
    clearTimeout(escapeTimer);
    clearInterval(poller);
    watcher?.close();
    input.off("data", feed);
    output.off?.("resize", resized);
    write(eraseRegion() + (reason ? crlf(`${dim(reason)}\n`) : ""));
    output.write("\x1b[<u\x1b[?2004l");
    input.setRawMode?.(false);
    input.pause();
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
    if (fresh.length) print(fresh.map((message) => formatMessage(message, agent, width())).join(""));
    if (thread.status === "resolved") stop("Resolved.");
  }

  function send() {
    const text = editor.value.replace(/\s+$/, "");
    if (!text.trim() || !request) return;
    const suggestResolve = text.trim() === "/resolve";
    let draft;
    try {
      // "/resolve" is a command, not a draft: clear it rather than keep it as one.
      draft = store.setDraft({ id, body: suggestResolve ? "" : editor.value });
      savedDraft = suggestResolve ? "" : editor.value;
    } catch (error) {
      status = red(error.message);
      return render();
    }
    editor.clear();
    status = dim("Sending…");
    render();
    // Let the frame reach the terminal before the synchronous send blocks.
    setImmediate(() => {
      let result = null;
      try {
        result = deliverHuman({
          store,
          core,
          id,
          kind: suggestResolve ? "resolve" : "message",
          body: suggestResolve ? "" : text,
          expectedRevision: store.requireRequest(id).revision,
          draftRevision: suggestResolve ? null : draft.revision,
        });
        status = result.delivery === "submitted" ? "" : red(result.error?.message ?? "Not delivered.");
      } catch (error) {
        status = red(error.message);
      }
      if (result?.delivery !== "submitted" && editor.value === "" && !suggestResolve) editor.setValue(text);
      savedDraft = result?.delivery === "submitted" ? "" : savedDraft;
      refresh();
      render();
      if (result?.delivery === "submitted" && !suggestResolve) hide();
    });
  }

  function feed(chunk) {
    clearTimeout(escapeTimer);
    const before = editor.value;
    const parsed = parseKeys(pending + chunk);
    pending = parsed.rest;
    for (const event of parsed.events) {
      const action = editor.handle(event);
      if (action === "submit") send();
      if (action === "hide") {
        saveDraft();
        hide();
      }
    }
    if (status && editor.value !== before) status = "";
    if (editor.value !== before) scheduleDraft();
    render();
    // A lone ESC is the Escape key when the terminal does not use Kitty mode.
    if (pending === "\x1b") {
      escapeTimer = setTimeout(() => {
        pending = "";
        saveDraft();
        hide();
      }, 40);
    }
  }

  // Header, history, and the saved draft.
  const first = store.thread(id);
  if (!first) {
    output.write("This request no longer exists.\r\n");
    return Promise.resolve();
  }
  const agent = agentName || first.origin_app;
  header = `${bold(first.title)}\n${dim(`From ${agent} · Esc hides this · /resolve resolves it`)}\n\n`;
  lastWidth = width();
  output.write(crlf(header));
  editor.setValue(first.draft?.body ?? "");
  savedDraft = editor.value;

  input.setRawMode?.(true);
  input.setEncoding?.("utf8");
  input.on("data", feed);
  input.resume();
  output.on?.("resize", resized);
  output.write("\x1b[>1u\x1b[?2004h"); // Kitty disambiguate + bracketed paste.

  let watcher = null;
  if (dbPath) {
    try {
      const signal = basename(`${dbPath}.revision`);
      watcher = watch(dirname(dbPath), (_event, name) => { if (name === signal) refresh(); });
    } catch {}
  }
  const poller = setInterval(refresh, pollMs);
  refresh();
  render();

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.once(signal, () => stop());
  return done;
}

function defaultHide(mod, id) {
  return () => {
    spawn("herdr-app", ["do", `${mod}.hide-${id}`], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  };
}
