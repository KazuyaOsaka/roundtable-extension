import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeRt, newMeeting } from "./helpers.js";
import { classifyWake } from "../src/core/report.js";

test("delivery routes are observations, not proof of unattended operation", () => {
  for (const deliveredVia of ["wait", "web"]) {
    const result = classifyWake({ firstDeliveredAt: 2000, deliveredVia, triggers: [] });
    assert.equal(result.code, deliveredVia);
    assert.equal(result.automatic, null);
  }
  for (const channel of ["panel", "mcp_events"]) {
    const result = classifyWake({
      firstDeliveredAt: 2000,
      deliveredVia: "get",
      triggers: [{ at: 1000, channel, manual: false, result: "sent" }],
    });
    assert.equal(result.code, channel === "panel" ? "panel" : "events");
    assert.equal(result.automatic, null);
    assert.doesNotMatch(result.label, /処理終了後/);
  }
});

test("failed or unconfirmed notifications are not attributed as successful wake routes", () => {
  for (const channel of ["panel", "mcp_events"]) {
    for (const result of ["rejected", "failed", "unknown", null]) {
      const wake = classifyWake({
        firstDeliveredAt: 2000,
        deliveredVia: "get",
        triggers: [{ at: 1000, channel, manual: false, result }],
      });
      assert.equal(wake.code, "unknown");
      assert.equal(wake.automatic, null);
    }
  }
});

test("a manual wake stays assisted even if delivery later uses wait or web", () => {
  for (const deliveredVia of ["get", "wait", "web"]) {
    const wake = classifyWake({
      firstDeliveredAt: 3000,
      deliveredVia,
      triggers: [
        { at: 1000, channel: "panel", manual: true, result: "rejected" },
        { at: 2000, channel: "panel", manual: false, result: "sent" },
      ],
    });
    assert.equal(wake.code, "manual");
    assert.equal(wake.automatic, false);
  }
});

test("a completed probe after a rejected panel notification is only a round-trip success", (t) => {
  const { rt, store, dir } = makeRt();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const m = newMeeting(rt, { settings: { triggerGraceSec: 0 } });
  rt.startProbe({ participant: "claude", delaySec: 0, wake: { wait: false, panel: true, events: false } });
  const a = rt.deliver("claude", "get");
  rt.post("claude", { requestId: a.request.id, text: `5 ${a.text.match(/ALPHA-[0-9A-F]{4}/)[0]}` });
  const bRequest = m.requests[m.requestOrder.at(-1)];
  assert.equal(rt.claimTrigger("claude", { requestId: bRequest.id, instanceId: "panel" }).granted, true);
  rt.triggerResult("claude", { requestId: bRequest.id, instanceId: "panel", result: "rejected" });
  // This get can be caused by a person typing "continue" in the AI service.
  const b = rt.deliver("claude", "get");
  rt.post("claude", { requestId: b.request.id, text: `6 ${b.text.match(/BRAVO-[0-9A-F]{4}/)[0]}` });
  rt.recordObservation("claude", { humanActions: "なし", confirmations: "0" });
  const report = rt.probeReport()[0];
  assert.equal(report.passed, true);
  assert.equal(report.roundTripPassed, true);
  assert.equal(report.wakeCode, "unknown");
  assert.equal(report.passedAutomatically, null);
  assert.equal(report.autonomy.status, "unverified", "participant-level prose must not certify this run");
});

test("chain reports count observed routes separately from unattended success", (t) => {
  const { rt, store, dir } = makeRt();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  newMeeting(rt);
  rt.startAuto({ maxTurns: 3 });
  for (const [participant, via] of [["gemini", "web"], ["chatgpt", "get"], ["claude", "wait"]]) {
    const d = rt.deliver(participant, via);
    rt.post(participant, { requestId: d.request.id, text: `${participant} response` });
  }
  const report = rt.chainReport();
  assert.equal(report.answered, 3);
  assert.equal(report.routeObservedAnswered, 2);
  assert.equal(report.automaticAnswered, null);
  assert.equal(report.assistedAnswered, 0);
  assert.equal(report.autonomy.status, "unverified");
  assert.ok(report.rows.every((row) => row.automatic === null));
});
