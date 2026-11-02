import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ConflictError, InboxStore } from "../mods/super-agent/lib/store.mjs";

const owner = { terminal: "t1", app: "pi", pid: 101 };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-"));
  const store = new InboxStore(join(dir, "inbox.sqlite"));
  return {
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("enabling a stable Pi session adopts legacy requests and authorizes later commands", () => {
  const f = fixture();
  try {
    const legacy = f.store.createRequest({ origin: owner, title: "Legacy", body: "Before upgrade", now: 1 });
    const identity = { agentKind: "pi", sessionId: "pi-session-1" };
    f.store.beginEnablement({ origin: owner, now: 2 });
    const session = f.store.registerSession({ identity, origin: owner, now: 3 });
    assert.equal(session.enabled, 1);

    const adopted = f.store.request(legacy.id);
    assert.equal(adopted.origin_agent_kind, "pi");
    assert.equal(adopted.origin_session_id, "pi-session-1");

    const resumed = { terminal: "t2", app: "pi", pid: 202 };
    const authorized = f.store.authorizeSession({ identity, origin: resumed, now: 4 });
    const followed = f.store.appendAgent({ id: legacy.id, origin: authorized, body: "After resume", now: 5 });
    assert.equal(followed.request.status, "unread");

    assert.throws(
      () => f.store.appendAgent({
        id: legacy.id,
        origin: { ...resumed, agentKind: "pi", sessionId: "another-session" },
        body: "Wrong session",
        now: 6,
      }),
      (error) => error.code === "wrong_owner",
    );
  } finally {
    f.close();
  }
});

test("request lifecycle supports read, reply, follow-up, and resolution", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Deploy?", body: "Choose a target", now: 1 });
    assert.equal(created.status, "unread");
    assert.equal(created.unread, 1);

    const read = f.store.markRead({ id: created.id, expectedRevision: created.revision, now: 2 });
    assert.equal(read.status, "waiting-human");

    const pending = f.store.beginHumanDelivery({
      id: created.id,
      kind: "message",
      body: "Staging",
      expectedRevision: read.revision,
      now: 3,
    });
    assert.equal(pending.message.delivery_status, "pending");
    assert.equal(f.store.request(created.id).status, "waiting-human");

    const submitted = f.store.finishHumanDelivery({ messageId: pending.message.id, status: "submitted", now: 4 });
    assert.equal(submitted.request.status, "waiting-agent");

    const followed = f.store.appendAgent({ id: created.id, origin: owner, body: "Which region?", now: 5 });
    assert.equal(followed.request.status, "unread");
    assert.equal(followed.request.unread, 1);

    const resolved = f.store.resolveAgent({ id: created.id, origin: owner, now: 6 });
    assert.equal(resolved.status, "resolved");
  } finally {
    f.close();
  }
});

test("a human resolve takes effect and the agent can reopen it", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    const pending = f.store.beginHumanDelivery({
      id: created.id,
      kind: "resolve",
      expectedRevision: created.revision,
      now: 2,
    });
    const resolved = f.store.finishHumanDelivery({ messageId: pending.message.id, status: "submitted", now: 3 });
    assert.equal(resolved.request.status, "resolved");

    const reopened = f.store.appendAgent({ id: created.id, origin: owner, body: "I still need one detail", now: 4 });
    assert.equal(reopened.request.status, "unread");
    assert.equal(reopened.request.resolved_at, null);
  } finally {
    f.close();
  }
});

test("stale UI revisions are rejected", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    f.store.appendAgent({ id: created.id, origin: owner, body: "Update", now: 2 });
    assert.throws(
      () => f.store.markRead({ id: created.id, expectedRevision: created.revision, now: 3 }),
      (error) => error instanceof ConflictError,
    );
  } finally {
    f.close();
  }
});

test("agent commands are fenced by app and foreground pid", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    assert.throws(
      () => f.store.appendAgent({ id: created.id, origin: { ...owner, pid: 202 }, body: "Wrong session", now: 2 }),
      (error) => error.code === "wrong_owner",
    );
  } finally {
    f.close();
  }
});

test("failed delivery preserves state and draft", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    f.store.setDraft({ id: created.id, body: "Partial answer", expectedRevision: 0, now: 2 });
    const pending = f.store.beginHumanDelivery({
      id: created.id,
      kind: "message",
      body: "Partial answer",
      expectedRevision: created.revision,
      now: 3,
    });
    f.store.finishHumanDelivery({ messageId: pending.message.id, status: "failed", now: 4 });
    assert.equal(f.store.request(created.id).status, "unread");
    assert.equal(f.store.getDraft(created.id).body, "Partial answer");
  } finally {
    f.close();
  }
});

test("delivery reservation rejects a second stale reply", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    f.store.beginHumanDelivery({ id: created.id, kind: "message", body: "First", expectedRevision: created.revision, now: 2 });
    assert.throws(
      () => f.store.beginHumanDelivery({ id: created.id, kind: "message", body: "Second", expectedRevision: created.revision, now: 3 }),
      (error) => error instanceof ConflictError,
    );
  } finally {
    f.close();
  }
});

test("delivery finalization does not overwrite a newer agent follow-up", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    const pending = f.store.beginHumanDelivery({ id: created.id, kind: "message", body: "Answer", expectedRevision: created.revision, now: 2 });
    f.store.appendAgent({ id: created.id, origin: owner, body: "Newer follow-up", now: 3 });
    const finished = f.store.finishHumanDelivery({ messageId: pending.message.id, status: "submitted", now: 4 });
    assert.equal(finished.request.status, "unread");
    assert.equal(finished.request.unread, 1);
  } finally {
    f.close();
  }
});

test("submitted delivery preserves a draft edited after reservation", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    const firstDraft = f.store.setDraft({ id: created.id, body: "Answer", expectedRevision: 0, now: 2 });
    const pending = f.store.beginHumanDelivery({ id: created.id, kind: "message", body: "Answer", expectedRevision: created.revision, now: 3 });
    f.store.setDraft({ id: created.id, body: "New text", expectedRevision: firstDraft.revision, now: 4 });
    f.store.finishHumanDelivery({ messageId: pending.message.id, status: "submitted", now: 5 });
    assert.equal(f.store.getDraft(created.id).body, "New text");
  } finally {
    f.close();
  }
});

test("notification claims are atomic and exclude the open request", () => {
  const f = fixture();
  try {
    const first = f.store.createRequest({ origin: owner, title: "One", body: "First", now: 1 });
    const second = f.store.createRequest({ origin: owner, title: "Two", body: "Second", now: 2 });
    const claimed = f.store.claimNotifications({ openRequest: first.id });
    assert.deepEqual(claimed.map((row) => row.request_id), [second.id]);
    assert.deepEqual(f.store.claimNotifications(), []);
  } finally {
    f.close();
  }
});

test("draft saves do not publish a logical change", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    const before = f.store.currentRevision();
    f.store.setDraft({ id: created.id, body: "typing", now: 2 });
    assert.equal(f.store.currentRevision(), before);
    assert.equal(f.store.thread(created.id).draft.body, "typing");
  } finally {
    f.close();
  }
});

test("retiring hides requests but keeps history until it is old", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    assert.deepEqual(f.store.retireRequests([created.id], { now: 10, keepMs: 100 }), { retired: 1, removed: 0 });
    const kept = f.store.thread(created.id);
    assert.equal(kept.status, "resolved");
    assert.equal(kept.messages.length, 1);
    assert.deepEqual(f.store.retireRequests([], { now: 200, keepMs: 100 }), { retired: 0, removed: 1 });
    assert.equal(f.store.thread(created.id), null);
  } finally {
    f.close();
  }
});

test("a human resolve leaves the draft alone", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    f.store.setDraft({ id: created.id, body: "half-written reply", now: 2 });
    const pending = f.store.beginHumanDelivery({ id: created.id, kind: "resolve", expectedRevision: null, now: 3 });
    f.store.finishHumanDelivery({ messageId: pending.message.id, status: "submitted", now: 4 });
    assert.equal(f.store.getDraft(created.id).body, "half-written reply");
  } finally {
    f.close();
  }
});

test("a human resolve that fails to reach the agent leaves the request open", () => {
  const f = fixture();
  try {
    const created = f.store.createRequest({ origin: owner, title: "Question", body: "Need input", now: 1 });
    const pending = f.store.beginHumanDelivery({ id: created.id, kind: "resolve", expectedRevision: null, now: 2 });
    const failed = f.store.finishHumanDelivery({ messageId: pending.message.id, status: "failed", now: 3 });
    assert.equal(failed.request.status, "unread");
  } finally {
    f.close();
  }
});
