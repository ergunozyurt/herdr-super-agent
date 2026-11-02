#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CoreClient, CoreError } from "../lib/core.mjs";
import { deliverHuman, publicError as errorFields } from "../lib/delivery.mjs";
import { requireSessionIdentity, sessionIdentity, supportsSessionIdentity } from "../lib/identity.mjs";
import { ConflictError, InboxStore } from "../lib/store.mjs";

const file = fileURLToPath(import.meta.url);
const installedName = basename(dirname(dirname(file)));
const appHome = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const dbPath = process.env.SUPER_AGENT_DB ?? join(appHome, "data", installedName, "inbox.sqlite");

const VALUE_OPTIONS = new Set(["title", "body", "expected-revision", "draft-revision", "open", "ids", "agent-name"]);

function parse(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i];
    if (!part.startsWith("--")) {
      positional.push(part);
      continue;
    }
    const key = part.slice(2);
    if (!VALUE_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    if (i + 1 >= rest.length) throw Object.assign(new Error(`Missing value for --${key}.`), { code: "usage" });
    options[key] = rest[i + 1];
    i += 1;
  }
  return { command, positional, options };
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error(`Missing --${name}.`), { code: "usage" });
  }
  return value;
}

function number(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw Object.assign(new Error(`Invalid --${name}.`), { code: "usage" });
  return parsed;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function publicError(error) {
  return { error: errorFields(error) };
}

function rebindUnavailableRequests(store, core, identity, origin) {
  if (!identity) return origin;
  const stale = store.requestsForSession(identity).filter((request) => {
    if (
      request.origin_terminal === origin.terminal &&
      request.origin_app === origin.app &&
      request.origin_pid === origin.pid
    ) return false;
    return !core.originIsLive({
      terminal: request.origin_terminal,
      app: request.origin_app,
      pid: request.origin_pid,
    });
  });
  store.rebindRequests({ identity, origin, requests: stale });
  return origin;
}

function authorizeRequestCommand(store, core, { id, identity, origin }) {
  if (!identity) return origin;
  let authorized;
  try {
    authorized = store.authorizeSession({ identity, origin });
  } catch (error) {
    if (error.code !== "super_agent_disabled") throw error;
    if (store.requireRequest(id).origin_session_id) throw error;
    authorized = store.adoptLegacySession({ id, identity, origin });
  }
  return rebindUnavailableRequests(store, core, identity, authorized);
}

async function main() {
  const { command, positional, options } = parse(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || options.help) {
    print({
      usage: [
        "herdr-super-agent register",
        "herdr-super-agent ask --title <title> --body <message>",
        "herdr-super-agent append <request> --body <message>",
        "herdr-super-agent resolve <request>",
      ],
    });
    return;
  }

  const store = new InboxStore(dbPath);
  const core = new CoreClient();
  try {
    store.reconcilePending();
    if (command === "enable") {
      const origin = core.originForTerminal(required(positional[0], "terminal"), { requireTopLevel: true });
      if (!supportsSessionIdentity(origin.app)) {
        throw Object.assign(new Error(`Super Agent session enablement does not support ${origin.app} yet.`), {
          code: "session_identity_unsupported",
        });
      }
      store.beginEnablement({ origin });
      try {
        core.send(origin, [
          "[super-agent activation]",
          "The user enabled Super Agent for this agent session.",
          "Run: herdr-super-agent register",
          "Super Agent is now the channel for every question you direct to the user in this session.",
          "Before asking the user any question or requesting a decision, approval, confirmation, or sign-off—including carry-over and side questions—open a request first.",
          "Use ask once, append for substantive follow-ups, and resolve when no user input remains. Do not duplicate request messages in the terminal.",
          "Keep channel mechanics silent: do not say you opened, moved, copied, mirrored, or posted something to Super Agent unless a command fails or the user explicitly asks.",
          "Write request bodies for scanning: short paragraphs, blank lines between sections, and bullets for options; end with one direct question.",
          "After a reply, act on it. Append only when the user needs a substantive follow-up or you need more input; otherwise resolve.",
        ].join("\n"));
      } catch (error) {
        store.cancelEnablement(origin);
        throw error;
      }
      print({ terminal: origin.terminal, pending: true });
      return;
    }

    if (command === "disable") {
      const origin = core.originForTerminal(required(positional[0], "terminal"), { requireTopLevel: true });
      if (!store.enabledSessionForBinding(origin)) {
        throw new ConflictError("Super Agent is already disabled for this session.", "super_agent_disabled");
      }
      core.send(origin, [
        "[super-agent disabled]",
        "The user disabled Super Agent for this session.",
        "Stop using Super Agent commands unless the user enables it again.",
        "Active requests were retired. Use the agent terminal for user-directed questions again.",
      ].join("\n"));
      const disabled = store.disableSession({ origin });
      print({ disabled: true, retired: disabled.retired, session: disabled.sessionId, agent: disabled.agentKind });
      return;
    }

    if (command === "register") {
      const origin = core.currentOrigin({ requireTopLevel: true });
      const identity = requireSessionIdentity(origin.app);
      const session = store.registerSession({ identity, origin });
      rebindUnavailableRequests(store, core, identity, { ...origin, ...identity });
      print({ enabled: true, session: session.session_id, agent: session.agent_kind });
      return;
    }

    if (command === "ask") {
      const current = core.currentOrigin({ requireTopLevel: true });
      const identity = sessionIdentity(current.app);
      const authorized = store.authorizeSession({ identity, origin: current }) ?? current;
      const origin = rebindUnavailableRequests(store, core, identity, authorized);
      const request = store.createRequest({
        origin,
        title: required(options.title, "title"),
        body: required(options.body, "body"),
      });
      print({ request: request.id });
      return;
    }

    if (command === "append") {
      const id = required(positional[0], "request");
      const current = core.currentOrigin({ requireTopLevel: true });
      const identity = sessionIdentity(current.app);
      const origin = authorizeRequestCommand(store, core, { id, identity, origin: current });
      const result = store.appendAgent({
        id,
        origin,
        body: required(options.body, "body"),
      });
      print({ request: result.request.id, revision: result.request.revision });
      return;
    }

    if (command === "resolve") {
      const id = required(positional[0], "request");
      const current = core.currentOrigin({ requireTopLevel: true });
      const identity = sessionIdentity(current.app);
      const origin = authorizeRequestCommand(store, core, { id, identity, origin: current });
      const request = store.resolveAgent({ id, origin });
      print({ request: request.id, resolved: true });
      return;
    }

    if (command === "snapshot") {
      print(store.snapshot());
      return;
    }

    if (command === "read") {
      const request = store.markRead({
        id: required(positional[0], "request"),
        expectedRevision: number(options["expected-revision"], "expected-revision"),
      });
      print({ request });
      return;
    }

    if (command === "reply" || command === "suggest-resolve") {
      const kind = command === "reply" ? "message" : "resolve";
      const result = deliverHuman({
        store,
        core,
        id: required(positional[0], "request"),
        kind,
        body: kind === "message" ? required(options.body, "body") : "",
        // Resolving needs no fresh view of the thread; a reply does.
        expectedRevision: kind === "resolve" && options["expected-revision"] == null
          ? null
          : number(options["expected-revision"], "expected-revision"),
        draftRevision: options["draft-revision"] == null ? null : number(options["draft-revision"], "draft-revision"),
      });
      print(result);
      if (result.delivery !== "submitted") process.exitCode = 2;
      return;
    }

    if (command === "thread") {
      const { runThread } = await import("../lib/thread.mjs");
      await runThread({
        store,
        core,
        id: required(positional[0], "request"),
        dbPath,
        mod: installedName,
        agentName: options["agent-name"] || null,
      });
      return;
    }

    if (command === "claim-notifications") {
      print({ notifications: store.claimNotifications({ openRequest: options.open ?? null }) });
      return;
    }

    if (command === "prune") {
      const ids = JSON.parse(required(options.ids, "ids"));
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        throw Object.assign(new Error("--ids must be a JSON string array."), { code: "usage" });
      }
      print(store.retireRequests(ids));
      return;
    }

    throw Object.assign(new Error(`Unknown command: ${command}`), { code: "usage" });
  } finally {
    store.close();
  }
}

main().catch((error) => {
  print(publicError(error));
  if (error instanceof ConflictError) process.exitCode = 3;
  else if (error instanceof CoreError) process.exitCode = 4;
  else process.exitCode = 1;
});
