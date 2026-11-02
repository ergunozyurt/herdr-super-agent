import { spawnSync } from "node:child_process";

export class CoreError extends Error {
  constructor(message, { code = "core_error", stderr = "", exitCode = null } = {}) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

// hc reports errors as JSON on stderr; keep only the human-readable message.
function stderrMessage(stderr) {
  const text = stderr.trim();
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}

export class CoreClient {
  constructor({ executable = process.env.SUPER_AGENT_HC ?? "hc", timeout = 5_000 } = {}) {
    this.executable = executable;
    this.timeout = timeout;
  }

  run(args, { timeout = this.timeout } = {}) {
    const result = spawnSync(this.executable, args, {
      encoding: "utf8",
      timeout,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw new CoreError("Herdr Core did not answer before the timeout.", { code: "timeout" });
      }
      throw new CoreError(`Could not run ${this.executable}: ${result.error.message}`, { code: "spawn_failed" });
    }
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  get(terminal) {
    const result = this.run(["get", terminal, "--json"]);
    if (result.code !== 0) {
      throw new CoreError(stderrMessage(result.stderr) || `Could not inspect ${terminal}.`, {
        code: "get_failed",
        stderr: result.stderr,
        exitCode: result.code,
      });
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new CoreError("Herdr Core returned invalid terminal data.", { code: "invalid_response" });
    }
  }

  currentOrigin({ requireTopLevel = true } = {}) {
    const terminal = process.env.HC_TERMINAL_ID;
    if (!terminal) throw new CoreError("HC_TERMINAL_ID is missing; run this inside a Herdr terminal.", { code: "outside_herdr" });
    return this.originForTerminal(terminal, { requireTopLevel });
  }

  originForTerminal(terminal, { requireTopLevel = true } = {}) {
    const info = this.get(terminal);
    if (requireTopLevel && info.parent) {
      throw new CoreError("Only a main agent can use Super Agent.", { code: "child_agent" });
    }
    return this.origin(info);
  }

  origin(info) {
    const app = info.status?.app;
    const pid = info.foreground?.pid;
    if (info.state !== "live" || !app || !Number.isInteger(pid)) {
      throw new CoreError("The terminal is not currently running a detectable agent.", { code: "not_agent" });
    }
    return { terminal: info.address, app, pid };
  }

  originIsLive(origin) {
    try {
      const info = this.get(origin.terminal);
      return info.state === "live" &&
        Boolean(info.status?.app) &&
        Number.isInteger(info.foreground?.pid) &&
        info.status.app === origin.app &&
        info.foreground.pid === origin.pid;
    } catch {
      return false;
    }
  }

  validateOriginBinding(origin) {
    const info = this.get(origin.terminal);
    if (info.state !== "live" || !info.status?.app || !Number.isInteger(info.foreground?.pid)) {
      throw new CoreError("The originating agent is gone.", { code: "origin_gone" });
    }
    if (info.status.app !== origin.app || info.foreground.pid !== origin.pid) {
      throw new CoreError("The originating agent changed; delivery was refused.", { code: "origin_changed" });
    }
    return info;
  }

  validateDelivery(origin) {
    const info = this.validateOriginBinding(origin);
    if (info.status.state === "blocked") {
      throw new CoreError("The originating agent is blocked; Super Agent will not force delivery.", { code: "origin_blocked" });
    }
    return info;
  }

  send(origin, text, { timeout = 15_000 } = {}) {
    const info = this.validateDelivery(origin);
    const state = info.status.state;
    const args = state === "idle" || state === "working"
      ? ["send", "--if", state, origin.terminal, text]
      : state === "done"
        ? ["send", origin.terminal, text]
        : null;
    if (!args) throw new CoreError(`The originating agent is ${state}; delivery was refused.`, { code: "origin_unavailable" });
    const result = this.run(args, { timeout });
    if (result.code !== 0) {
      throw new CoreError(stderrMessage(result.stderr) || "Herdr Core refused the message.", {
        code: "send_failed",
        stderr: result.stderr,
        exitCode: result.code,
      });
    }
    return result;
  }
}
