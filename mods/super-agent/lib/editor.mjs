// A small multi-line buffer with emacs-style editing.
// Columns count code points; wide characters are not measured.

const WORD = /[\p{L}\p{N}_]/u;

export class Editor {
  constructor() {
    this.clear();
  }

  clear() {
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
  }

  setValue(text) {
    this.clear();
    this.insert(text);
  }

  get value() {
    return this.lines.map((line) => line.join("")).join("\n");
  }

  get line() {
    return this.lines[this.row];
  }

  insert(text) {
    const [first, ...more] = text.split("\n");
    const after = this.line.splice(this.col);
    this.line.push(...Array.from(first));
    this.col = this.line.length;
    for (const part of more) {
      this.lines.splice(this.row + 1, 0, Array.from(part));
      this.row += 1;
      this.col = this.line.length;
    }
    this.line.push(...after);
  }

  newline() {
    this.insert("\n");
  }

  backspace() {
    if (this.col > 0) {
      this.line.splice(this.col - 1, 1);
      this.col -= 1;
    } else if (this.row > 0) {
      const removed = this.lines.splice(this.row, 1)[0];
      this.row -= 1;
      this.col = this.line.length;
      this.line.push(...removed);
    }
  }

  deleteForward() {
    if (this.col < this.line.length) this.line.splice(this.col, 1);
    else if (this.row < this.lines.length - 1) this.line.push(...this.lines.splice(this.row + 1, 1)[0]);
  }

  left() {
    if (this.col > 0) this.col -= 1;
    else if (this.row > 0) {
      this.row -= 1;
      this.col = this.line.length;
    }
  }

  right() {
    if (this.col < this.line.length) this.col += 1;
    else if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = 0;
    }
  }

  // Returns false at the edge, so the caller can use Up/Down for something else.
  up() {
    if (this.row === 0) return false;
    this.row -= 1;
    this.col = Math.min(this.col, this.line.length);
    return true;
  }

  down() {
    if (this.row === this.lines.length - 1) return false;
    this.row += 1;
    this.col = Math.min(this.col, this.line.length);
    return true;
  }

  home() {
    this.col = 0;
  }

  end() {
    this.col = this.line.length;
  }

  wordStart() {
    let col = this.col;
    while (col > 0 && !WORD.test(this.line[col - 1])) col -= 1;
    while (col > 0 && WORD.test(this.line[col - 1])) col -= 1;
    return col;
  }

  wordEnd() {
    let col = this.col;
    while (col < this.line.length && !WORD.test(this.line[col])) col += 1;
    while (col < this.line.length && WORD.test(this.line[col])) col += 1;
    return col;
  }

  wordLeft() {
    if (this.col === 0) return this.left();
    this.col = this.wordStart();
  }

  wordRight() {
    if (this.col === this.line.length) return this.right();
    this.col = this.wordEnd();
  }

  deleteWordBack() {
    if (this.col === 0) return this.backspace();
    const start = this.wordStart();
    this.line.splice(start, this.col - start);
    this.col = start;
  }

  deleteWordForward() {
    if (this.col === this.line.length) return this.deleteForward();
    this.line.splice(this.col, this.wordEnd() - this.col);
  }

  killToStart() {
    if (this.col === 0) return this.backspace();
    this.line.splice(0, this.col);
    this.col = 0;
  }

  killToEnd() {
    if (this.col === this.line.length) return this.deleteForward();
    this.line.splice(this.col);
  }

  /**
   * Applies one key event. Returns "submit", "hide", or null.
   * Nothing here ends the thread: only the agent resolves it.
   * Enter submits; Shift/Alt+Enter and Ctrl+J insert a newline.
   */
  handle(event) {
    const { name, ctrl, alt, shift } = event;
    if (name === "text" || name === "paste") this.insert(event.text);
    else if (name === "enter" && (shift || alt)) this.newline();
    else if (name === "enter") return "submit";
    else if (name === "j" && ctrl) this.newline();
    else if (name === "escape") return "hide";
    else if (name === "c" && ctrl) this.clear();
    else if (name === "backspace" && (alt || ctrl)) this.deleteWordBack();
    else if (name === "backspace" || (name === "h" && ctrl)) this.backspace();
    else if (name === "delete" && (alt || ctrl)) this.deleteWordForward();
    else if (name === "delete") this.deleteForward();
    else if (name === "d" && ctrl) this.deleteForward();
    else if (name === "d" && alt) this.deleteWordForward();
    else if (name === "w" && ctrl) this.deleteWordBack();
    else if (name === "u" && ctrl) this.killToStart();
    else if (name === "k" && ctrl) this.killToEnd();
    else if ((name === "a" && ctrl) || name === "home") this.home();
    else if ((name === "e" && ctrl) || name === "end") this.end();
    else if ((name === "left" && (alt || ctrl)) || (name === "b" && alt)) this.wordLeft();
    else if ((name === "right" && (alt || ctrl)) || (name === "f" && alt)) this.wordRight();
    else if (name === "left" || (name === "b" && ctrl)) this.left();
    else if (name === "right" || (name === "f" && ctrl)) this.right();
    else if (name === "up" || (name === "p" && ctrl)) this.up();
    else if (name === "down" || (name === "n" && ctrl)) this.down();
    else if (name === "tab") this.insert("  ");
    return null;
  }
}

/**
 * Splits one line (an array of characters) into [start, end) rows of at most `width`,
 * breaking after the last space that fits; a word longer than a row is cut.
 * A line that exactly fills its last row gets an empty row after it, so a cursor at
 * the end of the line has somewhere to stand.
 */
export function wrapRanges(chars, width) {
  const ranges = [];
  let start = 0;
  while (chars.length - start > width) {
    let end = start + width;
    for (let i = end - 1; i > start; i -= 1) {
      if (chars[i] === " ") {
        end = i + 1;
        break;
      }
    }
    ranges.push([start, end]);
    start = end;
  }
  ranges.push([start, chars.length]);
  if (chars.length - start === width) ranges.push([chars.length, chars.length]);
  return ranges;
}

/** Word-wraps plain text to `width` columns. */
export function wrapText(text, width) {
  return text.split("\n").flatMap((line) => {
    const chars = Array.from(line);
    return wrapRanges(chars, Math.max(1, width))
      .filter(([start, end], index, all) => end > start || index === 0 || all.length === 1)
      .map(([start, end]) => chars.slice(start, end).join("").trimEnd());
  }).join("\n");
}

/**
 * Lays the buffer out in rows of `width` columns, including a 2-column prompt.
 * Returns { rows: string[], cursorRow, cursorCol } in that grid.
 */
export function layout(editor, width, { first = "❯ ", next = "  " } = {}) {
  const content = Math.max(1, width - 2);
  const rows = [];
  let cursorRow = 0;
  let cursorCol = 0;
  editor.lines.forEach((line, index) => {
    const ranges = wrapRanges(line, content);
    // The cursor stands in the first row it falls before the end of, else the last row.
    const at = index === editor.row
      ? Math.max(0, ranges.findIndex(([, end], r) => editor.col < end || r === ranges.length - 1))
      : -1;
    ranges.forEach(([start, end], r) => {
      if (r === at) {
        cursorRow = rows.length;
        cursorCol = 2 + editor.col - start;
      }
      const prefix = r === 0 ? (index === 0 ? first : next) : next;
      rows.push(prefix + line.slice(start, end).join(""));
    });
  });
  return { rows, cursorRow, cursorCol };
}
