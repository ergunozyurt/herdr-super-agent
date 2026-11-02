// Terminal input → key events.
// Handles legacy bytes, CSI/SS3 sequences, Kitty CSI-u (disambiguate mode) and bracketed paste.

const CSI_LETTER = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const CSI_TILDE = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };
const KITTY_CODE = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace" };

function modifiers(encoded) {
  const bits = Math.max(0, Number(encoded || 1) - 1);
  return { shift: Boolean(bits & 1), alt: Boolean(bits & 2), ctrl: Boolean(bits & 4) };
}

function key(name, extra = {}) {
  return { name, shift: false, alt: false, ctrl: false, ...extra };
}

function kitty(code, mods) {
  if (KITTY_CODE[code]) return key(KITTY_CODE[code], mods);
  if (code >= 57344 && code <= 63743) return null; // Kitty private-use keys (keypad, media): ignore.
  const char = String.fromCodePoint(code);
  if (!mods.ctrl && !mods.alt) return key("text", { text: mods.shift ? char.toUpperCase() : char });
  return key(char.toLowerCase(), mods);
}

function legacy(char) {
  const code = char.codePointAt(0);
  if (char === "\r") return key("enter");
  if (char === "\n") return key("j", { ctrl: true });
  if (char === "\t") return key("tab");
  if (code === 0x7f || code === 0x08) return key("backspace");
  if (code < 0x20) return key(String.fromCharCode(code + 96), { ctrl: true });
  return null;
}

/**
 * Parses as much of `input` as is complete.
 * Returns { events, rest }: `rest` is an incomplete tail to prepend to the next chunk.
 * A lone "\x1b" stays in `rest`; the caller turns it into Escape after a short timeout.
 */
export function parseKeys(input) {
  const events = [];
  let i = 0;
  let text = "";
  const flushText = () => {
    if (text) events.push(key("text", { text }));
    text = "";
  };

  while (i < input.length) {
    const rest = input.slice(i);

    if (rest.startsWith("\x1b[200~")) {
      const end = rest.indexOf("\x1b[201~");
      if (end === -1) break;
      flushText();
      events.push(key("paste", { text: rest.slice(6, end).replace(/\r\n?/g, "\n") }));
      i += end + 6;
      continue;
    }

    if (rest[0] === "\x1b") {
      if (rest.length === 1) break;
      if (rest[1] === "[") {
        const match = rest.match(/^\x1b\[([0-9;:]*)([A-Za-z~])/);
        if (!match) {
          if (/^\x1b\[[0-9;:]*$/.test(rest)) break; // incomplete
          i += 2; // unknown, skip the introducer
          continue;
        }
        flushText();
        const params = match[1].split(";").map((part) => part.split(":")[0]);
        const final = match[2];
        let event = null;
        if (final === "u") event = kitty(Number(params[0]), modifiers(params[1]));
        else if (final === "~") event = CSI_TILDE[params[0]] ? key(CSI_TILDE[params[0]], modifiers(params[1])) : null;
        else if (CSI_LETTER[final]) event = key(CSI_LETTER[final], modifiers(params[1]));
        else if (final === "Z") event = key("tab", { shift: true });
        if (event) events.push(event);
        i += match[0].length;
        continue;
      }
      if (rest[1] === "O") {
        if (rest.length === 2) break;
        flushText();
        const name = CSI_LETTER[rest[2]];
        if (name) events.push(key(name));
        i += 3;
        continue;
      }
      // ESC + key: Alt chord.
      flushText();
      const char = String.fromCodePoint(rest.codePointAt(1));
      const base = legacy(char);
      events.push(base ? { ...base, alt: true } : key(char.toLowerCase(), { alt: true }));
      i += 1 + char.length;
      continue;
    }

    const char = String.fromCodePoint(input.codePointAt(i));
    const control = legacy(char);
    if (control) {
      flushText();
      events.push(control);
    } else {
      text += char;
    }
    i += char.length;
  }
  flushText();
  return { events, rest: input.slice(i) };
}
