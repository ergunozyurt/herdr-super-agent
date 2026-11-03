// Reads an image from the clipboard for Ctrl+V in a thread. Herdr hands Ctrl+V to a
// local terminal's program, which reads the clipboard itself (as Claude Code does).
// macOS only for now: osascript ships with the system and needs no permission prompt.

import { execFile } from "node:child_process";

const SCRIPT = [
  "on run argv",
  "  try",
  "    set png to (the clipboard as «class PNGf»)",
  "  on error",
  '    return "none"',
  "  end try",
  "  set f to open for access (POSIX file (item 1 of argv)) with write permission",
  "  set eof f to 0",
  "  write png to f",
  "  close access f",
  '  return "saved"',
  "end run",
];

/**
 * Saves the clipboard's image to `path` as PNG. Resolves true when saved, false when the
 * clipboard holds no image; rejects when it cannot be read on this platform.
 */
export function saveClipboardImage(path, { platform = process.platform } = {}) {
  if (platform !== "darwin") return Promise.reject(new Error("Image paste is only available on macOS for now."));
  const args = SCRIPT.flatMap((line) => ["-e", line]);
  return new Promise((resolve, reject) => {
    execFile("osascript", [...args, path], { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      resolve(stdout.trim() === "saved");
    });
  });
}
