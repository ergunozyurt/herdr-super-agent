// Delivers one human message to the request's origin agent: reserve, send, finalize.

export function publicError(error) {
  return { code: error.code ?? "error", message: error.message ?? String(error) };
}

function envelope(id, kind, messageId, body) {
  if (kind === "message") return `[super-agent reply request=${id} message=${messageId}]\n${body}`;
  return [
    `[super-agent resolved request=${id} message=${messageId}]`,
    "The user marked this request resolved. Nothing more is needed.",
    `If you still need their input, reopen it with: herdr-super-agent append ${id} --body "..."`,
  ].join("\n");
}

/**
 * kind "message" sends `body`; kind "resolve" resolves the request once the agent is told
 * (the agent can reopen it by appending).
 * Returns { request, message, delivery, error }; delivery is "submitted", "failed" or "unknown".
 * Throws ConflictError when the request changed or another delivery is pending.
 */
export function deliverHuman({ store, core, id, kind, body = "", expectedRevision, draftRevision = null }) {
  const request = store.requireRequest(id);
  const origin = { terminal: request.origin_terminal, app: request.origin_app, pid: request.origin_pid };
  // Do not create a human message when there is no recipient. The send validates
  // again after reservation to keep the existing exit/replacement race fenced.
  core.validateOriginBinding(origin);
  const pending = store.beginHumanDelivery({ id, kind, body, expectedRevision, draftRevision });
  let delivery = "submitted";
  let error = null;
  try {
    core.send(origin, envelope(id, kind, pending.message.id, body));
  } catch (caught) {
    delivery = caught.code === "timeout" ? "unknown" : "failed";
    error = publicError(caught);
  }
  const result = store.finishHumanDelivery({ messageId: pending.message.id, status: delivery });
  return { request: result.request, message: result.message, delivery, error };
}
