# Super Agent

A threaded human-in-the-loop inbox for [Herdr](https://herdr.dev). Main agents open **requests** instead of asking in a busy terminal; the person reads and answers each one in its own thread, where child-agent reports cannot interrupt them, and the answer is delivered back to the agent's conversation with its ID.

```text
Agents
  herdr-super-agent                    ◌
  ├ ● Choose deployment target            ← a request (new)
  ├ ○ Confirm schema migration            ← waiting for your reply
  └ ⚙ reviewer                            ← a child terminal
```

## What it does

- Lets the person explicitly enable or disable Super Agent for one main agent session from that agent's context menu; other agents remain unchanged. Disabling tells the agent first, retires active requests, and rejects later Super Agent commands until re-enabled.
- Nests requests beneath the main agent that opened them, beside its child terminals, coloured by state: new, waiting for you, waiting for the agent.
- Raises one toast and Herdr's "blocked" sound for each new request or follow-up, respecting Herdr's sound settings.
- Opens each request's thread in its own terminal, shown in a dialog over the current tab: native scrollback, a multi-line editor with terminal-style keys, drafts saved as you type. Esc hides it; a successful reply hides the dialog automatically, while **keep** leaves it visible as a tab. The thread stays until the request is resolved.
- Lets either side resolve. The agent is told when you resolve and can reopen the request by following up.
- Hides requests and ends their thread terminals when the origin process disappears, while preserving messages and drafts; the same resumed enabled session restores them lazily on its next Super Agent command.
- Delivers replies only to the origin agent's current verified process, never forcing input into a blocked agent or a bare shell.
- Keeps everything in a local SQLite database; makes no network requests.

## Requirements

- Herdr app and herdr-core
- Node.js 22.13 or newer (for `node:sqlite`)
- Local agents (remote machines are not supported yet)

## Install

```bash
cp -R mods/super-agent ~/.config/herdr-app/mods/super-agent
node --no-warnings=ExperimentalWarning ~/.config/herdr-app/mods/super-agent/setup.mjs --install-skill
```

Setup clones your shown layout, swaps in Super Agent's Agents panel and switches to the clone, leaving the original untouched. Rerunning setup from that installed layout refreshes the launcher and skills without creating another clone. It writes the `~/.local/bin/herdr-super-agent` launcher and, with `--install-skill`, the same Super Agent communication skill for Pi, Claude Code, and Codex.

## For agents

After the person enables Super Agent for the session, run the registration command from the agent's own tool environment:

```bash
herdr-super-agent register
herdr-super-agent ask --title "Choose deployment target" --body "Staging or production?"
herdr-super-agent append <request> --body "One more consideration…"
herdr-super-agent resolve <request>
```

Only enabled top-level agents can open requests. Session registration uses `PI_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, or Codex's root `CODEX_SESSION_ID`; Codex also requires `CODEX_THREAD_ID` to match so internal descendants cannot contact the user. A recognized provider process without its metadata is rejected. Agent apps without a session integration retain the legacy process-bound behavior for compatibility. Replies arrive as `[super-agent reply request=… message=…]` followed by the text.

## Local effects and security

Super Agent runs Node and Herdr's `hc` command, stores its SQLite database under the Herdr app home, writes the `~/.local/bin/herdr-super-agent` launcher, and optionally installs its communication skill for Pi, Claude Code, and Codex. It does not make network requests. Provider session IDs correlate resumed sessions; delivery is still fenced by terminal, app, foreground PID, and agent status.

## Repository layout

- `mods/super-agent/` — the complete catalog mod and setup helper
- `test/` — fast protocol/editor/store tests and isolated Herdr terminal tests
- `RECIPE.md` — the Herdr Mods catalog build brief
- `mods/super-agent/NOTICE` — attribution for the Agents view derivative

## Development

```bash
npm run check
npm run test:e2e
herdr-app check ~/.config/herdr-app/mods/super-agent
```

The Agents view is derived from Herdr's Apache-2.0 shipped `agents` mod; retain `LICENSE` and `mods/super-agent/NOTICE` in redistributed copies.
