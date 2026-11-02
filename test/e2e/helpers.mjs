import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("mods/super-agent/bin/super-agent.mjs");
const readAtSize = resolve("test/e2e/read-at-size.py");
const tick = (ms) => new Promise((resolveTick) => setTimeout(resolveTick, ms));

function run(program, args, { env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", env, maxBuffer: 8 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(result.error?.message || result.stderr.trim() || `${program} exited with ${result.status}`);
  }
  return result;
}

function json(program, args, options) {
  const result = run(program, args, options);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${program} returned invalid JSON: ${result.stdout || result.stderr}`);
  }
}

function fakeHcSource() {
  return `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.FAKE_HC_STATE, "utf8"));
if (args[0] === "get") {
  process.stdout.write(JSON.stringify(state.origin) + "\\n");
  process.exit(0);
}
if (args[0] === "send") {
  appendFileSync(process.env.FAKE_HC_LOG, JSON.stringify(args) + "\\n");
  if (state.sendError) process.stderr.write(state.sendError);
  process.exit(state.sendCode ?? 0);
}
process.stderr.write("unsupported fake hc command: " + args.join(" ") + "\\n");
process.exit(1);
`;
}

export async function createFixture() {
  if (!process.env.HC_TERMINAL_SOCKET) throw new Error("SUPER_AGENT_E2E requires a running Herdr core.");

  const dir = mkdtempSync(join(tmpdir(), "super-agent-e2e-"));
  const token = randomUUID().replaceAll("-", "").slice(0, 10);
  const db = join(dir, "inbox.sqlite");
  const statePath = join(dir, "hc-state.json");
  const logPath = join(dir, "send.log");
  const fakeHc = join(dir, "fake-hc.mjs");
  const tracked = new Set();
  const state = {
    origin: {
      address: `origin-${token}`,
      state: "live",
      parent: null,
      status: { app: "test-agent", state: "idle" },
      foreground: { pid: 4242, argv: ["pi"], name: "node" },
    },
  };

  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  writeFileSync(logPath, "");
  writeFileSync(fakeHc, fakeHcSource());
  chmodSync(fakeHc, 0o755);

  const commandEnv = {
    ...process.env,
    HC_TERMINAL_ID: state.origin.address,
    SUPER_AGENT_DB: db,
    SUPER_AGENT_HC: fakeHc,
    PI_SESSION_ID: "",
    FAKE_HC_STATE: statePath,
    FAKE_HC_LOG: logPath,
  };

  function cliCommand(args, { allowFailure = false } = {}) {
    const result = run(process.execPath, ["--no-warnings=ExperimentalWarning", cli, ...args], {
      env: commandEnv,
      allowFailure,
    });
    return {
      ...result,
      json: result.stdout ? JSON.parse(result.stdout) : null,
    };
  }

  return {
    dir,
    db,
    state,
    logPath,
    ask({ title, body }) {
      return cliCommand(["ask", "--title", title, "--body", body]).json.request;
    },
    append(request, body) {
      return cliCommand(["append", request, "--body", body]).json;
    },
    resolve(request) {
      return cliCommand(["resolve", request]).json;
    },
    cli: cliCommand,
    setCoreState(update) {
      Object.assign(state, update);
      writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    },
    failDelivery(message) {
      this.setCoreState({ sendCode: 1, sendError: message });
    },
    sent() {
      const text = readFileSync(logPath, "utf8").trim();
      return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
    },
    async waitForSent(count, { timeoutMs = 5_000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const messages = this.sent();
        if (messages.length >= count) return messages;
        await tick(25);
      }
      throw new Error(`Timed out waiting for ${count} fake hc sends.`);
    },
    snapshot() {
      return cliCommand(["snapshot"]).json;
    },
    async waitForSnapshot(expected, { timeoutMs = 5_000 } = {}) {
      const started = Date.now();
      let snapshot = null;
      while (Date.now() - started < timeoutMs) {
        snapshot = this.snapshot();
        if (expected(snapshot)) return snapshot;
        await tick(25);
      }
      throw new Error(`Timed out waiting for snapshot. Last value:\n${JSON.stringify(snapshot, null, 2)}`);
    },
    terminal(address) {
      return json("hc", ["get", "--json", address]);
    },
    async waitForTerminalEnd(address, { timeoutMs = 5_000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const result = run("hc", ["get", "--json", address], { allowFailure: true });
        if (result.status !== 0) return null;
        const value = JSON.parse(result.stdout);
        if (value.state === "finished") return value;
        await tick(25);
      }
      throw new Error(`Timed out waiting for terminal ${address} to end.`);
    },
    keys(terminal, ...keys) {
      run("hc", ["keys", terminal, ...keys]);
    },
    typeText(terminal, text) {
      const names = [];
      for (const character of text) {
        if (character === "\n") names.push("shift+enter");
        else if (character === " ") names.push("space");
        else if (/^[a-z0-9]$/.test(character)) names.push(character);
        else if (/^[A-Z]$/.test(character)) names.push(`shift+${character.toLowerCase()}`);
        else if (/^[\x21-\x7e]$/.test(character)) names.push(character);
        else throw new Error(`No e2e key mapping for ${JSON.stringify(character)}.`);
      }
      this.keys(terminal, ...names);
    },
    startThread(request) {
      const name = `sa-e2e-${token}`;
      const launched = json("hc", [
        "run", "--bg", "--json", "--no-parent", "--rm",
        "--name", name,
        "--label", `super-agent.e2e=${token}`,
        "--",
        "env",
        `SUPER_AGENT_DB=${db}`,
        `SUPER_AGENT_HC=${fakeHc}`,
        `FAKE_HC_STATE=${statePath}`,
        `FAKE_HC_LOG=${logPath}`,
        process.execPath,
        "--no-warnings=ExperimentalWarning",
        cli,
        "thread",
        request,
        "--agent-name",
        "Test Agent",
      ]);
      tracked.add(launched.address);
      return launched.address;
    },
    readScreen(terminal) {
      return run("hc", ["read", "--lines", "200", terminal]).stdout;
    },
    readAtSize(terminal, { columns, rows }) {
      return run("python3", [readAtSize, terminal, String(columns), String(rows)]).stdout;
    },
    async waitForScreen(terminal, expected, { timeoutMs = 5_000 } = {}) {
      const started = Date.now();
      let screen = "";
      while (Date.now() - started < timeoutMs) {
        screen = this.readScreen(terminal);
        const matched = typeof expected === "function" ? expected(screen) : expected.test(screen);
        if (matched) return screen;
        await tick(25);
      }
      throw new Error(`Timed out waiting for terminal ${terminal}. Last screen:\n${screen}`);
    },
    async cleanup() {
      for (const terminal of tracked) {
        run("hc", ["kill", terminal], { allowFailure: true });
        run("hc", ["rm", terminal], { allowFailure: true });
      }
      tracked.clear();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
