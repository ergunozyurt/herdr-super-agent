const PROVIDERS = new Map([
  ["pi", { agentKind: "pi", variable: "PI_SESSION_ID" }],
  ["claude-code", { agentKind: "claude-code", variable: "CLAUDE_CODE_SESSION_ID" }],
  ["codex", {
    agentKind: "codex",
    variable: "CODEX_SESSION_ID",
    concreteVariable: "CODEX_THREAD_ID",
  }],
]);

export function supportsSessionIdentity(app) {
  return PROVIDERS.has(app);
}

export function sessionIdentity(app, env = process.env) {
  const provider = PROVIDERS.get(app);
  if (!provider) return null;
  const sessionId = env[provider.variable]?.trim();
  if (!sessionId) {
    throw Object.assign(
      new Error(`${provider.variable} is missing; run Super Agent commands from the agent's own tool environment.`),
      { code: "session_identity_missing" },
    );
  }
  if (provider.concreteVariable) {
    const concreteId = env[provider.concreteVariable]?.trim();
    if (!concreteId) {
      throw Object.assign(
        new Error(`${provider.concreteVariable} is missing; Super Agent cannot verify the Codex root session.`),
        { code: "session_identity_missing" },
      );
    }
    if (concreteId !== sessionId) {
      throw Object.assign(
        new Error("Only the Codex root session can use Super Agent; internal descendants report through it."),
        { code: "child_agent" },
      );
    }
  }
  return { agentKind: provider.agentKind, sessionId };
}

export function requireSessionIdentity(app, env = process.env) {
  const identity = sessionIdentity(app, env);
  if (identity) return identity;
  throw Object.assign(
    new Error(`Super Agent does not know how to identify ${app} sessions yet.`),
    { code: "session_identity_unsupported" },
  );
}
