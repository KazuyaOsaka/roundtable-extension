// Pure reducer: (meeting state, event) -> meeting state (mutated in place).
//
// It must not read the clock or any external state, so that replaying the
// event log always rebuilds exactly the same meeting.

import { AI_IDS } from "./presets.js";
import { visibleMessages } from "./render.js";

export function initialMeeting(ev) {
  const d = ev.data;
  const participants = {};
  for (const id of AI_IDS) {
    participants[id] = {
      lastDeliveredSeq: 0,
      seen: [],
      charterSeen: false,
      premiseSeen: 0,
      roleSeen: 0,
      error: null,
      observation: {},
    };
  }
  return {
    id: d.id,
    title: d.title,
    createdAt: ev.at,
    status: "open",
    endedAt: null,
    endReason: null,
    eventCount: 0,
    premise: { version: 1, topic: d.topic, instructions: d.instructions || "", updatedAt: ev.at },
    roles: Object.fromEntries(AI_IDS.map((id) => [id, { version: 1, ...d.roles[id] }])),
    order: [...d.order],
    members: structuredClone(d.members),
    settings: structuredClone(d.settings),
    messages: [],
    nextSeq: 1,
    requests: {},
    requestOrder: [],
    runs: {},
    runOrder: [],
    runId: null,
    participants,
    hypotheses: [],
    notices: [],
  };
}

function notice(m, ev, text) {
  m.notices.push({ at: ev.at, n: ev.n, type: ev.type, actor: ev.actor, text });
}

export function reduce(m, ev) {
  const d = ev.data;
  switch (ev.type) {
    case "meeting_created":
      m = initialMeeting(ev);
      notice(m, ev, `会議を作成: ${d.title}`);
      break;

    case "premise_updated":
      m.premise = { version: d.version, topic: d.topic, instructions: d.instructions, updatedAt: ev.at };
      notice(m, ev, `議題・前提を更新（v${d.version}）`);
      break;

    case "role_updated":
      m.roles[d.participant] = { version: d.version, preset: d.preset, name: d.name, text: d.text };
      notice(m, ev, `${d.participant} の役割を「${d.name}」に変更（v${d.version}）`);
      break;

    case "order_updated":
      m.order = [...d.order];
      notice(m, ev, `発言順を変更: ${d.order.join(" → ")}`);
      break;

    case "members_updated":
      m.members = structuredClone(d.members);
      notice(m, ev, "参加者の読書き権限を変更");
      break;

    case "settings_updated":
      m.settings = { ...m.settings, ...structuredClone(d.settings) };
      notice(m, ev, "会議設定を変更");
      break;

    case "message_posted": {
      const msg = {
        seq: d.seq,
        id: d.id,
        speaker: d.speaker,
        text: d.text,
        at: ev.at,
        requestId: d.requestId || null,
        premiseVersion: d.premiseVersion,
        roleVersion: d.roleVersion ?? null,
        roleName: d.roleName ?? null,
        phase: d.phase ?? null,
        status: d.status,
        reason: d.reason || null,
        adoptedFrom: d.adoptedFrom ?? null,
        hypotheses: d.hypotheses || [],
        summaries: [],
      };
      m.messages.push(msg);
      m.nextSeq = d.seq + 1;
      if (d.requestId && m.requests[d.requestId] && d.status === "accepted") {
        m.requests[d.requestId].messageId = d.id;
      }
      if (d.status === "accepted" && d.speaker !== "chair") {
        m.participants[d.speaker].error = null;
        const run = d.runId ? m.runs[d.runId] : null;
        if (run) run.accepted += 1;
      }
      break;
    }

    case "post_rejected":
      // Raw text is kept in the event log itself; nothing to apply.
      break;

    case "request_created": {
      m.requests[d.id] = {
        id: d.id,
        participant: d.participant,
        runId: d.runId,
        stepIndex: d.stepIndex,
        phase: d.phase,
        instruction: d.instruction,
        premiseVersion: d.premiseVersion,
        roleVersion: d.roleVersion,
        contextUpto: d.contextUpto,
        independent: !!d.independent,
        hideAiAfterSeq: d.hideAiAfterSeq ?? null,
        createdAt: ev.at,
        deadlineAt: d.deadlineAt,
        status: "open",
        closedAt: null,
        closeReason: null,
        deliveries: 0,
        firstDeliveredAt: null,
        deliveredVia: null,
        deltaFrom: null,
        deltaExclude: [],
        includeCharter: null,
        includePremise: null,
        includeRole: null,
        triggers: [],
        retriggerAllowed: false,
        messageId: null,
        lateMessageIds: [],
      };
      m.requestOrder.push(d.id);
      break;
    }

    case "request_delivered": {
      const r = m.requests[d.id];
      r.deliveries += 1;
      if (r.deliveries === 1) {
        r.firstDeliveredAt = ev.at;
        r.deliveredVia = d.via;
        r.deltaFrom = d.deltaFrom;
        r.includeCharter = d.includeCharter;
        r.includePremise = d.includePremise;
        r.includeRole = d.includeRole;
        const p = m.participants[r.participant];
        r.deltaExclude = [...p.seen];
        const shown = visibleMessages(m, r.participant, r.deltaFrom, r.contextUpto, r.hideAiAfterSeq, new Set(p.seen)).map((x) => x.seq);
        if (r.hideAiAfterSeq == null) {
          p.lastDeliveredSeq = Math.max(p.lastDeliveredSeq, r.contextUpto);
          p.seen = p.seen.filter((s) => s > p.lastDeliveredSeq);
        } else {
          // Independent round: other AIs' newer messages were hidden, so only
          // advance to the round's base and remember what else was shown.
          p.lastDeliveredSeq = Math.max(p.lastDeliveredSeq, r.hideAiAfterSeq);
          p.seen = [...new Set([...p.seen, ...shown])].filter((s) => s > p.lastDeliveredSeq);
        }
        p.charterSeen = true;
        p.premiseSeen = Math.max(p.premiseSeen, r.premiseVersion);
        p.roleSeen = Math.max(p.roleSeen, r.roleVersion);
      }
      break;
    }

    case "request_closed": {
      const r = m.requests[d.id];
      r.status = d.status;
      r.closedAt = ev.at;
      r.closeReason = d.reason || null;
      if (d.messageId) r.messageId = d.messageId;
      if (["expired", "failed"].includes(d.status)) {
        m.participants[r.participant].error = { kind: d.status, detail: d.reason || "", at: ev.at, requestId: r.id };
      }
      break;
    }

    case "late_post_recorded":
      m.requests[d.requestId].lateMessageIds.push(d.messageId);
      break;

    case "trigger_claimed":
      m.requests[d.requestId].triggers.push({ channel: d.channel || "panel", instanceId: d.instanceId, manual: !!d.manual, at: ev.at, result: null, detail: null });
      m.requests[d.requestId].retriggerAllowed = false;
      break;

    case "wake_attempt":
      m.requests[d.requestId].triggers.push({ channel: d.channel, instanceId: d.ref, manual: false, at: ev.at, result: d.result, detail: d.detail || null, resultAt: ev.at });
      m.requests[d.requestId].retriggerAllowed = false;
      break;

    case "trigger_result": {
      const t = m.requests[d.requestId].triggers.findLast((x) => x.instanceId === d.instanceId);
      if (t) {
        t.result = d.result;
        t.detail = d.detail || null;
        t.resultAt = ev.at;
      }
      break;
    }

    case "retrigger_authorized":
      m.requests[d.requestId].retriggerAllowed = true;
      notice(m, ev, `${m.requests[d.requestId].participant} への再通知を許可（${d.requestId}）`);
      break;

    case "problem_reported":
      m.participants[d.participant].error = { kind: d.kind, detail: d.detail || "", at: ev.at, requestId: d.requestId || null };
      break;

    case "run_started": {
      const run = structuredClone(d.run);
      run.startedAt = ev.at;
      run.endedAt = null;
      run.accepted = 0;
      run.stepIndex = 0;
      run.stepPos = 0;
      run.stepIssued = false;
      run.stepDone = [];
      run.stepDueAt = null;
      run.timeUp = false;
      run.state = "running";
      run.reason = null;
      m.runs[run.id] = run;
      m.runOrder.push(run.id);
      m.runId = run.id;
      break;
    }

    case "run_progress": {
      const run = m.runs[d.runId];
      for (const k of ["stepIndex", "stepPos", "stepIssued", "stepDone", "stepDueAt", "stepBaseSeq", "timeUp"]) {
        if (k in d) run[k] = structuredClone(d[k]);
      }
      if (d.appendStep) run.steps.push(structuredClone(d.appendStep));
      break;
    }

    case "run_state": {
      const run = m.runs[d.runId];
      run.state = d.state;
      run.reason = d.reason || null;
      if (d.state === "stopped" || d.state === "completed") run.endedAt = ev.at;
      const label = { running: "再開", paused: "一時停止", stopped: "停止", completed: "完了" }[d.state];
      notice(m, ev, `進行を${label}${d.reason ? `（${d.reason}）` : ""}`);
      break;
    }

    case "summary_added": {
      const msg = m.messages.find((x) => x.id === d.messageId);
      msg.summaries.push({ text: d.text, by: ev.actor, at: ev.at });
      break;
    }

    case "hypothesis_saved": {
      const i = m.hypotheses.findIndex((h) => h.id === d.hypothesis.id);
      if (i >= 0) m.hypotheses[i] = { ...d.hypothesis, updatedAt: ev.at };
      else m.hypotheses.push({ ...d.hypothesis, createdAt: ev.at, updatedAt: ev.at });
      break;
    }

    case "observation_recorded":
      m.participants[d.participant].observation = { ...m.participants[d.participant].observation, ...d.fields, recordedAt: ev.at };
      break;

    case "meeting_ended":
      m.status = "ended";
      m.endedAt = ev.at;
      m.endReason = d.reason || null;
      notice(m, ev, `会議を終了${d.reason ? `（${d.reason}）` : ""}`);
      break;

    default:
      throw new Error(`unknown event type ${ev.type}`);
  }
  m.eventCount = ev.n;
  return m;
}
