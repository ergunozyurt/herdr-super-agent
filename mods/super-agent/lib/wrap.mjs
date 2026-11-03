// Word wrap for text printed into the terminal.

import { visibleWidth } from "../vendor/node_modules/@earendil-works/pi-tui/dist/index.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Escape sequences take no columns: CSI (colours) and OSC (hyperlinks).
const ESCAPE = /^(?:\x1b\[[0-9;:?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

/**
 * Word-wraps one logical line for the terminal without inserting newlines: a row that
 * breaks at a space is padded with spaces to exactly `width`, so the terminal's own soft
 * wrap moves the next word down. Copying then joins the rows (a break copies as a run of
 * spaces), where a newline would split the paragraph. A word longer than a row is left
 * to the terminal's wrap. Rows hold `width - 1` columns of text, so every break keeps at
 * least one space. Columns are terminal cells: wide characters (CJK, emoji) count two.
 */
export function padWrap(line, width) {
  const limit = Math.max(1, width - 1);
  const out = [];
  let row = [];
  let used = 0;
  let lastSpace = -1;
  const cols = (items) => items.reduce((sum, item) => sum + item.cols, 0);
  const flush = (pad) => {
    out.push(...row.map((item) => item.text), pad ? " ".repeat(Math.max(0, width - used)) : "");
    row = [];
    used = 0;
    lastSpace = -1;
  };
  // Split into escape sequences (no columns) and graphemes (their cell width).
  const parts = [];
  for (let i = 0; i < line.length;) {
    const escape = line.slice(i).match(ESCAPE);
    if (escape) {
      parts.push({ text: escape[0], cols: 0 });
      i += escape[0].length;
      continue;
    }
    let end = line.indexOf("\x1b", i + 1);
    if (end === -1) end = line.length;
    for (const { segment } of graphemes.segment(line.slice(i, end))) parts.push({ text: segment, cols: visibleWidth(segment) });
    i = end;
  }
  for (const part of parts) {
    const { text } = part;
    if (part.cols && used + part.cols > limit) {
      if (text === " ") {
        // The break itself: keep the space on this row, then pad.
        row.push(part);
        used += 1;
        flush(true);
        continue;
      }
      if (lastSpace >= 0) {
        // Move the word after the row's last space down with this character.
        const carry = row.splice(lastSpace + 1);
        used -= cols(carry);
        flush(true);
        row = carry;
        used = cols(carry);
      } else if (used + part.cols > width) {
        // A word longer than a row: the terminal wraps it here by itself.
        flush(false);
      }
    }
    row.push(part);
    used += part.cols;
    if (text === " ") lastSpace = row.length - 1;
  }
  out.push(...row.map((item) => item.text));
  return out.join("");
}
