import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor, layout, wrapText } from "../mods/super-agent/lib/editor.mjs";
import { parseKeys } from "../mods/super-agent/lib/keys.mjs";

function type(editor, input) {
  const { events, rest } = parseKeys(input);
  const actions = events.map((event) => editor.handle(event)).filter(Boolean);
  return { actions, rest };
}

test("Kitty Shift+Enter inserts a newline after text in the same chunk", () => {
  const editor = new Editor();
  const { actions } = type(editor, "hello\x1b[13;2uworld");
  assert.deepEqual(actions, []);
  assert.equal(editor.value, "hello\nworld");
});

test("Kitty Escape hides; Ctrl+C never closes", () => {
  assert.deepEqual(type(new Editor(), "\x1b[27u").actions, ["hide"]);
  assert.deepEqual(type(new Editor(), "\x1b[99;5u").actions, []);
});

test("Ctrl+C clears a non-empty buffer instead of closing", () => {
  const editor = new Editor();
  assert.deepEqual(type(editor, "draft\x03").actions, []);
  assert.equal(editor.value, "");
});

test("Enter submits; lone ESC is left pending for the timeout", () => {
  assert.deepEqual(type(new Editor(), "hi\r").actions, ["submit"]);
  assert.equal(parseKeys("\x1b").rest, "\x1b");
  assert.equal(parseKeys("\x1b[1;3").rest, "\x1b[1;3");
});

test("Up/Down move across lines and keep a sensible column", () => {
  const editor = new Editor();
  type(editor, "first line\x1b[13;2ushort");
  type(editor, "\x1b[A");
  assert.equal(editor.row, 0);
  assert.equal(editor.col, 5);
  type(editor, "!");
  assert.equal(editor.value, "first! line\nshort");
});

test("Word and line editing chords", () => {
  const editor = new Editor();
  type(editor, "one two three\x17");
  assert.equal(editor.value, "one two ");
  type(editor, "\x1b[1;3D\x0b");
  assert.equal(editor.value, "one ");
  type(editor, "\x01x\x05y");
  assert.equal(editor.value, "xone y");
  type(editor, "\x15");
  assert.equal(editor.value, "");
});

test("Backspace at line start joins lines; bracketed paste keeps newlines", () => {
  const editor = new Editor();
  type(editor, "\x1b[200~a\r\nb\x1b[201~");
  assert.equal(editor.value, "a\nb");
  type(editor, "\x01\x7f");
  assert.equal(editor.value, "ab");
});

test("layout wraps long lines and places the cursor", () => {
  const editor = new Editor();
  editor.insert("abcdefgh");
  const { rows, cursorRow, cursorCol } = layout(editor, 6);
  assert.deepEqual(rows, ["❯ abcd", "  efgh", "  "]);
  assert.equal(cursorRow, 2);
  assert.equal(cursorCol, 2);
});

test("setValue loads a multi-line draft with the cursor at the end", () => {
  const editor = new Editor();
  editor.setValue("first\nsecond");
  assert.equal(editor.value, "first\nsecond");
  assert.equal(editor.row, 1);
  assert.equal(editor.col, 6);
});

test("layout wraps at word boundaries and keeps the cursor in place", () => {
  const editor = new Editor();
  editor.insert("hello brave new world");
  // width 12 → 10 columns of text after the prompt
  const { rows, cursorRow, cursorCol } = layout(editor, 12);
  assert.deepEqual(rows, ["❯ hello ", "  brave new ", "  world"]);
  assert.equal(cursorRow, 2);
  assert.equal(cursorCol, 7);
  editor.col = 6; // on the "b" of "brave"
  const moved = layout(editor, 12);
  assert.equal(moved.cursorRow, 1);
  assert.equal(moved.cursorCol, 2);
});

test("wrapText wraps words and keeps blank lines", () => {
  assert.equal(wrapText("the quick brown fox\n\njumps", 10), "the quick\nbrown fox\n\njumps");
  assert.equal(wrapText("abcdefghijkl", 5), "abcde\nfghij\nkl");
});
