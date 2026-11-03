import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ACTIVE = new Set(["unread", "waiting-human", "waiting-agent"]);
const DELIVERY = new Set(["pending", "submitted", "failed", "unknown"]);

export class ConflictError extends Error {
  constructor(message = "The request changed; reload and try again.", code = "conflict") {
    super(message);
    this.name = "ConflictError";
    this.code = code;
  }
}

export class InboxStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.revisionPath = `${path}.revision`;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    const mode = this.db.prepare("PRAGMA journal_mode").get().journal_mode;
    if (mode !== "wal") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        request_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        origin_terminal TEXT NOT NULL,
        origin_app TEXT NOT NULL,
        origin_pid INTEGER NOT NULL,
        origin_agent_kind TEXT,
        origin_session_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unread', 'waiting-human', 'waiting-agent', 'resolved')),
        unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(agent_kind, session_id)
      );

      CREATE TABLE IF NOT EXISTS session_bindings (
        agent_kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        terminal TEXT NOT NULL,
        app TEXT NOT NULL,
        pid INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(agent_kind, session_id, terminal),
        FOREIGN KEY(agent_kind, session_id) REFERENCES agent_sessions(agent_kind, session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pending_enablements (
        terminal TEXT PRIMARY KEY,
        app TEXT NOT NULL,
        pid INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'resolve')),
        author TEXT NOT NULL CHECK (author IN ('agent', 'human')),
        body TEXT NOT NULL,
        delivery_status TEXT CHECK (delivery_status IN ('pending', 'submitted', 'failed', 'unknown')),
        draft_revision INTEGER,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_request_revision
        ON messages(request_id, revision);

      CREATE TABLE IF NOT EXISTS drafts (
        request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
    if (!messageColumns.includes("draft_revision")) this.db.exec("ALTER TABLE messages ADD COLUMN draft_revision INTEGER");
    const requestColumns = this.db.prepare("PRAGMA table_info(requests)").all().map((column) => column.name);
    if (!requestColumns.includes("origin_agent_kind")) this.db.exec("ALTER TABLE requests ADD COLUMN origin_agent_kind TEXT");
    if (!requestColumns.includes("origin_session_id")) this.db.exec("ALTER TABLE requests ADD COLUMN origin_session_id TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS requests_origin_session
        ON requests(origin_agent_kind, origin_session_id);
      CREATE INDEX IF NOT EXISTS session_bindings_terminal
        ON session_bindings(terminal);
    `);
  }

  transaction(fn) {
    const before = this.currentRevision();
    this.db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (this.currentRevision() !== before) this.publishRevision();
    return result;
  }

  currentRevision() {
    return Number(this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM changes").get().revision);
  }

  publishRevision() {
    const revision = this.currentRevision();
    const temporary = `${this.revisionPath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${revision}\n`);
    renameSync(temporary, this.revisionPath);
  }

  readTransaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  nextRevision(kind, requestId, now = Date.now()) {
    return Number(this.db.prepare(
      "INSERT INTO changes(kind, request_id, created_at) VALUES (?, ?, ?) RETURNING revision",
    ).get(kind, requestId, now).revision);
  }

  request(id) {
    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) ?? null;
  }

  requireRequest(id) {
    const request = this.request(id);
    if (!request) throw Object.assign(new Error(`Unknown request: ${id}`), { code: "not_found" });
    return request;
  }

  assertRevision(request, expected) {
    if (expected != null && request.revision !== Number(expected)) throw new ConflictError();
  }

  assertOwner(request, origin) {
    const wrongStableSession = request.origin_session_id && (
      request.origin_agent_kind !== origin.agentKind || request.origin_session_id !== origin.sessionId
    );
    const wrongLegacyProcess = !request.origin_session_id && (
      request.origin_terminal !== origin.terminal ||
      request.origin_app !== origin.app ||
      request.origin_pid !== origin.pid
    );
    if (wrongStableSession || wrongLegacyProcess) {
      throw Object.assign(new Error("This request belongs to another agent session."), { code: "wrong_owner" });
    }
  }

  beginEnablement({ origin, now = Date.now() }) {
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO pending_enablements(terminal, app, pid, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(terminal) DO UPDATE SET app = excluded.app, pid = excluded.pid, created_at = excluded.created_at
      `).run(origin.terminal, origin.app, origin.pid, now);
      this.nextRevision("session-enabling", null, now);
      return this.db.prepare("SELECT * FROM pending_enablements WHERE terminal = ?").get(origin.terminal);
    });
  }

  cancelEnablement(origin, { now = Date.now() } = {}) {
    return this.transaction(() => {
      const removed = Number(this.db.prepare(
        "DELETE FROM pending_enablements WHERE terminal = ? AND app = ? AND pid = ?",
      ).run(origin.terminal, origin.app, origin.pid).changes);
      if (removed) this.nextRevision("session-enable-cancelled", null, now);
      return removed;
    });
  }

  registerSession({ identity, origin, now = Date.now() }) {
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT * FROM agent_sessions WHERE agent_kind = ? AND session_id = ? AND enabled = 1",
      ).get(identity.agentKind, identity.sessionId);
      const pending = this.db.prepare("SELECT * FROM pending_enablements WHERE terminal = ?").get(origin.terminal);
      if (!existing && (!pending || pending.app !== origin.app || pending.pid !== origin.pid)) {
        throw new ConflictError(
          "Super Agent is disabled for this session. Stop using it unless the user enables it again.",
          "super_agent_disabled",
        );
      }
      this.db.prepare(`
        INSERT INTO agent_sessions(agent_kind, session_id, enabled, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(agent_kind, session_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at
      `).run(identity.agentKind, identity.sessionId, now, now);
      this.db.prepare(`
        INSERT INTO session_bindings(agent_kind, session_id, terminal, app, pid, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_kind, session_id, terminal)
        DO UPDATE SET app = excluded.app, pid = excluded.pid, updated_at = excluded.updated_at
      `).run(identity.agentKind, identity.sessionId, origin.terminal, origin.app, origin.pid, now);
      this.db.prepare(`
        UPDATE requests
        SET origin_agent_kind = ?, origin_session_id = ?
        WHERE origin_session_id IS NULL AND origin_terminal = ? AND origin_app = ? AND origin_pid = ?
      `).run(identity.agentKind, identity.sessionId, origin.terminal, origin.app, origin.pid);
      this.db.prepare("DELETE FROM pending_enablements WHERE terminal = ?").run(origin.terminal);
      this.nextRevision(existing ? "session-rebound" : "session-enabled", null, now);
      return this.db.prepare(`
        SELECT s.*, b.terminal, b.app, b.pid
        FROM agent_sessions s
        JOIN session_bindings b USING(agent_kind, session_id)
        WHERE s.agent_kind = ? AND s.session_id = ? AND b.terminal = ?
      `).get(identity.agentKind, identity.sessionId, origin.terminal);
    });
  }

  adoptLegacySession({ id, identity, origin, now = Date.now() }) {
    return this.transaction(() => {
      const request = this.requireRequest(id);
      if (request.origin_session_id) {
        throw new ConflictError("This request already belongs to another enabled agent session.", "wrong_owner");
      }
      this.assertOwner(request, origin);
      this.db.prepare(`
        INSERT INTO agent_sessions(agent_kind, session_id, enabled, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(agent_kind, session_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at
      `).run(identity.agentKind, identity.sessionId, now, now);
      this.db.prepare(`
        INSERT INTO session_bindings(agent_kind, session_id, terminal, app, pid, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_kind, session_id, terminal)
        DO UPDATE SET app = excluded.app, pid = excluded.pid, updated_at = excluded.updated_at
      `).run(identity.agentKind, identity.sessionId, origin.terminal, origin.app, origin.pid, now);
      this.db.prepare(`
        UPDATE requests
        SET origin_agent_kind = ?, origin_session_id = ?
        WHERE origin_session_id IS NULL AND origin_terminal = ? AND origin_app = ? AND origin_pid = ?
      `).run(identity.agentKind, identity.sessionId, origin.terminal, origin.app, origin.pid);
      this.nextRevision("legacy-session-adopted", null, now);
      return { ...origin, ...identity };
    });
  }

  authorizeSession({ identity, origin, now = Date.now() }) {
    if (!identity) return null;
    return this.transaction(() => {
      const session = this.db.prepare(
        "SELECT * FROM agent_sessions WHERE agent_kind = ? AND session_id = ? AND enabled = 1",
      ).get(identity.agentKind, identity.sessionId);
      if (!session) throw new ConflictError(
        "Super Agent is disabled for this session. Stop using it unless the user enables it again.",
        "super_agent_disabled",
      );
      const binding = this.db.prepare(`
        SELECT * FROM session_bindings
        WHERE agent_kind = ? AND session_id = ? AND terminal = ?
      `).get(identity.agentKind, identity.sessionId, origin.terminal);
      this.db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE agent_kind = ? AND session_id = ?")
        .run(now, identity.agentKind, identity.sessionId);
      this.db.prepare(`
        INSERT INTO session_bindings(agent_kind, session_id, terminal, app, pid, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_kind, session_id, terminal)
        DO UPDATE SET app = excluded.app, pid = excluded.pid, updated_at = excluded.updated_at
      `).run(identity.agentKind, identity.sessionId, origin.terminal, origin.app, origin.pid, now);
      if (!binding || binding.app !== origin.app || binding.pid !== origin.pid) {
        this.nextRevision("session-binding", null, now);
      }
      return { ...origin, ...identity };
    });
  }

  enabledSessionForBinding(origin) {
    return this.db.prepare(`
      SELECT s.*, b.terminal, b.app, b.pid
      FROM agent_sessions s
      JOIN session_bindings b USING(agent_kind, session_id)
      WHERE s.enabled = 1 AND b.terminal = ? AND b.app = ? AND b.pid = ?
    `).get(origin.terminal, origin.app, origin.pid) ?? null;
  }

  disableSession({ origin, now = Date.now() }) {
    return this.transaction(() => {
      const session = this.enabledSessionForBinding(origin);
      if (!session) throw new ConflictError(
        "Super Agent is already disabled for this session.",
        "super_agent_disabled",
      );
      this.db.prepare(`
        UPDATE agent_sessions SET enabled = 0, updated_at = ?
        WHERE agent_kind = ? AND session_id = ?
      `).run(now, session.agent_kind, session.session_id);
      const requests = this.db.prepare(`
        SELECT id FROM requests
        WHERE origin_agent_kind = ? AND origin_session_id = ? AND status != 'resolved'
      `).all(session.agent_kind, session.session_id);
      const retire = this.db.prepare(`
        UPDATE requests
        SET status = 'resolved', unread = 0, revision = ?, updated_at = ?, resolved_at = ?
        WHERE id = ? AND status != 'resolved'
      `);
      let retired = 0;
      for (const request of requests) {
        retired += Number(retire.run(
          this.nextRevision("request-retired", request.id, now),
          now,
          now,
          request.id,
        ).changes);
      }
      this.db.prepare("DELETE FROM pending_enablements WHERE terminal = ?").run(origin.terminal);
      this.nextRevision("session-disabled", null, now);
      return { agentKind: session.agent_kind, sessionId: session.session_id, retired };
    });
  }

  requestsForSession(identity) {
    return this.db.prepare(`
      SELECT * FROM requests
      WHERE origin_agent_kind = ? AND origin_session_id = ?
      ORDER BY updated_at DESC, id
    `).all(identity.agentKind, identity.sessionId);
  }

  rebindRequests({ identity, origin, requests, now = Date.now() }) {
    if (!requests.length) return 0;
    return this.transaction(() => {
      let rebound = 0;
      const update = this.db.prepare(`
        UPDATE requests
        SET origin_terminal = ?, origin_app = ?, origin_pid = ?, revision = ?
        WHERE id = ?
          AND origin_agent_kind = ? AND origin_session_id = ?
          AND origin_terminal = ? AND origin_app = ? AND origin_pid = ?
      `);
      for (const request of requests) {
        const revision = this.nextRevision("request-rebound", request.id, now);
        rebound += Number(update.run(
          origin.terminal,
          origin.app,
          origin.pid,
          revision,
          request.id,
          identity.agentKind,
          identity.sessionId,
          request.origin_terminal,
          request.origin_app,
          request.origin_pid,
        ).changes);
      }
      return rebound;
    });
  }

  createRequest({ origin, title, body, now = Date.now() }) {
    return this.transaction(() => {
      const id = `req_${randomUUID()}`;
      const revision = this.nextRevision("request-created", id, now);
      this.db.prepare(`
        INSERT INTO requests(
          id, origin_terminal, origin_app, origin_pid, origin_agent_kind, origin_session_id,
          title, status, unread, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', 1, ?, ?, ?)
      `).run(
        id,
        origin.terminal,
        origin.app,
        origin.pid,
        origin.agentKind ?? null,
        origin.sessionId ?? null,
        title,
        revision,
        now,
        now,
      );
      const message = this.insertMessage({ requestId: id, author: "agent", kind: "message", body, now });
      this.db.prepare("UPDATE requests SET revision = ? WHERE id = ?").run(message.revision, id);
      return this.request(id);
    });
  }

  insertMessage({ requestId, author, kind = "message", body = "", deliveryStatus = null, draftRevision = null, now = Date.now() }) {
    const id = `msg_${randomUUID()}`;
    const revision = this.nextRevision(`${author}-${kind}`, requestId, now);
    this.db.prepare(`
      INSERT INTO messages(id, request_id, kind, author, body, delivery_status, draft_revision, revision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, requestId, kind, author, body, deliveryStatus, draftRevision, revision, now);
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  }

  appendAgent({ id, origin, body, now = Date.now() }) {
    return this.transaction(() => {
      const request = this.requireRequest(id);
      this.assertOwner(request, origin);
      const message = this.insertMessage({ requestId: id, author: "agent", body, now });
      this.db.prepare(`
        UPDATE requests
        SET status = 'unread', unread = 1, revision = ?, updated_at = ?, resolved_at = NULL
        WHERE id = ?
      `).run(message.revision, now, id);
      return { request: this.request(id), message };
    });
  }

  resolveAgent({ id, origin, now = Date.now() }) {
    return this.transaction(() => {
      const request = this.requireRequest(id);
      this.assertOwner(request, origin);
      const revision = this.nextRevision("agent-resolved", id, now);
      this.db.prepare(`
        UPDATE requests
        SET status = 'resolved', unread = 0, revision = ?, updated_at = ?, resolved_at = ?
        WHERE id = ?
      `).run(revision, now, now, id);
      return this.request(id);
    });
  }

  markRead({ id, expectedRevision, now = Date.now() }) {
    return this.transaction(() => {
      const request = this.requireRequest(id);
      this.assertRevision(request, expectedRevision);
      if (request.status !== "unread") return request;
      const revision = this.nextRevision("human-read", id, now);
      this.db.prepare(`
        UPDATE requests
        SET status = 'waiting-human', unread = 0, revision = ?, updated_at = ?
        WHERE id = ?
      `).run(revision, now, id);
      return this.request(id);
    });
  }

  beginHumanDelivery({ id, kind, body = "", expectedRevision, draftRevision = null, now = Date.now() }) {
    if (kind !== "message" && kind !== "resolve") throw new Error(`Invalid delivery kind: ${kind}`);
    return this.transaction(() => {
      const request = this.requireRequest(id);
      this.assertRevision(request, expectedRevision);
      if (!ACTIVE.has(request.status)) throw new ConflictError("The request is already resolved.");
      const pending = this.db.prepare("SELECT id FROM messages WHERE request_id = ? AND delivery_status = 'pending'").get(id);
      if (pending) throw new ConflictError("A reply is already being delivered.");
      const draft = this.getDraft(id);
      if (draftRevision != null && draft.revision !== Number(draftRevision)) throw new ConflictError("The draft changed before delivery.");
      const message = this.insertMessage({
        requestId: id,
        author: "human",
        kind,
        body,
        deliveryStatus: "pending",
        draftRevision: draftRevision == null ? draft.revision : Number(draftRevision),
        now,
      });
      this.db.prepare("UPDATE requests SET revision = ?, updated_at = ? WHERE id = ?")
        .run(message.revision, now, id);
      return { request: this.request(id), message };
    });
  }

  finishHumanDelivery({ messageId, status, error = null, now = Date.now() }) {
    if (!DELIVERY.has(status) || status === "pending") throw new Error(`Invalid final delivery status: ${status}`);
    return this.transaction(() => {
      const message = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
      if (!message) throw Object.assign(new Error(`Unknown message: ${messageId}`), { code: "not_found" });
      if (message.delivery_status !== "pending") throw new ConflictError("Delivery was already finalized.");
      this.db.prepare("UPDATE messages SET delivery_status = ? WHERE id = ?").run(status, messageId);
      const request = this.requireRequest(message.request_id);
      const revision = this.nextRevision(`delivery-${status}`, request.id, now);
      // A delivered human resolve takes effect at once; the agent can reopen the request
      // with a follow-up. A newer agent message in between wins (revision check).
      if (request.revision === message.revision) {
        if (status === "submitted" && message.kind === "resolve") {
          this.db.prepare(`
            UPDATE requests
            SET status = 'resolved', unread = 0, revision = ?, updated_at = ?, resolved_at = ?
            WHERE id = ? AND revision = ?
          `).run(revision, now, now, request.id, message.revision);
        } else if (status === "submitted") {
          this.db.prepare(`
            UPDATE requests
            SET status = 'waiting-agent', unread = 0, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ?
          `).run(revision, now, request.id, message.revision);
        } else {
          this.db.prepare("UPDATE requests SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
            .run(revision, now, request.id, message.revision);
        }
      }
      // A sent reply was the draft; a resolve leaves any draft alone.
      if (status === "submitted" && message.kind === "message") {
        this.db.prepare("DELETE FROM drafts WHERE request_id = ? AND revision = ?")
          .run(request.id, message.draft_revision ?? 0);
      }
      return { request: this.request(request.id), message: { ...message, delivery_status: status }, error };
    });
  }

  getDraft(id) {
    return this.db.prepare("SELECT * FROM drafts WHERE request_id = ?").get(id) ?? {
      request_id: id,
      body: "",
      revision: 0,
      updated_at: 0,
    };
  }

  setDraft({ id, body, expectedRevision, now = Date.now() }) {
    return this.transaction(() => {
      this.requireRequest(id);
      const draft = this.getDraft(id);
      if (expectedRevision != null && draft.revision !== Number(expectedRevision)) throw new ConflictError("The draft changed; reload it.");
      // Drafts have one writer (the thread terminal) and no other view, so saving one
      // records no logical change and wakes no watcher.
      const revision = draft.revision + 1;
      this.db.prepare(`
        INSERT INTO drafts(request_id, body, revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET body = excluded.body, revision = excluded.revision, updated_at = excluded.updated_at
      `).run(id, body, revision, now);
      return this.getDraft(id);
    });
  }

  claimNotifications({ openRequest = null } = {}) {
    return this.transaction(() => {
      const current = Number(this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM changes").get().revision);
      const previous = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'notification_cursor'").get()?.value ?? 0);
      const rows = this.db.prepare(`
        SELECT m.*, r.title, r.status
        FROM messages m
        JOIN requests r ON r.id = m.request_id
        WHERE m.author = 'agent' AND m.revision > ? AND m.revision <= ?
        ORDER BY m.revision
      `).all(previous, current);
      if (current > previous) {
        this.db.prepare(`
          INSERT INTO metadata(key, value) VALUES ('notification_cursor', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(current));
      }
      return rows.filter((row) => row.request_id !== openRequest && row.status !== "resolved");
    });
  }

  // Hides requests whose origin agent is gone, keeping their history; resolved requests are
  // deleted once they are older than `keepMs`.
  retireRequests(ids, { now = Date.now(), keepMs = 30 * 86400000 } = {}) {
    const result = this.transaction(() => {
      const retire = this.db.prepare(`
        UPDATE requests
        SET status = 'resolved', unread = 0, revision = ?, updated_at = ?, resolved_at = ?
        WHERE id = ? AND status != 'resolved'
      `);
      let retired = 0;
      for (const id of ids) {
        if (this.request(id)?.status === "resolved") continue;
        retired += Number(retire.run(this.nextRevision("request-retired", id, now), now, now, id).changes);
      }
      const expired = this.db.prepare("SELECT id FROM requests WHERE status = 'resolved' AND resolved_at < ?")
        .all(now - keepMs).map((row) => row.id);
      const removed = Number(this.db.prepare("DELETE FROM requests WHERE status = 'resolved' AND resolved_at < ?")
        .run(now - keepMs).changes);
      if (removed) this.nextRevision("requests-removed", null, now);
      return { retired, removed, expired };
    });
    // Pasted images go with their request; a failed removal is retried next time.
    const attachments = join(dirname(this.path), "attachments");
    for (const id of result.expired) rmSync(join(attachments, id), { recursive: true, force: true });
    const { expired: _expired, ...counts } = result;
    return counts;
  }

  reconcilePending({ olderThanMs = 60000, now = Date.now() } = {}) {
    const candidates = this.db.prepare(`
      SELECT id FROM messages
      WHERE delivery_status = 'pending' AND created_at <= ?
    `).all(now - olderThanMs);
    if (!candidates.length) return 0;
    return this.transaction(() => {
      let reconciled = 0;
      for (const message of candidates) {
        if (this.finishPendingInsideTransaction(message.id, "unknown", now)) reconciled += 1;
      }
      return reconciled;
    });
  }

  finishPendingInsideTransaction(messageId, status, now) {
    const message = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    if (!message || message.delivery_status !== "pending") return false;
    this.db.prepare("UPDATE messages SET delivery_status = ? WHERE id = ?").run(status, messageId);
    const request = this.requireRequest(message.request_id);
    const revision = this.nextRevision(`delivery-${status}`, request.id, now);
    if (request.revision === message.revision) {
      this.db.prepare("UPDATE requests SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(revision, now, request.id, message.revision);
    }
    return true;
  }

  // One request with its messages and draft, read consistently.
  thread(id) {
    return this.readTransaction(() => {
      const request = this.request(id);
      if (!request) return null;
      const messages = this.db.prepare("SELECT * FROM messages WHERE request_id = ? ORDER BY revision, id").all(id);
      return { ...request, messages, draft: this.getDraft(id) };
    });
  }

  snapshot() {
    return this.readTransaction(() => {
      const requests = this.db.prepare("SELECT * FROM requests ORDER BY updated_at DESC, id").all();
      const messages = this.db.prepare("SELECT * FROM messages ORDER BY revision, id").all();
      const drafts = this.db.prepare("SELECT * FROM drafts ORDER BY request_id").all();
      const sessions = this.db.prepare(`
        SELECT s.agent_kind, s.session_id, s.enabled, s.created_at, s.updated_at,
               b.terminal, b.app, b.pid, b.updated_at AS binding_updated_at
        FROM agent_sessions s
        JOIN session_bindings b USING(agent_kind, session_id)
        ORDER BY s.agent_kind, s.session_id, b.terminal
      `).all();
      const pendingEnablements = this.db.prepare(
        "SELECT * FROM pending_enablements ORDER BY created_at, terminal",
      ).all();
      const revision = Number(this.db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM changes").get().revision);
      const grouped = new Map(requests.map((request) => [request.id, { ...request, messages: [], draft: null }]));
      for (const message of messages) grouped.get(message.request_id)?.messages.push(message);
      for (const draft of drafts) if (grouped.has(draft.request_id)) grouped.get(draft.request_id).draft = draft;
      return { revision, requests: [...grouped.values()], sessions, pendingEnablements };
    });
  }
}
