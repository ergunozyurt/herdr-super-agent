import { appHome, exec, watchFolder } from "herdr";

// For commands that send to an agent. exec stops a program after 30 s by default, but the CLI
// can block for minutes while Herdr Core holds the message behind unsent text in the agent's
// prompt. Keep it above lib/core.mjs SEND_TIMEOUT (150 s) plus the CLI's own checks.
const SEND_EXEC_TIMEOUT = 200_000;

function parse(result) {
  let payload;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(result.stderr.trim() || "Super Agent returned invalid data.");
  }
  // exec stopped it (or it crashed) before it printed anything.
  if (result.code !== 0 && !result.stdout.trim() && !result.stderr.trim()) {
    throw new Error("Super Agent did not finish in time; the agent may still receive the message. Check its terminal.");
  }
  if (result.code !== 0 || payload.error) {
    const error = new Error(payload.error?.message || result.stderr.trim() || `Super Agent exited with ${result.code}.`);
    error.code = payload.error?.code || "helper_failed";
    error.payload = payload;
    throw error;
  }
  return payload;
}

export class InboxClient {
  constructor(options = {}) {
    this.mod = options.mod || "super-agent";
    this.node = options.node || "node";
    this.cli = `${appHome()}/mods/${this.mod}/bin/super-agent.mjs`;
    this.data = `${appHome()}/data/${this.mod}`;
  }

  async run(args, options = {}) {
    return parse(await exec(this.node, ["--no-warnings=ExperimentalWarning", this.cli, ...args], options));
  }

  snapshot() {
    return this.run(["snapshot"]);
  }

  enable(terminal) {
    return this.run(["enable", terminal], { timeout: SEND_EXEC_TIMEOUT });
  }

  disable(terminal) {
    return this.run(["disable", terminal], { timeout: SEND_EXEC_TIMEOUT });
  }

  read(request) {
    return this.run(["read", request.id, "--expected-revision", String(request.revision)]);
  }

  suggestResolve(id) {
    return this.run(["suggest-resolve", id], { timeout: SEND_EXEC_TIMEOUT });
  }

  claimNotifications(openRequest) {
    return this.run(["claim-notifications", ...(openRequest ? ["--open", openRequest] : [])]);
  }

  prune(ids) {
    return this.run(["prune", "--ids", JSON.stringify(ids)]);
  }

  followHerdr() {
    return this.run(["follow-herdr"]);
  }

  async waitForChange() {
    for (;;) {
      const changed = await watchFolder(this.data);
      if (changed.some((path) => path.endsWith("inbox.sqlite.revision"))) return changed;
    }
  }
}
