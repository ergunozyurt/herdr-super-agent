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

// hc reports errors as JSON on stderr: {"error":{"kind","message"}}.
function stderrError(stderr) {
  try {
    return JSON.parse(stderr.trim()).error ?? null;
  } catch {
    return null;
  }
}

// Keep only the human-readable message.
function stderrMessage(stderr) {
  const text = stderr.trim();
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}

// Herdr Core holds a send while the person has unsent text in the target's prompt, until
// `draft_wait` (default 60 s, the person's setting) has passed since their last key, else for
// ~3 s of quiet; then it pastes after their text and submits both. Holds of ~106 s were seen.
// When this runs out, `hc` is killed but core may still deliver: a timeout means "unknown".
export const SEND_TIMEOUT = 150_000;

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

  send(origin, text, { timeout = SEND_TIMEOUT } = {}) {
    const deadline = Date.now() + timeout;
    for (let attempt = 1; ; attempt += 1) {
      let info;
      try {
        info = this.validateDelivery(origin);
      } catch (error) {
        // Nothing was typed, so this is a failure, not an unknown delivery.
        if (error.code === "timeout") throw new CoreError(error.message, { code: "validate_timeout" });
        throw error;
      }
      const state = info.status.state;
      // `--if` is the fence after core's hold: an agent that exits meanwhile leaves a shell, which
      // has neither status, so core refuses rather than typing the message into it.
      const args = state === "idle" || state === "working"
        ? ["send", "--if", state, origin.terminal, text]
        : state === "done"
          ? ["send", origin.terminal, text]
          : null;
      if (!args) throw new CoreError(`The originating agent is ${state}; delivery was refused.`, { code: "origin_unavailable" });
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw sendTimeout(timeout);
      let result;
      try {
        result = this.run(args, { timeout: remaining });
      } catch (error) {
        if (error.code !== "timeout") throw error;
        throw sendTimeout(timeout);
      }
      if (result.code === 0) return result;
      // Core checks `--if` only after its hold, by when the agent may have moved between idle and
      // working; nothing was typed. Check the process again and retry with its current state.
      if (stderrError(result.stderr)?.kind === "status_mismatch" && attempt < 3) continue;
      throw new CoreError(stderrMessage(result.stderr) || "Herdr Core refused the message.", {
        code: "send_failed",
        stderr: result.stderr,
        exitCode: result.code,
      });
    }
  }
}

function sendTimeout(timeout) {
  return new CoreError(
    `Herdr Core did not confirm delivery within ${Math.round(timeout / 1000)} s; it waits while the agent's prompt has unsent text. The message may still arrive: check the agent before sending again.`,
    { code: "timeout" },
  );
}
