import test from "node:test";
import assert from "node:assert/strict";
import { makeRt, newMeeting, reload } from "./helpers.js";

test("durable accepted response recovers atomically before the sender receives an acknowledgement", () => {
  const { rt, dir, clock } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ maxTurns: 3 });
  const d = rt.deliver("gemini", "get");
  const append = rt.store.append.bind(rt.store);
  rt.store.append = (id, event) => {
    append(id, event);
    if (event.type === "message_posted" && event.data.status === "accepted") {
      throw new Error("crash after the accepted event reached disk");
    }
  };
  assert.throws(() => rt.post("gemini", { requestId: d.request.id, text: "durable answer" }), /crash/);
  rt.store.close();

  const recovered = reload(dir, clock);
  assert.equal(recovered.active.requests[d.request.id].status, "answered");
  assert.equal(recovered._run(recovered.active).accepted, 1);
  assert.equal(recovered.post("gemini", { requestId: d.request.id, text: "durable answer" }).status, "duplicate");
  assert.equal(recovered.active.messages.filter((x) => x.text === "durable answer").length, 1);
  assert.equal(recovered.deliver("gemini", "get").status, "not_your_turn");
  assert.equal(recovered.deliver("chatgpt", "get").status, "your_turn");
  recovered.store.close();

  const twice = reload(dir, clock);
  assert.equal(twice._run(twice.active).accepted, 1);
  assert.equal(twice.active.messages.filter((x) => x.text === "durable answer").length, 1);
  twice.store.close();
});

test("parallel recovery keeps the accepted participant done and preserves outstanding peer requests", () => {
  const { rt, dir, clock } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ presetId: "theory", maxTurns: 12 });
  const turns = Object.fromEntries(["gemini", "chatgpt", "claude"].map((id) => [id, rt.deliver(id, "get")]));
  const append = rt.store.append.bind(rt.store);
  rt.store.append = (id, event) => {
    append(id, event);
    if (event.type === "message_posted" && event.data.status === "accepted") throw new Error("crash");
  };
  assert.throws(() => rt.post("gemini", { requestId: turns.gemini.request.id, text: "independent answer" }), /crash/);
  rt.store.close();

  const recovered = reload(dir, clock);
  assert.deepEqual(recovered._run(recovered.active).stepDone, ["gemini"]);
  assert.equal(recovered.active.requestOrder.length, 3, "no replacement for the already accepted participant");
  for (const id of ["chatgpt", "claude"]) {
    const d = recovered.deliver(id, "get");
    assert.equal(d.request.id, turns[id].request.id);
    assert.doesNotMatch(d.text, /independent answer/);
    recovered.post(id, { requestId: d.request.id, text: `${id} answer` });
  }
  assert.equal(recovered._run(recovered.active).accepted, 3);
  assert.equal(recovered.deliver("gemini", "get").request.phase, "相互批判");
  recovered.store.close();
});

for (const tail of ["message", "closed", "progress"]) {
  test(`legacy response log ending after ${tail} resumes at the next participant`, () => {
    const { rt, dir, clock } = makeRt();
    const m = newMeeting(rt);
    rt.startAuto({ maxTurns: 3 });
    const d = rt.deliver("gemini", "get");
    const seq = m.nextSeq;
    const messageId = `${m.id}-${String(seq).padStart(4, "0")}`;
    let n = m.eventCount;
    const append = (type, data) => rt.store.append(m.id, { n: ++n, at: clock(), actor: "gemini", type, data });
    append("message_posted", {
      id: messageId, seq, speaker: "gemini", text: "legacy answer", status: "accepted",
      requestId: d.request.id, runId: d.request.runId,
      premiseVersion: d.request.premiseVersion, roleVersion: d.request.roleVersion,
    });
    if (tail !== "message") append("request_closed", { id: d.request.id, status: "answered", reason: null, messageId });
    if (tail === "progress") append("run_progress", { runId: d.request.runId, stepPos: 1 });
    rt.store.close();

    const recovered = reload(dir, clock);
    assert.equal(recovered.active.requests[d.request.id].status, "answered");
    assert.equal(recovered._run(recovered.active).accepted, 1);
    assert.equal(recovered.deliver("gemini", "get").status, "not_your_turn");
    assert.equal(recovered.deliver("chatgpt", "get").status, "your_turn");
    assert.equal(recovered.deliver("claude", "get").status, "not_your_turn");
    recovered.store.close();
  });
}

test("a stale skip cannot complete a replacement request or skip the following participant", () => {
  const { rt } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ maxTurns: 3 });
  const old = rt.deliver("gemini", "get");
  rt.chairPost({ text: "new premise" });
  rt.resume();
  const fresh = rt.deliver("gemini", "get");
  assert.notEqual(fresh.request.id, old.request.id);
  assert.throws(() => rt.skip(old.request.id), (e) => e.code === "bad_state");
  assert.equal(rt._run(m).stepPos, 0);
  rt.post("gemini", { requestId: fresh.request.id, text: "fresh answer" });
  assert.equal(rt.deliver("chatgpt", "get").status, "your_turn");
  assert.equal(rt.deliver("claude", "get").status, "not_your_turn");
  rt.store.close();
});

for (const offset of [0, 1]) {
  test(`post enforces the request deadline synchronously at deadline + ${offset}ms`, () => {
    const { rt, clock } = makeRt();
    const m = newMeeting(rt);
    rt.startAuto({ maxTurns: 3 });
    const d = rt.deliver("gemini", "get");
    clock.advance(m.settings.requestTimeoutSec * 1000 + offset);
    const result = rt.post("gemini", { requestId: d.request.id, text: "late answer" });
    assert.equal(result.status, "late");
    assert.equal(result.forwarded, false);
    assert.equal(rt._run(m).accepted, 0);
    assert.equal(rt._run(m).state, "paused");
    assert.equal(rt.deliver("chatgpt", "get").status, "not_your_turn");
    rt.store.close();
  });
}

test("expired undelivered work is not handed out before the periodic tick", () => {
  const { rt, clock } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ maxTurns: 3 });
  clock.advance(m.settings.requestTimeoutSec * 1000);
  assert.equal(rt.deliver("gemini", "get").status, "not_your_turn");
  assert.equal(rt._run(m).state, "paused");
  assert.equal(m.requests[m.requestOrder[0]].deliveries, 0);
  rt.store.close();
});

test("expired requests cannot claim panel or event wake-ups between ticks", () => {
  for (const channel of ["panel", "events"]) {
    const { rt, clock } = makeRt();
    const m = newMeeting(rt, { settings: { triggerGraceSec: 0, wake: { gemini: { panel: true, events: true } } } });
    rt.chairPost({ text: "Q", ask: "gemini" });
    const requestId = m.requestOrder[0];
    clock.advance(m.settings.requestTimeoutSec * 1000);
    const granted = channel === "panel"
      ? rt.claimTrigger("gemini", { requestId, instanceId: "panel-1" }).granted
      : rt.claimPushWake("gemini", requestId, "event-1");
    assert.equal(granted, false);
    assert.equal(m.requests[requestId].triggers.length, 0);
    rt.store.close();
  }
});

test("stop remains stopped after a crash at its first durable event, including parallel requests", () => {
  const { rt, dir, clock } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ presetId: "theory", maxTurns: 12 });
  const count = m.requestOrder.length;
  const append = rt.store.append.bind(rt.store);
  rt.store.append = (id, event) => {
    append(id, event);
    throw new Error("crash at stop commit");
  };
  assert.throws(() => rt.stop(), /crash/);
  rt.store.close();
  const recovered = reload(dir, clock);
  assert.equal(recovered._run(recovered.active).state, "stopped");
  assert.equal(recovered.active.requestOrder.length, count);
  assert.ok(Object.values(recovered.active.requests).every((r) => r.status === "cancelled"));
  for (const id of ["gemini", "chatgpt", "claude"]) assert.equal(recovered.deliver(id, "get").status, "not_your_turn");
  recovered.store.close();
});

test("a durable skip advances the turn even if its follow-up processing never ran", () => {
  const { rt, dir, clock } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ maxTurns: 3 });
  const requestId = m.requestOrder[0];
  const append = rt.store.append.bind(rt.store);
  rt.store.append = (id, event) => {
    append(id, event);
    if (event.type === "request_closed") throw new Error("crash after skip");
  };
  assert.throws(() => rt.skip(requestId), /crash/);
  rt.store.close();
  const recovered = reload(dir, clock);
  assert.equal(recovered.active.requests[requestId].status, "skipped");
  assert.equal(recovered._run(recovered.active).accepted, 0);
  assert.equal(recovered.deliver("gemini", "get").status, "not_your_turn");
  assert.equal(recovered.deliver("chatgpt", "get").status, "your_turn");
  recovered.store.close();
});

for (const status of ["expired", "failed"]) {
  test(`a durable ${status} request cannot be retried automatically on restart`, () => {
    const { rt, dir, clock } = makeRt();
    const m = newMeeting(rt);
    rt.startAuto({ maxTurns: 3 });
    const requestId = m.requestOrder[0];
    const append = rt.store.append.bind(rt.store);
    rt.store.append = (id, event) => {
      append(id, event);
      if (event.type === "request_closed") throw new Error("crash after request closure");
    };
    if (status === "expired") {
      clock.advance(m.settings.requestTimeoutSec * 1000);
      assert.throws(() => rt.tick(), /crash/);
    } else {
      assert.throws(() => rt.reportProblem("gemini", { requestId, kind: "usage_limit" }), /crash/);
    }
    rt.store.close();
    const recovered = reload(dir, clock);
    assert.equal(recovered.active.requests[requestId].status, status);
    assert.equal(recovered._run(recovered.active).state, "paused");
    assert.equal(recovered.active.requestOrder.length, 1);
    assert.equal(recovered.deliver("gemini", "get").status, "not_your_turn");
    recovered.store.close();
  });
}
