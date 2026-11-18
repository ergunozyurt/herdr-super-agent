# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Super Agent's layout follows Herdr. Each time Herdr starts, a `super-agent-<layout>` clone whose source layout Herdr changed is rebuilt from it, if you have not edited the clone; a toast says so. An edited clone is left alone, and `herdr-super-agent follow-herdr --refresh-layout` rebuilds it, keeping the old file. Rerunning setup catches it up too.
- A toast says when Herdr ships a newer Agents sidebar than the one Super Agent's follows.

### Changed

- Herdr app 0.1.16 or newer is now required.
- Super Agent's Agents sidebar now follows Herdr 0.1.16's (was 0.1.11): pins are shared through terminal labels, a kept sub-agent is listed once under its parent, a title keeps its leading bracket, agents sharing a tab show their own titles, a tab Herdr named follows its agent's session title, clicking a listed sub-agent focuses it, and a viewed done agent leaves Done at once.

## [0.2.2] - 2026-11-16

### Fixed

- Enabling Super Agent works with Herdr Core 0.1.21, which holds a message while you have unsent text in the agent's prompt. The enable and disable dialogs close at once and finish in the background; the agent's menu shows the change in progress, and a toast names the agent if it fails. Previously enabling failed with "Herdr Core did not answer before the timeout."
- An agent that switches between idle and working while Herdr Core holds a message no longer refuses it ("… is working, not idle"): Super Agent checks the agent again and retries.
- A new agent started in the terminal of an enabled one no longer shows the `S` badge, so Disable no longer says it is already disabled.
- Replies held by Herdr Core are no longer marked undelivered while still being sent, and a send that times out says the message may still arrive instead of asking you to try again.

## [0.2.1] - 2026-11-03

### Changed

- Agents now load the Super Agent policy before ending a turn that leaves something for the person to answer, not only before an explicit question, so offers like "Want me to also…?" at the end of a summary go through Super Agent too.

## [0.2.0] - 2026-11-03

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
