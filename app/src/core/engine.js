// The meeting core: one place that owns progression and the record.
//
// Every command validates against the current (replayed) state, then appends
// one or more events. Connectors (MCP, web page) never touch state directly;
// they call the participant commands below, which enforce:
//   - the token's participant may only read/write meetings it is a member of,
//     and only answer its own requests;
//   - one request accepts at most one answer (duplicates return the original);
//   - answers to cancelled/superseded/expired requests are kept but marked
//     stale/late and are never forwarded or counted;
//   - after pause/stop/interrupt no new request is issued until the chair acts.

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { reduce } from "./reducer.js";
import { renderTurn, turnStructured, visibleMessages, fenceMessage } from "./render.js";
import {
  AI_IDS,
  CHAIR_ID,
  DEFAULT_ORDER,
  DEFAULT_ROLES,
  PHASE_PRESETS,
  ASK_INSTRUCTION,
  roleFromPreset,
  DISPLAY_NAMES,
} from "./presets.js";

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const DEFAULT_SETTINGS = {
  requestTimeoutSec: 480,
  triggerGraceSec: 8,
  lengthHint: "800字以内",
  maxTextChars: 20000,
  // How each AI is woken for its next turn:
  //   wait   — it stays in its running task and calls wait_for_my_turn
  //   widget — it ends its task; the Roundtable panel (MCP App) sends the
  //            next-turn message into its chat
  //   hybrid — both (whichever picks the request up first wins)
  //   web    — it reads/posts through the participant web page
  wake: { claude: "hybrid", chatgpt: "hybrid", gemini: "web" },
};

const OPEN = "open";

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function rid(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

export class Roundtable extends EventEmitter {
  constructor({ store, now = () => Date.now() }) {
    super();
    this.setMaxListeners(100);
    this.store = store;
    this.now = now;
    this.meetings = new Map();
    this.activeId = null;
    this.waiters = new Map(); // participant -> Set<fn>
    this.presence = Object.fromEntries(
      AI_IDS.map((id) => [id, { lastSeenAt: null, lastVia: null, waitingSince: null, widgetSeenAt: null, widgetInstances: new Set() }]),
    );
    this.warnings = [];
  }

  // ---------------------------------------------------------------- boot
  boot() {
    for (const id of this.store.listMeetingIds()) {
      const { events, warnings } = this.store.load(id);
      this.warnings.push(...warnings);
      let m = null;
      for (const ev of events) m = reduce(m, ev);
      if (m) this.meetings.set(m.id, m);
    }
    const idx = this.store.readJson("index.json", {});
    if (idx.activeId && this.meetings.has(idx.activeId)) this.activeId = idx.activeId;
    this.tick();
    return this;
  }

  get active() {
    return this.activeId ? this.meetings.get(this.activeId) : null;
  }

  requireActive() {
    const m = this.active;
    if (!m) throw new CommandError("no_meeting", "進行中の会議がありません");
    return m;
  }

  requireOpen() {
    const m = this.requireActive();
    if (m.status !== "open") throw new CommandError("meeting_ended", "会議は終了しています");
    return m;
  }

  // ---------------------------------------------------------------- events
  _emit(m, type, actor, data) {
    const ev = { n: (m ? m.eventCount : 0) + 1, at: this.now(), type, actor, data };
    const meetingId = m ? m.id : data.id;
    this.store.append(meetingId, ev);
    const next = reduce(m, ev);
    if (!m) this.meetings.set(next.id, next);
    this.emit("event", { meetingId, event: ev });
    return ev;
  }

  // ---------------------------------------------------------------- chair commands
  createMeeting({ title, topic, instructions = "", order, roles = {}, members, settings = {} }) {
    if (!topic || !topic.trim()) throw new CommandError("bad_input", "議題を入力してください");
    const prev = this.active;
    if (prev && prev.status === "open") this.endMeeting("新しい会議を作成したため");
    const ord = this._checkOrder(order || DEFAULT_ORDER);
    const roleObjs = {};
    for (const id of AI_IDS) {
      const r = roles[id];
      roleObjs[id] = typeof r === "object" && r ? { preset: r.preset || "custom", name: r.name, text: r.text } : roleFromPreset(r || DEFAULT_ROLES[id] || "free");
    }
    const mem = members || Object.fromEntries(AI_IDS.map((id) => [id, { read: true, write: ord.includes(id) }]));
    const d = new Date(this.now());
    const id = `M${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${crypto.randomBytes(3).toString("hex")}`;
    const st = { ...structuredClone(DEFAULT_SETTINGS), ...settings, wake: { ...DEFAULT_SETTINGS.wake, ...(settings.wake || {}) } };
    this._emit(null, "meeting_created", CHAIR_ID, {
      id,
      title: (title || "").trim() || `会議 ${d.toISOString().slice(0, 16).replace("T", " ")}`,
      topic: topic.trim(),
      instructions,
      order: ord,
      roles: roleObjs,
      members: mem,
      settings: st,
    });
    this.activeId = id;
    this.store.writeJson("index.json", { activeId: id });
    return this.meetings.get(id);
  }

  _checkOrder(order) {
    if (!Array.isArray(order) || !order.length) throw new CommandError("bad_input", "発言順が空です");
    const seen = new Set();
    for (const id of order) {
      if (!AI_IDS.includes(id)) throw new CommandError("bad_input", `不明な参加者: ${id}`);
      if (seen.has(id)) throw new CommandError("bad_input", `発言順に重複: ${id}`);
      seen.add(id);
    }
    return [...order];
  }

  updatePremise({ topic, instructions }) {
    const m = this.requireOpen();
    const t = topic ?? m.premise.topic;
    const ins = instructions ?? m.premise.instructions;
    if (t === m.premise.topic && ins === m.premise.instructions) return m;
    this._emit(m, "premise_updated", CHAIR_ID, { version: m.premise.version + 1, topic: t, instructions: ins });
    this._interrupt(m, "前提が変更されたため");
    return m;
  }

  updateRole(participant, role) {
    const m = this.requireOpen();
    if (!AI_IDS.includes(participant)) throw new CommandError("bad_input", "不明な参加者");
    const r = typeof role === "string" ? roleFromPreset(role) : { preset: role.preset || "custom", name: role.name, text: role.text };
    if (!r.name || !r.text) throw new CommandError("bad_input", "役割名と内容が必要です");
    const cur = m.roles[participant];
    if (cur.name === r.name && cur.text === r.text) return m;
    this._emit(m, "role_updated", CHAIR_ID, { participant, version: cur.version + 1, ...r });
    this._interrupt(m, `${DISPLAY_NAMES[participant]} の役割が変更されたため`, (req) => req.participant === participant);
    return m;
  }

  updateOrder(order) {
    const m = this.requireOpen();
    this._emit(m, "order_updated", CHAIR_ID, { order: this._checkOrder(order) });
    return m;
  }

  updateMembers(members) {
    const m = this.requireOpen();
    const clean = {};
    for (const id of AI_IDS) clean[id] = { read: !!members[id]?.read, write: !!members[id]?.write && !!members[id]?.read };
    this._emit(m, "members_updated", CHAIR_ID, { members: clean });
    // A participant that lost write access cannot keep an open request.
    for (const req of this._openRequests(m)) {
      if (!clean[req.participant].write) this._closeRequest(m, req, "cancelled", "書込権限が外されたため");
    }
    return m;
  }

  updateSettings(settings) {
    const m = this.requireOpen();
    const allowed = ["requestTimeoutSec", "triggerGraceSec", "lengthHint", "wake"];
    const s = {};
    for (const k of allowed) if (k in settings) s[k] = settings[k];
    if (s.wake) s.wake = { ...m.settings.wake, ...s.wake };
    if (s.requestTimeoutSec != null && !(s.requestTimeoutSec >= 30 && s.requestTimeoutSec <= 3600))
      throw new CommandError("bad_input", "依頼の期限は30〜3600秒");
    this._emit(m, "settings_updated", CHAIR_ID, { settings: s });
    return m;
  }

  // The chair speaks. `ask` = null (statement only), "all", or an AI id.
  chairPost({ text, ask = null, parallel = false }) {
    const m = this.requireOpen();
    if (!text || !text.trim()) throw new CommandError("bad_input", "発言が空です");
    const run = this._run(m);
    const interrupting = run && (run.state === "running" || run.state === "paused");
    if (interrupting && !ask) {
      // 割込: pause and invalidate in-flight answers, then record the words.
      this._interrupt(m, "議長が割込発言したため");
    }
    if (ask && run && ["running", "paused"].includes(run.state)) {
      this._stopRun(m, run, "議長が新しく質問したため");
    }
    this._postMessage(m, { speaker: CHAIR_ID, text: text.trim(), status: "accepted" });
    if (ask) {
      const targets = ask === "all" ? m.order.filter((id) => m.members[id].write) : [ask];
      for (const t of targets) {
        if (!AI_IDS.includes(t)) throw new CommandError("bad_input", `不明な宛先: ${t}`);
        if (!m.members[t].write) throw new CommandError("forbidden", `${DISPLAY_NAMES[t]} は書込権限がありません`);
      }
      this._startRun(m, {
        kind: "ask",
        presetId: null,
        order: targets,
        limits: {},
        steps: [{ phase: ask === "all" ? "全員への質問" : "指名質問", parallel: !!parallel && targets.length > 1, independent: !!parallel, instruction: ASK_INSTRUCTION, participants: targets }],
        repeat: null,
      });
    }
    return m;
  }

  startAuto({ presetId = "free", order, maxTurns = 6, maxMinutes = 30, instruction } = {}) {
    const m = this.requireOpen();
    const preset = PHASE_PRESETS[presetId];
    if (!preset) throw new CommandError("bad_input", "不明な進行プリセット");
    const ord = this._checkOrder(order || m.order).filter((id) => m.members[id].write);
    if (!ord.length) throw new CommandError("bad_input", "書込権限のある参加者がいません");
    if (!(maxTurns >= 1 && maxTurns <= 60)) throw new CommandError("bad_input", "回数上限は1〜60");
    if (!(maxMinutes >= 1 && maxMinutes <= 240)) throw new CommandError("bad_input", "時間上限は1〜240分");
    const prev = this._run(m);
    if (prev && ["running", "paused"].includes(prev.state)) this._stopRun(m, prev, "新しい自動進行を開始したため");
    const steps = preset.steps.map((s) => ({ ...s, participants: ord }));
    const repeat = preset.repeat ? { ...preset.repeat, instruction: instruction || preset.repeat.instruction } : null;
    this._startRun(m, { kind: "auto", presetId, order: ord, limits: { maxTurns, maxMinutes }, steps, repeat });
    return m;
  }

  // Probe: a single AI answers request A, then after `delaySec` gets request B.
  startProbe({ participant, delaySec = 0 }) {
    const m = this.requireOpen();
    if (!AI_IDS.includes(participant)) throw new CommandError("bad_input", "不明な参加者");
    if (!m.members[participant].write) throw new CommandError("forbidden", "書込権限がありません");
    const prev = this._run(m);
    if (prev && ["running", "paused"].includes(prev.state)) this._stopRun(m, prev, "接続試験を開始したため");
    const codeA = `ALPHA-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const codeB = `BRAVO-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const a = 2 + Math.floor(Math.random() * 7);
    const b = 2 + Math.floor(Math.random() * 7);
    this._startRun(m, {
      kind: "probe",
      presetId: null,
      order: [participant],
      limits: {},
      probe: { participant, delaySec, codeA, codeB },
      steps: [
        { phase: "接続試験A", participants: [participant], instruction: `接続試験Aです。${a}+${b} の答えを1文で書き、合言葉 ${codeA} を本文に含めてください。` },
        { phase: "接続試験B", participants: [participant], delaySec, instruction: `接続試験Bです。${a}×${b} の答えを1文で書き、合言葉 ${codeB} を本文に含めてください。` },
      ],
      repeat: null,
    });
    return m;
  }

  pause() {
    const m = this.requireOpen();
    const run = this._run(m);
    if (!run || run.state !== "running") throw new CommandError("bad_state", "進行中ではありません");
    // In-flight answers stay valid on pause (the premise did not change);
    // only new requests are held back.
    this._emit(m, "run_state", CHAIR_ID, { runId: run.id, state: "paused", reason: "議長が一時停止" });
    return m;
  }

  resume() {
    const m = this.requireOpen();
    const run = this._run(m);
    if (!run || run.state !== "paused") throw new CommandError("bad_state", "一時停止中ではありません");
    this._emit(m, "run_state", CHAIR_ID, { runId: run.id, state: "running", reason: null });
    this._advance(m);
    return m;
  }

  stop() {
    const m = this.requireOpen();
    const run = this._run(m);
    if (!run || !["running", "paused"].includes(run.state)) throw new CommandError("bad_state", "停止できる進行がありません");
    this._stopRun(m, run, "議長が停止");
    return m;
  }

  endMeeting(reason = "議長が終了") {
    const m = this.requireOpen();
    const run = this._run(m);
    if (run && ["running", "paused"].includes(run.state)) this._stopRun(m, run, reason);
    for (const req of this._openRequests(m)) this._closeRequest(m, req, "cancelled", reason);
    this._emit(m, "meeting_ended", CHAIR_ID, { reason });
    this._wakeAll();
    return m;
  }

  // Close a stuck request without an answer and move on (chair decision).
  skip(requestId) {
    const m = this.requireOpen();
    const req = m.requests[requestId];
    if (!req) throw new CommandError("not_found", "依頼が見つかりません");
    const run = m.runs[req.runId];
    if (req.status === OPEN) this._closeRequest(m, req, "skipped", "議長がスキップ");
    if (run && run.id === m.runId && req.stepIndex === run.stepIndex) this._markStepDone(m, run, req.participant);
    if (run && run.state === "running") this._advance(m);
    return m;
  }

  // Allow one more wake-up message for an undelivered request. Never automatic:
  // if the previous trigger's outcome is unknown, a blind resend could make the
  // AI answer twice.
  authorizeRetrigger(requestId) {
    const m = this.requireOpen();
    const req = m.requests[requestId];
    if (!req || req.status !== OPEN) throw new CommandError("bad_state", "未完了の依頼ではありません");
    this._emit(m, "retrigger_authorized", CHAIR_ID, { requestId });
    return m;
  }

  addSummary(messageId, text) {
    const m = this.requireActive();
    if (!m.messages.some((x) => x.id === messageId)) throw new CommandError("not_found", "発言が見つかりません");
    if (!text || !text.trim()) throw new CommandError("bad_input", "要約が空です");
    this._emit(m, "summary_added", CHAIR_ID, { messageId, text: text.trim() });
    return m;
  }

  // Bring a stale/late answer into the record as a new accepted message
  // (the original entry is kept unchanged).
  adopt(messageId) {
    const m = this.requireOpen();
    const msg = m.messages.find((x) => x.id === messageId);
    if (!msg || msg.status === "accepted") throw new CommandError("bad_state", "採用できる発言ではありません");
    this._postMessage(m, {
      speaker: msg.speaker,
      text: msg.text,
      status: "accepted",
      requestId: msg.requestId,
      premiseVersion: msg.premiseVersion,
      roleVersion: msg.roleVersion,
      roleName: msg.roleName,
      phase: msg.phase,
      adoptedFrom: msg.seq,
      reason: `議長が #${msg.seq} を採用`,
    });
    return m;
  }

  saveHypothesis(h) {
    const m = this.requireActive();
    if (!h.title || !h.title.trim()) throw new CommandError("bad_input", "仮説の見出しが必要です");
    const hyp = {
      id: h.id || rid("H"),
      title: h.title.trim(),
      sourceSeqs: (h.sourceSeqs || []).map(Number).filter(Boolean),
      difference: h.difference || "",
      prediction: h.prediction || "",
      falsification: h.falsification || "",
      observation: h.observation || "",
      status: h.status || "検討中",
    };
    this._emit(m, "hypothesis_saved", CHAIR_ID, { hypothesis: hyp });
    return hyp;
  }

  recordObservation(participant, fields) {
    const m = this.requireActive();
    if (!AI_IDS.includes(participant)) throw new CommandError("bad_input", "不明な参加者");
    const keys = ["environment", "modelShown", "project", "memory", "humanActions", "confirmations", "waitBehavior", "notes"];
    const clean = {};
    for (const k of keys) if (k in fields) clean[k] = String(fields[k] ?? "").slice(0, 2000);
    this._emit(m, "observation_recorded", CHAIR_ID, { participant, fields: clean });
    return m;
  }

  // ---------------------------------------------------------------- run internals
  _run(m) {
    return m.runId ? m.runs[m.runId] : null;
  }

  _openRequests(m) {
    return m.requestOrder.map((id) => m.requests[id]).filter((r) => r.status === OPEN);
  }

  _startRun(m, spec) {
    const run = { id: rid("RUN"), ...spec };
    this._emit(m, "run_started", CHAIR_ID, { run });
    this._advance(m);
  }

  _stopRun(m, run, reason) {
    for (const req of this._openRequests(m)) {
      if (req.runId === run.id) this._closeRequest(m, req, "cancelled", reason);
    }
    this._emit(m, "run_state", CHAIR_ID, { runId: run.id, state: "stopped", reason });
  }

  // Pause the running run and supersede in-flight requests (all, or those
  // matching `filter`). Their eventual answers are kept as stale.
  _interrupt(m, reason, filter = () => true) {
    const run = this._run(m);
    let touched = false;
    for (const req of this._openRequests(m)) {
      if (filter(req)) {
        this._closeRequest(m, req, "superseded", reason);
        touched = true;
      }
    }
    if (run && run.state === "running") {
      this._emit(m, "run_state", CHAIR_ID, { runId: run.id, state: "paused", reason });
    }
    return touched;
  }

  _closeRequest(m, req, status, reason, messageId) {
    this._emit(m, "request_closed", "system", { id: req.id, status, reason, messageId });
  }

  _markStepDone(m, run, participant) {
    const step = run.steps[run.stepIndex];
    if (!step) return;
    if (step.parallel) {
      const done = Array.from(new Set([...run.stepDone, participant]));
      this._emit(m, "run_progress", "system", { runId: run.id, stepDone: done });
    } else {
      this._emit(m, "run_progress", "system", { runId: run.id, stepPos: run.stepPos + 1 });
    }
  }

  _complete(m, run, reason) {
    this._emit(m, "run_state", "system", { runId: run.id, state: "completed", reason });
  }

  // Decide what happens next. Called after any state change that could
  // unblock the run. Never issues a request unless the run is "running".
  _advance(m) {
    const nextStep = (run) =>
      this._emit(m, "run_progress", "system", { runId: run.id, stepIndex: run.stepIndex + 1, stepPos: 0, stepIssued: false, stepDone: [], stepDueAt: null, stepBaseSeq: null });
    for (let guard = 0; guard < 50; guard++) {
      const run = this._run(m);
      if (!run || run.state !== "running" || m.status !== "open") return;
      const open = this._openRequests(m).filter((r) => r.runId === run.id);
      const now = this.now();
      const turnLimit = run.limits.maxTurns && run.accepted >= run.limits.maxTurns;
      const timeLimit = run.timeUp || (run.limits.maxMinutes && now - run.startedAt >= run.limits.maxMinutes * 60000);
      if (turnLimit || timeLimit) {
        // In-flight requests may still finish; nothing new is issued.
        if (!open.length) this._complete(m, run, turnLimit ? `回数上限 ${run.limits.maxTurns} 回に到達` : `時間上限 ${run.limits.maxMinutes} 分に到達`);
        return;
      }

      const step = run.steps[run.stepIndex];
      if (!step) {
        if (open.length) return;
        if (!run.repeat) return this._complete(m, run, "予定の発言をすべて終えました");
        this._emit(m, "run_progress", "system", {
          runId: run.id,
          appendStep: { phase: run.repeat.phase, instruction: run.repeat.instruction, participants: run.order },
        });
        continue;
      }
      const eligible = step.participants.filter((id) => m.members[id].write);

      if (step.parallel) {
        const remaining = eligible.filter((id) => !run.stepDone.includes(id));
        if (!remaining.length) {
          if (open.length) return;
          nextStep(run);
          continue;
        }
        if (!run.stepIssued && this._waitDelay(m, run, step, now)) return;
        // Re-issue only to those without an open request (e.g. after one
        // participant's request was superseded by a role change).
        const toIssue = remaining.filter((id) => !open.some((r) => r.participant === id));
        const budget = run.limits.maxTurns ? run.limits.maxTurns - run.accepted - open.length : toIssue.length;
        if (toIssue.length && budget > 0) {
          const base = run.stepBaseSeq ?? m.nextSeq - 1;
          for (const id of toIssue.slice(0, budget)) this._issue(m, run, step, id, base);
          this._emit(m, "run_progress", "system", { runId: run.id, stepIssued: true, stepBaseSeq: base });
        }
        return;
      }

      if (open.length) return;
      if (run.stepPos >= step.participants.length) {
        nextStep(run);
        continue;
      }
      if (run.stepPos === 0 && this._waitDelay(m, run, step, now)) return;
      const id = step.participants[run.stepPos];
      if (!m.members[id].write) {
        this._emit(m, "run_progress", "system", { runId: run.id, stepPos: run.stepPos + 1 });
        continue;
      }
      this._issue(m, run, step, id, null);
      return;
    }
    throw new Error("advance loop guard tripped");
  }

  // Steps may ask for a pause before they start (used by the connection probe
  // to test whether an AI can be woken minutes after its previous answer).
  _waitDelay(m, run, step, now) {
    if (!step.delaySec) return false;
    if (!run.stepDueAt) {
      this._emit(m, "run_progress", "system", { runId: run.id, stepDueAt: now + step.delaySec * 1000 });
      return true;
    }
    return now < run.stepDueAt;
  }

  // `independentBase` is set for independent rounds: the AI sees the chair's
  // later messages (e.g. an interrupt) but no other AI's message after it.
  _issue(m, run, step, participant, independentBase) {
    const contextUpto = m.nextSeq - 1;
    const id = `R-${m.id.slice(-6)}-${String(m.requestOrder.length + 1).padStart(3, "0")}`;
    this._emit(m, "request_created", "system", {
      id,
      participant,
      runId: run.id,
      stepIndex: run.stepIndex,
      phase: step.phase,
      instruction: step.instruction,
      premiseVersion: m.premise.version,
      roleVersion: m.roles[participant].version,
      contextUpto,
      independent: !!step.independent,
      hideAiAfterSeq: step.independent ? independentBase : null,
      deadlineAt: this.now() + m.settings.requestTimeoutSec * 1000,
    });
    this._wake(participant);
  }

  _postMessage(m, fields) {
    const seq = m.nextSeq;
    const id = `${m.id}-${String(seq).padStart(4, "0")}`;
    this._emit(m, "message_posted", fields.speaker === CHAIR_ID ? CHAIR_ID : fields.speaker, {
      seq,
      id,
      premiseVersion: fields.premiseVersion ?? m.premise.version,
      ...fields,
    });
    return m.messages[m.messages.length - 1];
  }

  // ---------------------------------------------------------------- periodic
  tick() {
    const m = this.active;
    if (!m || m.status !== "open") return;
    const now = this.now();
    for (const req of this._openRequests(m)) {
      if (now >= req.deadlineAt) {
        this._closeRequest(m, req, "expired", `${Math.round(m.settings.requestTimeoutSec / 60)}分以内に回答がありませんでした`);
        const run = m.runs[req.runId];
        if (run && run.state === "running" && run.id === m.runId) {
          this._emit(m, "run_state", "system", { runId: run.id, state: "paused", reason: `${DISPLAY_NAMES[req.participant]} が期限切れ` });
        }
      }
    }
    const run = this._run(m);
    if (run && run.state === "running") {
      if (!run.timeUp && run.limits.maxMinutes && now - run.startedAt >= run.limits.maxMinutes * 60000) {
        this._emit(m, "run_progress", "system", { runId: run.id, timeUp: true });
      }
      this._advance(m);
    }
  }

  // ---------------------------------------------------------------- participant side
  _member(m, participant, need) {
    const mem = m.members[participant];
    if (!mem || !mem[need]) throw new CommandError("forbidden", `${DISPLAY_NAMES[participant]} にはこの会議の${need === "read" ? "読取" : "書込"}権限がありません`);
  }

  touch(participant, via) {
    const p = this.presence[participant];
    p.lastSeenAt = this.now();
    p.lastVia = via;
  }

  _nextOpenFor(m, participant) {
    return this._openRequests(m).find((r) => r.participant === participant) || null;
  }

  // Hand the participant its open request (idempotent: the same request is
  // returned until it is answered). Returns null when it is not their turn.
  deliver(participant, via) {
    this.touch(participant, via);
    const m = this.active;
    if (!m) return { status: "no_meeting" };
    this._member(m, participant, "read");
    if (m.status !== "open") return { status: "meeting_ended", meeting_id: m.id };
    const req = this._nextOpenFor(m, participant);
    if (!req) return { status: "not_your_turn", meeting_id: m.id };
    const p = m.participants[participant];
    if (req.deliveries === 0) {
      this._emit(m, "request_delivered", participant, {
        id: req.id,
        via,
        deltaFrom: p.lastDeliveredSeq,
        includeCharter: !p.charterSeen,
        includePremise: p.premiseSeen < req.premiseVersion,
        includeRole: p.roleSeen < req.roleVersion,
      });
    } else {
      this._emit(m, "request_delivered", participant, { id: req.id, via, duplicate: true });
    }
    return { status: "your_turn", request: req, text: renderTurn(m, req), structured: turnStructured(m, req) };
  }

  // Long-poll variant: resolves when a request appears, the meeting ends, or
  // the timeout passes. Never blocks forever.
  waitForTurn(participant, timeoutMs) {
    const first = this.deliver(participant, "wait");
    if (first.status !== "not_your_turn") return Promise.resolve(first);
    const p = this.presence[participant];
    p.waitingSince = this.now();
    return new Promise((resolve) => {
      let done = false;
      const set = this.waiters.get(participant) || new Set();
      this.waiters.set(participant, set);
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set.delete(fn);
        if (!set.size) p.waitingSince = null;
        resolve(res);
      };
      const fn = () => {
        try {
          const r = this.deliver(participant, "wait");
          if (r.status !== "not_your_turn") finish(r);
        } catch (e) {
          finish({ status: "error", message: e.message });
        }
      };
      const timer = setTimeout(() => {
        try {
          const r = this.deliver(participant, "wait");
          finish(r.status === "not_your_turn" ? { status: "no_turn_yet", meeting_id: r.meeting_id } : r);
        } catch (e) {
          finish({ status: "error", message: e.message });
        }
      }, timeoutMs);
      set.add(fn);
    });
  }

  _wake(participant) {
    const set = this.waiters.get(participant);
    if (set) for (const fn of [...set]) queueMicrotask(fn);
  }

  _wakeAll() {
    for (const id of AI_IDS) this._wake(id);
  }

  post(participant, { requestId, text, hypotheses, via }) {
    this.touch(participant, via || "post");
    const m = this._meetingForRequest(requestId);
    if (!m) {
      this._auditReject(this.active, participant, requestId, "unknown_request", text);
      throw new CommandError("not_found", `依頼 ${requestId} は存在しません。get_my_turn で現在の依頼を確認してください。`);
    }
    const req = m.requests[requestId];
    if (req.participant !== participant) {
      this._auditReject(m, participant, requestId, "not_your_request", text);
      throw new CommandError("forbidden", "この依頼はあなた宛てではありません");
    }
    this._member(m, participant, "write");
    if (typeof text !== "string" || !text.trim()) throw new CommandError("bad_input", "本文が空です");
    if (text.length > m.settings.maxTextChars) {
      this._auditReject(m, participant, requestId, "too_long", text);
      throw new CommandError("bad_input", `本文が長すぎます（上限 ${m.settings.maxTextChars} 字）`);
    }
    const body = text.trim();
    const hyps = Array.isArray(hypotheses) ? hypotheses.slice(0, 5).map(cleanHypothesis) : [];

    if (req.status === "answered") {
      const orig = m.messages.find((x) => x.id === req.messageId);
      if (orig && sha(orig.text) === sha(body)) {
        return { status: "duplicate", message_id: orig.id, seq: orig.seq, next: this._nextHint(m, participant) };
      }
      this._auditReject(m, participant, requestId, "already_answered", body);
      throw new CommandError("already_answered", `依頼 ${requestId} には回答済みです（#${orig?.seq}）。同じ依頼に二度目の回答はできません。`);
    }

    // A second copy of a late/stale answer is also a duplicate.
    for (const lateId of req.lateMessageIds) {
      const prev = m.messages.find((x) => x.id === lateId);
      if (prev && sha(prev.text) === sha(body)) return { status: "duplicate_late", message_id: prev.id, seq: prev.seq, next: this._nextHint(m, participant) };
    }

    if (req.status !== OPEN || m.status !== "open") {
      const status = req.status === "superseded" || req.status === "cancelled" ? "stale" : "late";
      const reason =
        m.status !== "open" ? "会議終了後の回答" : { superseded: req.closeReason, cancelled: req.closeReason, expired: "期限切れ後の回答", skipped: "スキップ後の回答", failed: "失敗扱い後の回答" }[req.status];
      if (m.status !== "open") {
        // The log is closed for business but the raw text must not be lost.
        this._auditReject(m, participant, requestId, "meeting_ended", body);
        return { status: "recorded_after_end", forwarded: false, note: "会議は終了しています。本文は記録のみされ、他の参加者には転送されません。" };
      }
      const msg = this._postMessage(m, {
        speaker: participant,
        text: body,
        status,
        reason,
        requestId,
        premiseVersion: req.premiseVersion,
        roleVersion: req.roleVersion,
        roleName: m.roles[participant].name,
        phase: req.phase,
        hypotheses: hyps,
      });
      this._emit(m, "late_post_recorded", participant, { requestId, messageId: msg.id });
      return {
        status,
        message_id: msg.id,
        seq: msg.seq,
        forwarded: false,
        note: `この依頼は「${reason}」で取り消されています。回答は旧前提の記録として保存しましたが、他の参加者には転送しません。`,
        next: this._nextHint(m, participant),
      };
    }

    const msg = this._postMessage(m, {
      speaker: participant,
      text: body,
      status: "accepted",
      requestId,
      runId: req.runId,
      premiseVersion: req.premiseVersion,
      roleVersion: req.roleVersion,
      roleName: m.roles[participant].name,
      phase: req.phase,
      hypotheses: hyps,
    });
    this._closeRequest(m, req, "answered", null, msg.id);
    const run = m.runs[req.runId];
    if (run && run.id === m.runId && req.stepIndex === run.stepIndex) this._markStepDone(m, run, participant);
    this._advance(m);
    return { status: "accepted", message_id: msg.id, seq: msg.seq, next: this._nextHint(m, participant) };
  }

  _auditReject(m, participant, requestId, reason, text) {
    if (!m) return;
    this._emit(m, "post_rejected", participant, { participant, requestId: requestId || null, reason, text: typeof text === "string" ? text.slice(0, 50000) : null });
  }

  _meetingForRequest(requestId) {
    if (typeof requestId !== "string") return null;
    for (const m of this.meetings.values()) if (m.requests[requestId]) return m;
    return null;
  }

  // What the AI should do after posting, depending on how it is woken.
  _nextHint(m, participant) {
    if (m.status !== "open") return "会議は終了しました。これ以上ツールを呼ぶ必要はありません。";
    const mode = m.settings.wake[participant];
    if (mode === "wait") return "次は wait_for_my_turn を呼んで、次の番を待ってください（no_turn_yet が返ったら再度呼ぶ）。";
    if (mode === "widget") return "ここで応答を終えてください。次の番が来たら Roundtable パネルが通知します。";
    if (mode === "hybrid") return "続けて wait_for_my_turn を呼んで待機してください。待機を続けられない場合は応答を終えてかまいません（次の番はパネルが通知します）。";
    return "次の番は参加者ページに表示されます。";
  }

  reportProblem(participant, { requestId, kind, detail }) {
    this.touch(participant, "report");
    const m = this.requireActive();
    this._member(m, participant, "read");
    const kinds = ["usage_limit", "cannot_answer", "tool_error", "needs_human", "other"];
    const k = kinds.includes(kind) ? kind : "other";
    this._emit(m, "problem_reported", participant, { participant, requestId: requestId || null, kind: k, detail: String(detail || "").slice(0, 2000) });
    const req = requestId ? m.requests[requestId] : this._nextOpenFor(m, participant);
    if (req && req.participant === participant && req.status === OPEN) {
      this._closeRequest(m, req, "failed", `${k}: ${String(detail || "").slice(0, 200)}`);
      const run = m.runs[req.runId];
      if (run && run.state === "running" && run.id === m.runId) {
        this._emit(m, "run_state", "system", { runId: run.id, state: "paused", reason: `${DISPLAY_NAMES[participant]} が問題を報告（${k}）` });
      }
    }
    return { status: "recorded" };
  }

  // Read access is limited to the active meeting and, while an independent
  // request is open, to what existed when that request was issued.
  getMessages(participant, { fromSeq = 0, toSeq, limit = 20 } = {}) {
    this.touch(participant, "read");
    const m = this.requireActive();
    this._member(m, participant, "read");
    const open = this._nextOpenFor(m, participant);
    const horizon = open ? open.contextUpto : m.nextSeq - 1;
    const upto = Math.min(toSeq ?? horizon, horizon);
    const msgs = visibleMessages(m, "__nobody__", fromSeq, upto, open?.hideAiAfterSeq ?? null).slice(-Math.min(limit, 50));
    return { meeting_id: m.id, horizon, messages: msgs.map((x) => fenceMessage(m, x)).join("\n") };
  }

  brief(participant) {
    this.touch(participant, "read");
    const m = this.requireActive();
    this._member(m, participant, "read");
    const r = m.roles[participant];
    const open = this._nextOpenFor(m, participant);
    const horizon = open ? open.contextUpto : m.nextSeq - 1;
    const recent = visibleMessages(m, "__nobody__", 0, horizon, open?.hideAiAfterSeq ?? null).slice(-6);
    return {
      meeting_id: m.id,
      title: m.title,
      status: m.status,
      topic: m.premise.topic,
      instructions: m.premise.instructions,
      premise_version: m.premise.version,
      your_role: r,
      order: m.order.map((id) => DISPLAY_NAMES[id]),
      recent: recent.map((x) => fenceMessage(m, x)).join("\n"),
      open_request: open ? open.id : null,
    };
  }

  // ---------------------------------------------------------------- MCP App panel
  widgetPoll(participant, instanceId) {
    const pr = this.presence[participant];
    pr.widgetSeenAt = this.now();
    if (instanceId) pr.widgetInstances.add(String(instanceId).slice(0, 64));
    const m = this.active;
    if (!m) return { status: "no_meeting" };
    this._member(m, participant, "read");
    const req = m.status === "open" ? this._nextOpenFor(m, participant) : null;
    const mode = m.settings.wake[participant];
    const canTrigger =
      !!req &&
      ["widget", "hybrid"].includes(mode) &&
      req.deliveries === 0 &&
      this.now() - req.createdAt >= m.settings.triggerGraceSec * 1000 &&
      (req.triggers.length === 0 || req.retriggerAllowed);
    return {
      status: m.status,
      meeting_id: m.id,
      title: m.title,
      wake_mode: mode,
      run_state: this._run(m)?.state || "idle",
      request: req ? { id: req.id, phase: req.phase, delivered: req.deliveries > 0, triggers: req.triggers.length } : null,
      should_trigger: canTrigger,
      last_seq: m.nextSeq - 1,
    };
  }

  // Exactly one panel instance wins the right to send the wake-up message
  // for a request (several panels may be mounted in the same chat).
  claimTrigger(participant, { requestId, instanceId }) {
    const m = this.requireOpen();
    this._member(m, participant, "write");
    const req = m.requests[requestId];
    if (!req || req.participant !== participant) throw new CommandError("forbidden", "この依頼はあなた宛てではありません");
    const mode = m.settings.wake[participant];
    if (!["widget", "hybrid"].includes(mode)) return { granted: false, reason: "wake_mode_disallows" };
    if (req.status !== OPEN) return { granted: false, reason: "request_closed" };
    if (req.deliveries > 0) return { granted: false, reason: "already_delivered" };
    if (this.now() - req.createdAt < m.settings.triggerGraceSec * 1000) return { granted: false, reason: "grace_period" };
    if (req.triggers.length && !req.retriggerAllowed) return { granted: false, reason: "already_triggered" };
    this._emit(m, "trigger_claimed", participant, { requestId, instanceId: String(instanceId || "").slice(0, 64) });
    const message =
      `【Roundtable】あなたの番です（依頼 ${req.id}）。` +
      `Roundtable の get_my_turn ツールを request_id="${req.id}" で呼んで依頼内容を確認し、post_message で回答してください。`;
    return { granted: true, message };
  }

  triggerResult(participant, { requestId, instanceId, result, detail }) {
    const m = this.requireActive();
    const req = m.requests[requestId];
    if (!req || req.participant !== participant) throw new CommandError("forbidden", "この依頼はあなた宛てではありません");
    const ok = ["sent", "rejected", "unknown"].includes(result) ? result : "unknown";
    this._emit(m, "trigger_result", participant, { requestId, instanceId: String(instanceId || "").slice(0, 64), result: ok, detail: String(detail || "").slice(0, 500) });
    return { status: "recorded" };
  }

  // ---------------------------------------------------------------- views
  participantView(m, id) {
    const pr = this.presence[id];
    const p = m.participants[id];
    const req = this._nextOpenFor(m, id);
    const now = this.now();
    let state = "idle";
    let detail = "";
    if (!m.members[id].read) state = "excluded";
    else if (!pr.lastSeenAt && !pr.widgetSeenAt) state = "offline";
    if (req) {
      if (req.deliveries > 0) {
        state = "processing";
        detail = `依頼 ${req.id} を受信済み・回答待ち`;
      } else {
        const lastTrig = req.triggers[req.triggers.length - 1];
        const age = (now - req.createdAt) / 1000;
        if (lastTrig && lastTrig.result === "unknown") {
          state = "needs_confirmation";
          detail = "通知の送信結果が不明（自動再送はしません）";
        } else if (lastTrig && now - lastTrig.at > 30000) {
          state = "needs_confirmation";
          detail = "通知後30秒以上未受信。AI側の承認ダイアログや入力待ちを確認してください";
        } else if (!lastTrig && age > 45) {
          state = "needs_confirmation";
          detail = "依頼後45秒以上未受信。AI側の画面を確認してください";
        } else {
          state = "requested";
          detail = `依頼 ${req.id} を送付済み・未受信`;
        }
      }
    } else if (p.error) {
      state = "error";
      detail = `${p.error.kind}: ${p.error.detail}`;
    } else if (state !== "offline" && state !== "excluded") {
      const last = [...m.requestOrder].reverse().map((rid) => m.requests[rid]).find((r) => r.participant === id);
      if (last && last.status === "answered") state = "posted";
      else state = "idle";
    }
    return {
      id,
      name: DISPLAY_NAMES[id],
      state,
      detail,
      role: m.roles[id],
      member: m.members[id],
      wake: m.settings.wake[id],
      lastSeenAt: pr.lastSeenAt,
      lastVia: pr.lastVia,
      waiting: !!pr.waitingSince,
      widgetSeenAt: pr.widgetSeenAt,
      widgetInstances: pr.widgetInstances.size,
      openRequest: req ? { id: req.id, createdAt: req.createdAt, deadlineAt: req.deadlineAt, deliveries: req.deliveries, triggers: req.triggers } : null,
      observation: p.observation,
    };
  }

  snapshot() {
    const m = this.active;
    if (!m) return { meeting: null, warnings: this.warnings };
    const run = this._run(m);
    return {
      meeting: {
        id: m.id,
        title: m.title,
        status: m.status,
        endReason: m.endReason,
        createdAt: m.createdAt,
        premise: m.premise,
        order: m.order,
        settings: m.settings,
        messages: m.messages,
        notices: m.notices,
        hypotheses: m.hypotheses,
        requests: m.requestOrder.slice(-60).map((id) => m.requests[id]),
        run,
        eventCount: m.eventCount,
      },
      participants: AI_IDS.map((id) => this.participantView(m, id)),
      now: this.now(),
      warnings: this.warnings,
    };
  }

  probeReport() {
    const m = this.requireActive();
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
      let wakeRoute = null;
      if (rb?.firstDeliveredAt) {
        if (rb.deliveredVia === "wait") wakeRoute = "稼働中タスク内の待機（wait_for_my_turn）";
        else if (rb.triggers.length) wakeRoute = "処理終了後のイベント再起動（パネル通知 → get_my_turn）";
        else if (rb.deliveredVia === "web") wakeRoute = "参加者ページ";
        else wakeRoute = "通知記録なしで get_my_turn（人の入力など、経路不明）";
      }
      return {
        runId: run.id,
        participant: run.probe.participant,
        delaySec: run.probe.delaySec,
        state: run.state,
        reason: run.reason,
        A: ra,
        B: rb,
        waitedSec: ra?.answeredAt && rb?.firstDeliveredAt ? Math.round((rb.firstDeliveredAt - ra.answeredAt) / 1000) : null,
        wakeRoute,
        passed: !!(ra?.codeFound && rb?.codeFound && rb.status === "answered"),
      };
    });
  }

  exportJson() {
    const m = this.requireActive();
    const { events } = this.store.load(m.id);
    return { format: "roundtable-meeting/1", meeting: this.snapshot().meeting, events };
  }
}

function cleanHypothesis(h) {
  const s = (v) => String(v ?? "").slice(0, 2000);
  return { title: s(h?.title), difference: s(h?.difference), prediction: s(h?.prediction), falsification: s(h?.falsification), observation: s(h?.observation) };
}
