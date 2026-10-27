// Evidence for the connection experiments, computed from the meeting record
// (never from what an AI says about itself).

import { DISPLAY_NAMES } from "./presets.js";

// What delivery route did the server observe? A wait call, browser request,
// or successful notification does not prove that no person resumed the AI or
// approved its action. `automatic` is therefore unknown (null), except when
// the server positively observed a manual wake-up (false).
export function classifyWake(req) {
  if (!req || !req.firstDeliveredAt) return null;
  const before = req.triggers.filter((t) => t.at <= req.firstDeliveredAt);
  const last = before[before.length - 1];
  if (before.some((t) => t.manual)) return { code: "manual", automatic: false, label: "手動通知の操作あり（パネルの手動通知ボタン）" };
  if (req.deliveredVia === "wait") return { code: "wait", automatic: null, label: "wait_for_my_turn で取得（手動再開・承認の有無は未確認）" };
  if (req.deliveredVia === "web") return { code: "web", automatic: null, label: "参加者ページで取得（操作者・送信承認の有無は未確認）" };
  if (last?.result === "sent" && last.channel === "mcp_events") return { code: "events", automatic: null, label: "MCP Events 通知送信後に取得（自動再起動は未確認）" };
  if (last?.result === "sent" && last.channel === "panel") return { code: "panel", automatic: null, label: "MCP App パネル通知送信後に取得（自動再起動は未確認）" };
  const detail = last ? `通知結果: ${last.result || "未確認"}` : "通知記録なし";
  return { code: "unknown", automatic: null, label: `${detail}で get_my_turn（起動経路は未確認）` };
}

function autonomyFor(requests) {
  const assisted = requests.some((req) => req.triggers.some((t) => t.manual));
  return {
    status: assisted ? "assisted" : "unverified",
    reason: assisted
      ? "試験中の手動通知を記録しています。"
      : "サーバーの配送記録だけでは、各社画面での手動再開や承認の有無を確認できません。",
  };
}

const norm = (s) => String(s || "").replace(/\s+/g, "");

// Does `text` quote (in 「」/『』/“”) at least 6 characters that appear
// verbatim in `prevText`? A cheap, checkable signal that the answer used the
// previous speaker's content; a person still has to read the substance.
export function quoteCheck(text, prevText) {
  const quotes = [...String(text || "").matchAll(/[「『“"]([^」』”"]{6,200})[」』”"]/g)].map((m) => m[1]);
  const p = norm(prevText);
  const hits = quotes.filter((q) => p.includes(norm(q)));
  return { quotes: quotes.length, matched: hits.length, sample: hits[0] || null };
}

export function probeReport(m) {
  const runs = m.runOrder.map((id) => m.runs[id]).filter((r) => r.kind === "probe");
  return runs.map((run) => {
    const reqs = m.requestOrder.map((id) => m.requests[id]).filter((r) => r.runId === run.id);
    const row = (req, code) => {
      if (!req) return null;
      const msg = req.messageId ? m.messages.find((x) => x.id === req.messageId) : null;
      return {
        requestId: req.id,
        createdAt: req.createdAt,
        firstDeliveredAt: req.firstDeliveredAt,
        deliveredVia: req.deliveredVia,
        deliveries: req.deliveries,
        triggers: req.triggers,
        status: req.status,
        closeReason: req.closeReason,
        answeredAt: msg?.at ?? null,
        codeFound: msg ? msg.text.includes(code) : false,
        text: msg?.text ?? null,
      };
    };
    const a = reqs.find((r) => r.phase === "接続試験A");
    const b = reqs.find((r) => r.phase === "接続試験B");
    const ra = row(a, run.probe.codeA);
    const rb = row(b, run.probe.codeB);
    const wake = classifyWake(b);
    const roundTripPassed = !!(ra?.codeFound && ra.status === "answered" && rb?.codeFound && rb.status === "answered");
    const autonomy = autonomyFor(reqs);
    return {
      runId: run.id,
      participant: run.probe.participant,
      delaySec: run.probe.delaySec,
      wakeSetting: run.probe.wake || null,
      state: run.state,
      reason: run.reason,
      startedAt: run.startedAt,
      A: ra,
      B: rb,
      waitedSec: ra?.answeredAt && rb?.firstDeliveredAt ? Math.round((rb.firstDeliveredAt - ra.answeredAt) / 1000) : null,
      wakeRoute: wake?.label || null,
      wakeCode: wake?.code || null,
      passed: roundTripPassed,
      roundTripPassed,
      // Compatibility field: never promote transport observations to proof
      // of an unattended run. Run-scoped real-service evidence is not yet
      // recorded by this application.
      passedAutomatically: autonomy.status === "assisted" ? false : null,
      autonomy,
    };
  });
}

// One row per request of an auto run: who spoke, how they were woken, and
// whether they quoted the previous AI speaker.
export function chainReport(m, runId) {
  const run = runId ? m.runs[runId] : [...m.runOrder].reverse().map((id) => m.runs[id]).find((r) => r.kind === "auto");
  if (!run) return null;
  const reqs = m.requestOrder.map((id) => m.requests[id]).filter((r) => r.runId === run.id);
  const accepted = m.messages.filter((x) => x.status === "accepted");
  const rows = reqs.map((req) => {
    const msg = req.messageId ? m.messages.find((x) => x.id === req.messageId) : null;
    const prev = msg ? [...accepted].reverse().find((x) => x.seq < msg.seq && x.speaker !== "chair") : null;
    const wake = classifyWake(req);
    return {
      requestId: req.id,
      participant: req.participant,
      name: DISPLAY_NAMES[req.participant],
      phase: req.phase,
      status: req.status,
      closeReason: req.closeReason,
      seq: msg?.seq ?? null,
      wakeCode: wake?.code || null,
      wakeRoute: wake?.label || null,
      automatic: wake?.automatic ?? null,
      deliveries: req.deliveries,
      prevSeq: prev?.seq ?? null,
      prevSpeaker: prev?.speaker ?? null,
      quote: msg && prev ? quoteCheck(msg.text, prev.text) : null,
      lateMessages: req.lateMessageIds.length,
    };
  });
  const answered = rows.filter((r) => r.status === "answered");
  return {
    runId: run.id,
    state: run.state,
    reason: run.reason,
    limits: run.limits,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    answered: answered.length,
    automaticAnswered: null,
    routeObservedAnswered: answered.filter((r) => r.wakeCode && r.wakeCode !== "unknown").length,
    assistedAnswered: answered.filter((r) => r.automatic === false).length,
    autonomy: autonomyFor(reqs),
    quotedPrevious: answered.filter((r) => r.quote && r.quote.matched > 0).length,
    rows,
  };
}
