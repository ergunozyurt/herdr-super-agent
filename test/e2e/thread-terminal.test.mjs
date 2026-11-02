import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./helpers.mjs";

const enabled = process.env.SUPER_AGENT_E2E === "1";

test("real thread terminal renders the request history", { skip: !enabled }, async () => {
  const fixture = await createFixture();
  try {
    const request = fixture.ask({ title: "Deploy target", body: "Staging or production" });
    const terminal = fixture.startThread(request);
    const screen = await fixture.waitForScreen(terminal, /Deploy target[\s\S]*Staging or production/);
    assert.match(screen, /From Test Agent/);
  } finally {
    await fixture.cleanup();
  }
});

test("real terminal delivers a multi-line reply and Esc preserves its draft", { skip: !enabled }, async () => {
  const fixture = await createFixture();
  try {
    const request = fixture.ask({ title: "Deploy target", body: "Choose one" });
    const terminal = fixture.startThread(request);
    await fixture.waitForScreen(terminal, /Choose one/);

    fixture.typeText(terminal, "staging\nfor now");
    fixture.keys(terminal, "enter");

    const sent = await fixture.waitForSent(1);
    assert.match(sent[0].at(-1), /^\[super-agent reply request=req_.* message=msg_.*\]\nstaging\nfor now$/);
    await fixture.waitForSnapshot((snapshot) => snapshot.requests[0]?.status === "waiting-agent");

    fixture.typeText(terminal, "half answer");
    await fixture.waitForSnapshot((snapshot) => snapshot.requests[0]?.draft?.body === "half answer");
    fixture.keys(terminal, "esc");

    assert.equal(fixture.terminal(terminal).state, "live");
    assert.equal(fixture.snapshot().requests[0].draft.body, "half answer");
  } finally {
    await fixture.cleanup();
  }
});

test("failed delivery restores text in the real terminal", { skip: !enabled }, async () => {
  const fixture = await createFixture();
  try {
    const request = fixture.ask({ title: "Deploy target", body: "Choose one" });
    const terminal = fixture.startThread(request);
    await fixture.waitForScreen(terminal, /Choose one/);
    fixture.failDelivery("test delivery refusal");

    fixture.typeText(terminal, "production");
    fixture.keys(terminal, "enter");

    const screen = await fixture.waitForScreen(terminal, /test delivery refusal/);
    assert.match(screen, /Not delivered/);
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.requests[0].status, "unread");
    assert.equal(snapshot.requests[0].draft.body, "production");
  } finally {
    await fixture.cleanup();
  }
});

test("agent follow-up preserves a real-terminal draft and agent resolve ends it", { skip: !enabled }, async () => {
  const fixture = await createFixture();
  try {
    const request = fixture.ask({ title: "Deploy target", body: "Choose one" });
    const terminal = fixture.startThread(request);
    await fixture.waitForScreen(terminal, /Choose one/);

    fixture.typeText(terminal, "draft answer");
    await fixture.waitForSnapshot((snapshot) => snapshot.requests[0]?.draft?.body === "draft answer");
    fixture.append(request, "one more detail");

    await fixture.waitForScreen(terminal, /one more detail/);
    assert.equal(fixture.snapshot().requests[0].draft.body, "draft answer");

    fixture.resolve(request);
    await fixture.waitForTerminalEnd(terminal);
    assert.equal(fixture.snapshot().requests[0].status, "resolved");
  } finally {
    await fixture.cleanup();
  }
});

test("person resolve is delivered and ends the real thread terminal", { skip: !enabled }, async () => {
  const fixture = await createFixture();
  try {
    const request = fixture.ask({ title: "Deploy target", body: "Choose one" });
    const terminal = fixture.startThread(request);
    await fixture.waitForScreen(terminal, /Choose one/);

    fixture.typeText(terminal, "/resolve");
    fixture.keys(terminal, "enter");

    const sent = await fixture.waitForSent(1);
    assert.match(sent[0].at(-1), new RegExp(`^\\[super-agent resolved request=${request} message=msg_`));
    await fixture.waitForTerminalEnd(terminal);
    assert.equal(fixture.snapshot().requests[0].status, "resolved");
  } finally {
    await fixture.cleanup();
  }
});

test("a real terminal width change reprints one clean transcript", { skip: !enabled }, async () => {
  const fixture = await createFixture();
  try {
    const request = fixture.ask({ title: "Unique resize title", body: "Unique resize body" });
    const terminal = fixture.startThread(request);
    await fixture.waitForScreen(terminal, /Unique resize body/);

    const screen = fixture.readAtSize(terminal, { columns: 40, rows: 20 });
    assert.equal(screen.match(/Unique resize title/g)?.length, 1);
    assert.equal(screen.match(/Unique resize body/g)?.length, 1);
  } finally {
    await fixture.cleanup();
  }
});
