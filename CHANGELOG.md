# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The thread's reply editor is now [pi-tui](https://github.com/earendil-works/pi)'s Editor, vendored into the mod (no install step, no network): terminal editing keys, undo (Ctrl+-), yank (Ctrl+Y), wide-character widths, and `/resolve` autocomplete. ([#1](https://github.com/ergunozyurt/herdr-super-agent/issues/1))
- Thread messages wrap at word boundaries without inserting newlines, so copying a wrapped paragraph gives one line. ([#1](https://github.com/ergunozyurt/herdr-super-agent/issues/1))
- Agent messages render as markdown; your messages are shaded blocks; the per-message author and time lines are gone.
- Node 22.19 or newer is required (pi-tui's minimum).

### Added

- Ctrl+V pastes a clipboard image into a reply on macOS: it is saved under Super Agent's data folder, shown as `[image N]` in the draft, and the agent receives the file path. ([#2](https://github.com/ergunozyurt/herdr-super-agent/issues/2))

## [0.1.0] - 2026-11-02

### Added

- Per-session opt-in: enable or disable Super Agent for one main agent from its context menu; disabling tells the agent first and retires its active requests.
- `herdr-super-agent` commands for agents (`register`, `ask`, `append`, `resolve`) with session registration for Pi, Claude Code and Codex.
- Requests nested beneath their main agent in the Agents panel, coloured by state: new, waiting for you, waiting for the agent.
- One toast and Herdr's "blocked" sound per new request or follow-up, respecting Herdr's sound settings.
- A thread terminal per request, shown in a dialog over the current tab, with native scrollback, a multi-line editor with terminal-style keys and drafts saved as you type.
- Replies delivered only to the origin agent's current verified process, tagged `[super-agent reply request=… message=…]`; either side can resolve, and a follow-up reopens.
- Requests hide when the origin process disappears and are restored lazily when the same resumed session runs its next command.
- Setup helper that clones your layout with Super Agent's Agents panel, writes the launcher and optionally installs the communication skill; all data stays in a local SQLite database with no network requests.
