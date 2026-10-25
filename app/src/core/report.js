// Evidence for the connection experiments, computed from the meeting record
// (never from what an AI says about itself).

import { DISPLAY_NAMES } from "./presets.js";

// How did the AI receive this request? `automatic` is true only for routes
// where no person acted between turns (as far as the server can observe).
export function classifyWake(req) {
  if (!req || !req.firstDeliveredAt) return null;
  const before = req.triggers.filter((t) => t.at <= req.firstDeliveredAt);
  const last = before[before.length - 1];
  if (req.deliveredVia === "wait") return { code: "wait", automatic: true, label: "稼働中タスク内の待機（wait_for_my_turn）" };
  if (req.deliveredVia === "web") return { code: "web", automatic: true, label: "参加者ページ（ブラウザ経由。送信確認の有無は画面で記録）" };
  if (last?.manual) return { code: "manual", automatic: false, label: "人の操作（パネルの手動通知ボタン）" };
  if (last?.channel === "mcp_events") return { code: "events", automatic: true, label: "処理終了後のイベント再起動（MCP Events → get_my_turn）" };
  if (last?.channel === "panel") return { code: "panel", automatic: true, label: "処理終了後のイベント再起動（MCP App パネル → get_my_turn）" };
  return { code: "unknown", automatic: false, label: "通知記録なしで get_my_turn（開始時の指示か人の入力。経路不明）" };
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
      passed: !!(ra?.codeFound && rb?.codeFound && rb.status === "answered"),
      passedAutomatically: !!(ra?.codeFound && rb?.codeFound && rb.status === "answered" && wake?.automatic),
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
      automatic: !!wake?.automatic,
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
    automaticAnswered: answered.filter((r) => r.automatic).length,
    quotedPrevious: answered.filter((r) => r.quote && r.quote.matched > 0).length,
    rows,
  };
}
