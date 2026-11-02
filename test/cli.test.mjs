import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve("mods/super-agent/bin/super-agent.mjs");

function fixture({ app = "test-agent" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-cli-"));
  const fakeHc = join(dir, "hc.mjs");
  const log = join(dir, "send.log");
  writeFileSync(fakeHc, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "get") {
  const byTerminal = JSON.parse(process.env.FAKE_HC_GETS ?? "{}");
  process.stdout.write(JSON.stringify(byTerminal[args[1]] ?? JSON.parse(process.env.FAKE_HC_GET)) + "\\n");
  process.exit(0);
}
if (args[0] === "send") {
  appendFileSync(process.env.FAKE_HC_LOG, JSON.stringify(args) + "\\n");
  process.stderr.write(process.env.FAKE_HC_SEND_ERROR ?? "");
  process.exit(Number(process.env.FAKE_HC_SEND_CODE ?? 0));
}
process.exit(1);
`);
  chmodSync(fakeHc, 0o755);
  const baseInfo = {
    address: "t1",
    state: "live",
    parent: null,
    status: { app, state: "idle" },
    foreground: { pid: 101, argv: ["pi"], name: "node" },
  };
  const env = {
    ...process.env,
    HC_TERMINAL_ID: "t1",
    SUPER_AGENT_DB: join(dir, "inbox.sqlite"),
    SUPER_AGENT_HC: fakeHc,
    PI_SESSION_ID: "",
    FAKE_HC_GET: JSON.stringify(baseInfo),
    FAKE_HC_LOG: log,
  };
  return {
    dir,
    log,
    env,
    run(args, extra = {}) {
      const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", cli, ...args], {
        encoding: "utf8",
        env: { ...env, ...extra },
      });
      return {
        ...result,
        json: result.stdout ? JSON.parse(result.stdout) : null,
      };
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Pi must be enabled before it can open requests", () => {
  const f = fixture({ app: "pi" });
  try {
    const session = { PI_SESSION_ID: "pi-session-1" };
    const denied = f.run(["ask", "--title", "Deploy?", "--body", "Choose target"], session);
    assert.equal(denied.status, 3);
    assert.equal(denied.json.error.code, "super_agent_disabled");

    const enabled = f.run(["enable", "t1"], session);
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(enabled.json.pending, true);
    const activation = JSON.parse(readFileSync(f.log, "utf8").trim()).at(-1);
    assert.match(activation, /The user enabled Super Agent/);
    assert.match(activation, /Before asking the user any question/);
    assert.match(activation, /carry-over and side questions/);
    assert.match(activation, /do not say you opened, moved, copied, mirrored, or posted/);
    assert.match(activation, /short paragraphs, blank lines between sections, and bullets for options/);

    const registered = f.run(["register"], session);
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(registered.json.enabled, true);
    assert.equal(registered.json.session, "pi-session-1");

    writeFileSync(f.log, "");
    const ask = f.run(["ask", "--title", "Deploy?", "--body", "Choose target"], session);
    assert.equal(ask.status, 0, ask.stderr);
    assert.match(ask.json.request, /^req_/);

    const followed = f.run(["append", ask.json.request, "--body", "One more detail"], session);
    assert.equal(followed.status, 0, followed.stderr);
    const resolved = f.run(["resolve", ask.json.request], session);
    assert.equal(resolved.status, 0, resolved.stderr);

    const snapshot = f.run(["snapshot"], session);
    assert.equal(snapshot.json.requests[0].status, "resolved");
    assert.deepEqual(snapshot.json.sessions.map(({ agent_kind, session_id, terminal }) => ({ agent_kind, session_id, terminal })), [
      { agent_kind: "pi", session_id: "pi-session-1", terminal: "t1" },
    ]);
  } finally {
    f.close();
  }
});

test("disabling a session tells the agent, retires requests, and blocks every later command", () => {
  const f = fixture({ app: "pi" });
  try {
    const session = { PI_SESSION_ID: "pi-session-disable" };
    assert.equal(f.run(["enable", "t1"], session).status, 0);
    assert.equal(f.run(["register"], session).status, 0);
    const request = f.run(["ask", "--title", "Existing", "--body", "Finish me"], session).json.request;
    writeFileSync(f.log, "");

    const disabled = f.run(["disable", "t1"], session);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.json.disabled, true);
    const notice = JSON.parse(readFileSync(f.log, "utf8").trim()).at(-1);
    assert.match(notice, /disabled Super Agent for this session/);
    assert.match(notice, /Stop using Super Agent commands/);

    for (const args of [
      ["ask", "--title", "New", "--body", "Not allowed"],
      ["append", request, "--body", "Not allowed"],
      ["resolve", request],
      ["register"],
    ]) {
      const denied = f.run(args, session);
      assert.equal(denied.status, 3);
      assert.equal(denied.json.error.code, "super_agent_disabled");
      assert.match(denied.json.error.message, /Stop using it unless the user enables it again/);
    }

    const snapshot = f.run(["snapshot"]);
    assert.equal(snapshot.json.sessions[0].enabled, 0);
    assert.equal(snapshot.json.requests[0].status, "resolved");
  } finally {
    f.close();
  }
});

test("failed disable notice leaves the session enabled", () => {
  const f = fixture({ app: "pi" });
  try {
    const session = { PI_SESSION_ID: "pi-session-disable-failure" };
    assert.equal(f.run(["enable", "t1"], session).status, 0);
    assert.equal(f.run(["register"], session).status, 0);
    assert.equal(f.run(["ask", "--title", "Existing", "--body", "Stay active"], session).status, 0);

    const failed = f.run(["disable", "t1"], {
      ...session,
      FAKE_HC_SEND_CODE: "1",
      FAKE_HC_SEND_ERROR: "disable notice refused",
    });
    assert.equal(failed.status, 4);
    const snapshot = f.run(["snapshot"]);
    assert.equal(snapshot.json.sessions[0].enabled, 1);
    assert.equal(snapshot.json.requests[0].status, "unread");
  } finally {
    f.close();
  }
});

test("a resumed Pi session lazily rebinds requests only after the old process is gone", () => {
  const f = fixture({ app: "pi" });
  try {
    const session = { PI_SESSION_ID: "pi-session-resume" };
    assert.equal(f.run(["enable", "t1"], session).status, 0);
    assert.equal(f.run(["register"], session).status, 0);
    const ask = f.run(["ask", "--title", "Resume", "--body", "Still there?"], session);
    assert.equal(ask.status, 0, ask.stderr);

    const first = JSON.parse(f.env.FAKE_HC_GET);
    const gone = { ...first, state: "finished", status: null, foreground: null };
    const resumed = { ...first, address: "t2", foreground: { ...first.foreground, pid: 202 } };
    const resumedEnv = {
      ...session,
      HC_TERMINAL_ID: "t2",
      FAKE_HC_GETS: JSON.stringify({ t1: gone, t2: resumed }),
    };
    const followed = f.run(["append", ask.json.request, "--body", "After resume"], resumedEnv);
    assert.equal(followed.status, 0, followed.stderr);
    assert.equal(f.run(["snapshot"]).json.requests[0].origin_terminal, "t2");

    const secondView = { ...resumed, address: "t3", foreground: { ...resumed.foreground, pid: 303 } };
    const secondViewEnv = {
      ...session,
      HC_TERMINAL_ID: "t3",
      FAKE_HC_GETS: JSON.stringify({ t2: resumed, t3: secondView }),
    };
    const secondFollowUp = f.run(["append", ask.json.request, "--body", "Second view"], secondViewEnv);
    assert.equal(secondFollowUp.status, 0, secondFollowUp.stderr);
    assert.equal(f.run(["snapshot"]).json.requests[0].origin_terminal, "t2");
  } finally {
    f.close();
  }
});

test("Claude Code session identity can be enabled and open a request", () => {
  const f = fixture({ app: "claude-code" });
  try {
    const session = { CLAUDE_CODE_SESSION_ID: "claude-session-1" };
    assert.equal(f.run(["ask", "--title", "Question", "--body", "Body"], session).status, 3);
    assert.equal(f.run(["enable", "t1"], session).status, 0);
    const registered = f.run(["register"], session);
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(registered.json.session, "claude-session-1");
    assert.equal(registered.json.agent, "claude-code");
    assert.equal(f.run(["ask", "--title", "Question", "--body", "Body"], session).status, 0);
  } finally {
    f.close();
  }
});

test("Codex uses the root session identity and rejects internal descendants", () => {
  const f = fixture({ app: "codex" });
  try {
    assert.equal(f.run(["enable", "t1"]).status, 0);
    const missingThread = f.run(["register"], { CODEX_SESSION_ID: "codex-root" });
    assert.equal(missingThread.status, 1);
    assert.equal(missingThread.json.error.code, "session_identity_missing");

    const descendant = f.run(["register"], {
      CODEX_SESSION_ID: "codex-root",
      CODEX_THREAD_ID: "codex-child",
    });
    assert.equal(descendant.status, 1);
    assert.equal(descendant.json.error.code, "child_agent");

    const root = {
      CODEX_SESSION_ID: "codex-root",
      CODEX_THREAD_ID: "codex-root",
    };
    const registered = f.run(["register"], root);
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(registered.json.session, "codex-root");
    assert.equal(registered.json.agent, "codex");
    assert.equal(f.run(["ask", "--title", "Question", "--body", "Body"], root).status, 0);
  } finally {
    f.close();
  }
});

test("recognized Pi commands require session metadata", () => {
  const f = fixture({ app: "pi" });
  try {
    const result = f.run(["ask", "--title", "Question", "--body", "Body"]);
    assert.equal(result.status, 1);
    assert.equal(result.json.error.code, "session_identity_missing");
  } finally {
    f.close();
  }
});

test("failed activation leaves the Pi session disabled", () => {
  const f = fixture({ app: "pi" });
  try {
    const failed = f.run(["enable", "t1"], {
      FAKE_HC_SEND_CODE: "1",
      FAKE_HC_SEND_ERROR: "activation refused",
    });
    assert.equal(failed.status, 4);
    assert.equal(failed.json.error.code, "send_failed");
    assert.deepEqual(f.run(["snapshot"]).json.pendingEnablements, []);
  } finally {
    f.close();
  }
});

test("agent creates a request and human reply is submitted with IDs", () => {
  const f = fixture();
  try {
    const ask = f.run(["ask", "--title", "Deploy?", "--body", "Choose target"]);
    assert.equal(ask.status, 0, ask.stderr);
    assert.match(ask.json.request, /^req_/);

    const snapshot = f.run(["snapshot"]);
    const request = snapshot.json.requests[0];
    const reply = f.run([
      "reply",
      request.id,
      "--body",
      "Staging",
      "--expected-revision",
      String(request.revision),
    ]);
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(reply.json.delivery, "submitted");
    assert.equal(reply.json.request.status, "waiting-agent");

    const sent = JSON.parse(readFileSync(f.log, "utf8").trim());
    assert.deepEqual(sent.slice(0, 4), ["send", "--if", "idle", "t1"]);
    assert.match(sent[4], new RegExp(`request=${request.id} message=msg_`));
    assert.match(sent[4], /\nStaging$/);
  } finally {
    f.close();
  }
});

test("ask rejects child terminals and plain shells", () => {
  const f = fixture();
  try {
    const child = JSON.parse(f.env.FAKE_HC_GET);
    child.parent = "t0";
    const childResult = f.run(["ask", "--title", "Question", "--body", "Body"], {
      FAKE_HC_GET: JSON.stringify(child),
    });
    assert.equal(childResult.status, 4);
    assert.equal(childResult.json.error.code, "child_agent");

    const childEnable = f.run(["enable", "t1"], { FAKE_HC_GET: JSON.stringify(child) });
    assert.equal(childEnable.status, 4);
    assert.equal(childEnable.json.error.code, "child_agent");
    const childRegister = f.run(["register"], {
      FAKE_HC_GET: JSON.stringify(child),
      PI_SESSION_ID: "child-session",
    });
    assert.equal(childRegister.status, 4);
    assert.equal(childRegister.json.error.code, "child_agent");

    const shell = { ...child, parent: null, status: null, foreground: { pid: 101 } };
    const shellResult = f.run(["ask", "--title", "Question", "--body", "Body"], {
      FAKE_HC_GET: JSON.stringify(shell),
    });
    assert.equal(shellResult.status, 4);
    assert.equal(shellResult.json.error.code, "not_agent");
  } finally {
    f.close();
  }
});

test("top-level --help prints protocol usage", () => {
  const f = fixture();
  try {
    const result = f.run(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.usage[0], "herdr-super-agent register");
  } finally {
    f.close();
  }
});

test("option values may begin with dashes", () => {
  const f = fixture();
  try {
    const ask = f.run(["ask", "--title", "Flags", "--body", "--help"]);
    assert.equal(ask.status, 0, ask.stderr);
    const snapshot = f.run(["snapshot"]);
    assert.equal(snapshot.json.requests[0].messages[0].body, "--help");
  } finally {
    f.close();
  }
});

test("done agents receive a non-forced delivery without a status guard", () => {
  const f = fixture();
  try {
    const done = JSON.parse(f.env.FAKE_HC_GET);
    done.status.state = "done";
    const ask = f.run(["ask", "--title", "Done", "--body", "Question"], { FAKE_HC_GET: JSON.stringify(done) });
    const snapshot = f.run(["snapshot"], { FAKE_HC_GET: JSON.stringify(done) });
    const request = snapshot.json.requests[0];
    const reply = f.run([
      "reply", ask.json.request, "--body", "Answer", "--expected-revision", String(request.revision),
    ], { FAKE_HC_GET: JSON.stringify(done) });
    assert.equal(reply.status, 0, reply.stderr);
    const sent = JSON.parse(readFileSync(f.log, "utf8").trim());
    assert.deepEqual(sent.slice(0, 2), ["send", "t1"]);
  } finally {
    f.close();
  }
});

test("blocked agents refuse delivery without force", () => {
  const f = fixture();
  try {
    const ask = f.run(["ask", "--title", "Blocked", "--body", "Question"]);
    const snapshot = f.run(["snapshot"]);
    const request = snapshot.json.requests[0];
    const blocked = JSON.parse(f.env.FAKE_HC_GET);
    blocked.status.state = "blocked";
    const reply = f.run([
      "reply", ask.json.request, "--body", "Answer", "--expected-revision", String(request.revision),
    ], { FAKE_HC_GET: JSON.stringify(blocked) });
    assert.equal(reply.status, 2);
    assert.equal(reply.json.error.code, "origin_blocked");
  } finally {
    f.close();
  }
});

test("suggest-resolve resolves the request and tells the agent how to reopen it", () => {
  const f = fixture();
  try {
    const ask = f.run(["ask", "--title", "Question", "--body", "Body"]);
    const suggested = f.run(["suggest-resolve", ask.json.request]);
    assert.equal(suggested.status, 0, suggested.stderr);
    assert.equal(suggested.json.delivery, "submitted");
    assert.equal(suggested.json.request.status, "resolved");
    const sent = JSON.parse(readFileSync(f.log, "utf8").trim());
    assert.match(sent[4], new RegExp(`^\\[super-agent resolved request=${ask.json.request} message=msg_`));
    assert.match(sent[4], new RegExp(`herdr-super-agent append ${ask.json.request}`));
  } finally {
    f.close();
  }
});

test("delivery is refused after agent pid changes", () => {
  const f = fixture();
  try {
    const ask = f.run(["ask", "--title", "Deploy?", "--body", "Choose target"]);
    const snapshot = f.run(["snapshot"]);
    const request = snapshot.json.requests[0];
    const changed = JSON.parse(f.env.FAKE_HC_GET);
    changed.foreground.pid = 202;
    const reply = f.run([
      "reply",
      ask.json.request,
      "--body",
      "Staging",
      "--expected-revision",
      String(request.revision),
    ], { FAKE_HC_GET: JSON.stringify(changed) });
    assert.equal(reply.status, 4);
    assert.equal(reply.json.error.code, "origin_changed");
    const after = f.run(["snapshot"]);
    assert.equal(after.json.requests[0].status, "unread");
    assert.equal(after.json.requests[0].messages.length, 1);
  } finally {
    f.close();
  }
});
