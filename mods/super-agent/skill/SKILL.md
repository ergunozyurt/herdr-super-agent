---
name: super-agent
description: Required communication policy for a Super Agent-enabled session. Load before asking the user any question, requesting a decision, approval, confirmation, or sign-off, and when handling a [super-agent ...] message.
---

# Super Agent communication policy

When this session is enabled, Super Agent is the channel for every question directed to the user.

1. **Open the request first.** Before writing a user-directed question anywhere else, run `herdr-super-agent ask`. This includes side questions, carry-over items, approvals, confirmations, decisions, and sign-offs.
2. **Keep one decision in one request.** Save the returned request ID. Use `append` for substantive follow-ups and `resolve` when no user input remains.
3. **Keep channel mechanics silent.** Do not announce that you opened, moved, copied, mirrored, or posted something to Super Agent. Do not duplicate request messages in the terminal.
4. **Act on replies.** When `[super-agent reply ...]` arrives, use the answer. Do not append a thank-you or echo merely to acknowledge it. Append only when the user needs substantive new information or you need more input; otherwise resolve.
5. **Write for scanning.** Use short paragraphs, blank lines between sections, and bullets for options or steps. End with one direct question. Avoid dense walls of text.
6. **Fail visibly, not by falling back.** If a Super Agent command fails, report the failure in the terminal. Do not ask the question there instead.

If the activation message asks you to register, run `herdr-super-agent register` once before opening requests.
