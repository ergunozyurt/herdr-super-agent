import assert from "node:assert/strict";
import test from "node:test";
import { padWrap } from "../mods/super-agent/lib/wrap.mjs";

test("padWrap pads rows to the width instead of breaking lines", () => {
  assert.equal(padWrap("the quick brown fox", 12), "the quick   brown fox");
  // Escape sequences take no columns.
  assert.equal(padWrap("\x1b[1mab\x1b[22m cd", 4), "\x1b[1mab\x1b[22m  cd");
  // A word longer than a row is left to the terminal's wrap.
  assert.equal(padWrap("abcdefghijkl", 5), "abcdefghijkl");
});

test("padWrap measures wide characters as two cells", () => {
  // Width 8: "日本語 " is 7 cells, so the row is padded with one space.
  assert.equal(padWrap("日本語 の", 8), "日本語  の");
  assert.equal(padWrap("ok 👍 done", 8), "ok 👍   done");
});

test("padWrap leaves hyperlinks whole and copes with tiny widths", () => {
  const link = "\x1b]8;;https://x.y\x1b\\go\x1b]8;;\x1b\\";
  assert.equal(padWrap(`${link} on`, 4), `${link}  on`);
  assert.equal(padWrap("a b", 1), "a b");
});
