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
