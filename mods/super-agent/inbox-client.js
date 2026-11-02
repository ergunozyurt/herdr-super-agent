import { appHome, exec, watchFolder } from "herdr";

function parse(result) {
  let payload;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(result.stderr.trim() || "Super Agent returned invalid data.");
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

  async run(args) {
    return parse(await exec(this.node, ["--no-warnings=ExperimentalWarning", this.cli, ...args]));
  }

  snapshot() {
    return this.run(["snapshot"]);
  }

  enable(terminal) {
    return this.run(["enable", terminal]);
  }

  disable(terminal) {
    return this.run(["disable", terminal]);
  }

  read(request) {
    return this.run(["read", request.id, "--expected-revision", String(request.revision)]);
  }

  suggestResolve(id) {
    return this.run(["suggest-resolve", id]);
  }

  claimNotifications(openRequest) {
    return this.run(["claim-notifications", ...(openRequest ? ["--open", openRequest] : [])]);
  }

  prune(ids) {
    return this.run(["prune", "--ids", JSON.stringify(ids)]);
  }

  async waitForChange() {
    for (;;) {
      const changed = await watchFolder(this.data);
      if (changed.some((path) => path.endsWith("inbox.sqlite.revision"))) return changed;
    }
  }
}
