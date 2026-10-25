// Chair UI. All state comes from the server (SSE); this file only renders it
// and sends chair commands. AI text is always inserted as text, never HTML.

const TOKEN = window.CHAIR_TOKEN;
const NAMES = { chair: "議長", claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini" };
const AI = ["claude", "chatgpt", "gemini"];
const STATE_LABEL = {
  idle: "待機",
  requested: "依頼済み（未受信）",
  processing: "処理中",
  posted: "投稿済み",
  needs_confirmation: "確認待ち？",
  error: "エラー",
  offline: "未接続",
  excluded: "対象外",
};
const RUN_LABEL = { running: "進行中", paused: "一時停止", stopped: "停止", completed: "完了" };
const KIND_LABEL = { auto: "AIだけで続ける", ask: "質問", probe: "接続試験" };

let S = null; // latest state
let drafts = {}; // unsaved form edits survive re-render
let showNew = false; // "新しい会議" form opened while a meeting is still open

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const ago = (t) => {
  if (!t) return "—";
  const s = Math.round((S.now - t) / 1000);
  return s < 60 ? `${s}秒前` : s < 3600 ? `${Math.round(s / 60)}分前` : `${Math.round(s / 3600)}時間前`;
};

function toast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), ms);
}

async function act(action, body = {}) {
  try {
    const r = await fetch(`/api/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-roundtable-chair": TOKEN }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || j.error);
    return j;
  } catch (e) {
    toast(`エラー: ${e.message}`, 6000);
    throw e;
  }
}

// ---------------------------------------------------------------- tabs
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.id === `tab-${b.dataset.tab}`));
    try { localStorage.setItem("rt-tab", b.dataset.tab); } catch {}
    if (b.dataset.tab === "probe") loadLog();
  }),
);
try {
  const t = localStorage.getItem("rt-tab");
  if (t) document.querySelector(`.tabs button[data-tab="${t}"]`)?.click();
} catch {}

// ---------------------------------------------------------------- stream
function connect() {
  const es = new EventSource(`/api/stream?k=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    S = JSON.parse(e.data);
    $("conn").textContent = "接続中 ✓";
    render();
  };
  es.onerror = () => {
    $("conn").textContent = "サーバーに再接続中…";
  };
}
connect();

// ---------------------------------------------------------------- render
function render() {
  const m = S.meeting;
  $("meetingTitle").textContent = m ? `${m.title}${m.status === "ended" ? "（終了）" : ""}` : "会議なし";
  const run = m?.run;
  const rb = $("runBadge");
  rb.textContent = run ? `${KIND_LABEL[run.kind] || run.kind}: ${RUN_LABEL[run.state]}` : "待機";
  rb.className = `badge ${run?.state || ""}`;
  $("noMeeting").classList.toggle("hidden", !!(m && m.status === "open") && !showNew);
  $("meetingView").classList.toggle("hidden", !m);
  if (m) {
    renderMeeting(m);
    renderConfig(m);
    renderRecord(m);
  }
  renderProbe(m);
  renderSetup();
}

function renderMeeting(m) {
  $("premiseVer").textContent = m.premise.version;
  $("topicText").textContent = m.premise.topic + (m.premise.instructions ? `\n\n${m.premise.instructions}` : "");
  $("orderText").textContent = m.order.map((id) => NAMES[id]).join(" → ");

  // timeline: messages + settings notices, in time order
  const tl = $("timeline");
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 40;
  const items = [...m.messages.map((x) => ({ at: x.at, k: "m", x })), ...m.notices.map((x) => ({ at: x.at, k: "n", x }))].sort((a, b) => a.at - b.at || (a.k === "n" ? -1 : 1));
  tl.replaceChildren(
    ...items.map(({ k, x }) => {
      if (k === "n") return el("div", { class: "notice" }, `⚙ ${fmtTime(x.at)} ${x.text}`);
      const tags = [];
      if (x.status === "stale") tags.push(el("span", { class: "tag warn" }, `旧前提・未転送${x.reason ? `（${x.reason}）` : ""}`));
      if (x.status === "late") tags.push(el("span", { class: "tag warn" }, `期限後・未転送${x.reason ? `（${x.reason}）` : ""}`));
      if (x.adoptedFrom) tags.push(el("span", { class: "tag" }, `#${x.adoptedFrom} を採用`));
      return el(
        "div",
        { class: `msg ${x.speaker} ${x.status}` },
        el("div", { class: "head" }, el("span", { class: "who" }, NAMES[x.speaker]), x.roleName ? el("span", {}, x.roleName) : null, x.phase ? el("span", {}, x.phase) : null, el("span", {}, `#${x.seq}`), el("span", {}, fmtTime(x.at)), el("span", {}, `前提v${x.premiseVersion}`), x.requestId ? el("span", {}, x.requestId) : null, ...tags),
        el("div", { class: "body" }, x.text),
        ...x.summaries.map((s) => el("div", { class: "summary" }, `要約: ${s.text}`)),
        el(
          "div",
          { class: "actions" },
          el("button", { onclick: () => addSummary(x) }, "要約を付ける"),
          x.status !== "accepted" && m.status === "open" ? el("button", { onclick: () => act("adopt", { messageId: x.id }) }, "記録に採用") : null,
        ),
      );
    }),
  );
  if (atBottom) tl.scrollTop = tl.scrollHeight;

  // participants
  $("participants").replaceChildren(
    ...S.participants.map((p) => {
      const req = p.openRequest;
      const lc = S.presence?.[p.id]?.lastClient;
      const wake = [p.wake.wait && "待機", p.wake.panel && "パネル", p.wake.events && "MCP Events"].filter(Boolean).join("・") || "参加者ページ";
      return el(
        "div",
        { class: `pcard ${p.id}` },
        el("div", { class: "row wrap" }, el("span", { class: "name" }, p.name), el("span", { class: "muted small" }, p.role.name), el("span", { class: `state ${p.state}` }, STATE_LABEL[p.state] || p.state)),
        p.detail ? el("div", { class: "small" }, p.detail) : null,
        el("div", { class: "small muted" }, `最終接続 ${ago(p.lastSeenAt)}${p.lastVia ? `（${p.lastVia}）` : ""}${p.waiting ? "・待機中" : ""}${lc ? `・${lc.era === "modern" ? "MCP 2026-07-28" : "MCP 2025"}` : ""}`),
        el("div", { class: "small muted" }, `起こし方: ${wake}${p.widgetSeenAt ? `・パネル ${ago(p.widgetSeenAt)}` : ""}`),
        req
          ? el(
              "div",
              { class: "row wrap small" },
              el("span", {}, `期限 ${fmtTime(req.deadlineAt)}`),
              el("button", { onclick: () => act("skip", { requestId: req.id }) }, "スキップ"),
              req.triggers.length && !req.deliveries ? el("button", { onclick: () => act("retrigger", { requestId: req.id }) }, "再通知を許可") : null,
            )
          : null,
      );
    }),
  );

  // auto-run panel
  const sel = $("autoPreset");
  if (!sel.options.length) for (const [k, v] of Object.entries(S.presets.phases)) sel.append(el("option", { value: k }, v.name));
  const run = m.run;
  const open = m.status === "open";
  $("startAuto").disabled = !open;
  $("pause").disabled = !(open && run?.state === "running");
  $("resume").disabled = !(open && run?.state === "paused");
  $("stop").disabled = !(open && ["running", "paused"].includes(run?.state));
  $("endMeeting").disabled = !open;
  document.querySelectorAll("[data-ask]").forEach((b) => (b.disabled = !open));
  if (run) {
    const lim = run.limits || {};
    const el2 = Math.round((S.now - run.startedAt) / 60000);
    $("runInfo").textContent = `${KIND_LABEL[run.kind]}: ${RUN_LABEL[run.state]}${run.reason ? `（${run.reason}）` : ""}／発言 ${run.accepted}${lim.maxTurns ? `/${lim.maxTurns}` : ""}／経過 ${el2}分${lim.maxMinutes ? `/${lim.maxMinutes}分` : ""}`;
  } else $("runInfo").textContent = "";
}

function addSummary(msg) {
  const t = prompt(`#${msg.seq} の要約（原文は残ります）`);
  if (t && t.trim()) act("summary", { messageId: msg.id, text: t.trim() });
}

// ---------------------------------------------------------------- composer & controls
document.querySelectorAll("[data-ask]").forEach((b) =>
  b.addEventListener("click", async () => {
    const text = $("chairText").value.trim();
    if (!text) return toast("発言を入力してください");
    await act("post", { text, ask: b.dataset.ask || null, parallel: $("askParallel").checked });
    $("chairText").value = "";
  }),
);
$("chairText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) document.querySelector('[data-ask="all"]').click();
});
$("createMeeting").addEventListener("click", async () => {
  await act("meeting", { title: $("newTitle").value, topic: $("newTopic").value, instructions: $("newInstructions").value });
  $("newTitle").value = $("newTopic").value = $("newInstructions").value = "";
  showNew = false;
  orderDraft = null;
  render();
});
$("newMeetingBtn").addEventListener("click", () => {
  if (S.meeting?.status === "open" && !confirm("新しい会議を作ると、今の会議は終了します。よろしいですか？")) return;
  showNew = true;
  $("noMeeting").classList.remove("hidden");
  $("newTopic").focus();
});
$("startAuto").addEventListener("click", () => act("auto", { presetId: $("autoPreset").value, maxTurns: Number($("autoTurns").value), maxMinutes: Number($("autoMinutes").value) }));
$("pause").addEventListener("click", () => act("pause"));
$("resume").addEventListener("click", () => act("resume"));
$("stop").addEventListener("click", () => act("stop"));
$("endMeeting").addEventListener("click", () => confirm("会議を終了しますか？（終了後は再開できません）") && act("end"));

// ---------------------------------------------------------------- probe
function renderProbe(m) {
  $("probeTopic").textContent = m ? m.premise.topic : "（会議がありません）";
  const open = m?.requests.filter((r) => r.status === "open") || [];
  $("probeTurn").textContent = open.length ? open.map((r) => `${NAMES[r.participant]}（${r.id}${r.phase ? `・${r.phase}` : ""}・${r.deliveries ? "受信済み" : "未受信"}）`).join("、") : m?.run?.stepDueAt && m.run.state === "running" ? `待機中（依頼Bは ${fmtTime(m.run.stepDueAt)} に送信）` : "なし";
  $("startProbe").disabled = !(m && m.status === "open");
  $("stopProbe").disabled = !(m?.run?.kind === "probe" && ["running", "paused"].includes(m.run.state));
  if (m) refreshProbeResults();
  // observation form
  const who = $("obsWho").value;
  const obs = S.participants.find((p) => p.id === who)?.observation || {};
  document.querySelectorAll("[data-obs]").forEach((i) => {
    const key = `${who}.${i.dataset.obs}`;
    if (document.activeElement !== i && !(key in drafts)) i.value = obs[i.dataset.obs] || "";
  });
}
document.querySelectorAll("[data-obs]").forEach((i) => i.addEventListener("input", () => (drafts[`${$("obsWho").value}.${i.dataset.obs}`] = true)));
$("obsWho").addEventListener("change", () => {
  drafts = {};
  render();
});
$("saveObs").addEventListener("click", async () => {
  const fields = {};
  document.querySelectorAll("[data-obs]").forEach((i) => (fields[i.dataset.obs] = i.value));
  await act("observation", { participant: $("obsWho").value, fields });
  drafts = {};
  toast("保存しました");
});
const PROBE_WAKE = {
  wait: { wait: true, panel: false, events: false },
  panel: { wait: false, panel: true, events: false },
  events: { wait: false, panel: false, events: true },
  web: { wait: false, panel: false, events: false },
};
async function updateProbePrompt() {
  const mode = $("probeMode").value;
  const w = PROBE_WAKE[mode];
  const q = new URLSearchParams({ participant: $("probeWho").value, route: mode === "web" ? "web" : "mcp", wait: w.wait ? "1" : "0", panel: w.panel ? "1" : "0", events: w.events ? "1" : "0" });
  try {
    $("probePrompt").textContent = (await (await fetch(`/api/prompt?${q}`)).json()).text;
  } catch {}
}
["probeWho", "probeMode"].forEach((id) => $(id).addEventListener("change", updateProbePrompt));
$("copyProbePrompt").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("probePrompt").textContent); toast("コピーしました"); } catch { toast("コピーできませんでした"); }
});
$("startProbe").addEventListener("click", () => act("probe", { participant: $("probeWho").value, delaySec: Number($("probeDelay").value), wake: PROBE_WAKE[$("probeMode").value] }));
$("stopProbe").addEventListener("click", () => act("stop"));
$("chain6").addEventListener("click", () => act("auto", { presetId: "free", maxTurns: 6, maxMinutes: 60 }));
$("chain9").addEventListener("click", () => act("auto", { presetId: "free", maxTurns: 9, maxMinutes: 90 }));
$("chainStop").addEventListener("click", () => act("stop"));
setTimeout(updateProbePrompt, 500);

let probeTimer = null;
function refreshProbeResults() {
  if (probeTimer) return;
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    try {
      const { reports, chain } = await (await fetch("/api/probe-report")).json();
      renderChain(chain);
      const rows = reports.map((r) => {
        const cell = (x) => (x ? `${x.status}${x.deliveredVia ? `／受信: ${x.deliveredVia}` : ""}${x.codeFound ? "／合言葉 ✓" : x.status === "answered" ? "／合言葉 ✗" : ""}` : "—");
        return el(
          "tr",
          {},
          el("td", {}, NAMES[r.participant]),
          el("td", {}, `${r.delaySec}秒`),
          el("td", {}, cell(r.A)),
          el("td", {}, cell(r.B)),
          el("td", {}, r.waitedSec != null ? `${r.waitedSec}秒` : "—"),
          el("td", {}, r.wakeRoute || "—"),
          el("td", { class: r.passed ? "pass" : r.state === "running" ? "" : "fail" }, r.passed ? "成立" : r.state === "running" ? "実施中" : `不成立（${RUN_LABEL[r.state]}${r.reason ? `: ${r.reason}` : ""}）`),
        );
      });
      $("probeResults").replaceChildren(
        rows.length
          ? el("table", {}, el("tr", {}, ...["対象", "待機", "依頼A", "依頼B", "A回答→B受信", "Bの受け取り方", "判定"].map((h) => el("th", {}, h))), ...rows.reverse())
          : el("div", { class: "muted" }, "まだ試験していません"),
      );
    } catch {}
    if ($("autoLog").checked && document.querySelector('.tabs button[data-tab="probe"]').classList.contains("active")) loadLog();
  }, 300);
}

function renderChain(c) {
  if (!c) return $("chainResults").replaceChildren(el("div", { class: "muted" }, "まだ実施していません"));
  const head = el(
    "div",
    {},
    `${RUN_LABEL[c.state] || c.state}${c.reason ? `（${c.reason}）` : ""}／回答 ${c.answered}${c.limits?.maxTurns ? `/${c.limits.maxTurns}` : ""}／人の操作なしで届いた回答 ${c.automaticAnswered}／直前のAIを引用 ${c.quotedPrevious}`,
  );
  const rows = c.rows.map((r) =>
    el(
      "tr",
      {},
      el("td", {}, r.seq ? `#${r.seq}` : "—"),
      el("td", {}, r.name),
      el("td", {}, r.status + (r.closeReason ? `（${r.closeReason}）` : "") + (r.lateMessages ? `／遅れて届いた回答 ${r.lateMessages}件` : "")),
      el("td", { class: r.wakeCode ? (r.automatic ? "pass" : "fail") : "" }, r.wakeRoute || "—"),
      el("td", {}, r.quote ? (r.quote.matched ? `✓ #${r.prevSeq} ${NAMES[r.prevSpeaker]}「${r.quote.sample.slice(0, 20)}…」` : `✗（引用${r.quote.quotes}件・一致なし）`) : "—"),
    ),
  );
  $("chainResults").replaceChildren(head, el("table", {}, el("tr", {}, ...["発言", "話者", "依頼の状態", "受け取り方", "直前のAIの引用"].map((h) => el("th", {}, h))), ...rows));
}

async function loadLog() {
  try {
    const { events } = await (await fetch("/api/log?limit=300")).json();
    // run_progress is bookkeeping for the engine; it stays in the exported log.
    const lines = events.filter((e) => e.type !== "run_progress").map((e) => `${fmtTime(e.at)} #${e.n} ${e.type} [${e.actor}] ${summarize(e)}`);
    const box = $("eventLog");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = lines.join("\n");
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch {}
}
function summarize(e) {
  const d = e.data || {};
  switch (e.type) {
    case "request_created": return `${d.id} → ${NAMES[d.participant]} ${d.phase || ""} 前提v${d.premiseVersion} 役割v${d.roleVersion}`;
    case "request_delivered": return `${d.id} via ${d.via}${d.duplicate ? "（再配信）" : ""}`;
    case "request_closed": return `${d.id} ${d.status}${d.reason ? `: ${d.reason}` : ""}`;
    case "message_posted": return `#${d.seq} ${NAMES[d.speaker]} ${d.status}${d.requestId ? ` ${d.requestId}` : ""} (${(d.text || "").length}字)`;
    case "post_rejected": return `${NAMES[d.participant] || d.participant} ${d.requestId || "-"} ${d.reason} ${d.text || ""}`;
    case "trigger_claimed": return `${d.requestId} パネル ${d.instanceId}${d.manual ? "（手動）" : ""}`;
    case "trigger_result": return `${d.requestId} ${d.result} ${d.detail || ""}`;
    case "wake_attempt": return `${d.requestId} ${d.channel} ${d.result} ${d.detail || ""}`;
    case "run_state": return `${d.state}${d.reason ? `: ${d.reason}` : ""}`;
    case "run_started": return `${d.run.kind} ${d.run.id}`;
    case "problem_reported": return `${NAMES[d.participant]} ${d.kind} ${d.detail || ""}`;
    default: return "";
  }
}
$("refreshLog").addEventListener("click", loadLog);

// ---------------------------------------------------------------- setup
function copyBtn(text, label = "コピー") {
  return el("button", { onclick: async () => { try { await navigator.clipboard.writeText(text); toast("コピーしました"); } catch { toast("コピーできませんでした。手で選択してください"); } } }, label);
}
const SERVICE_STEPS = {
  claude: [
    "claude.ai（またはデスクトップアプリ）で 設定 → コネクタ（Customize → Connectors）→「カスタムコネクタを追加」を開く",
    "名前に Roundtable、URL に下の MCP URL を入れて追加（認証なし）",
    "コネクタのツール設定で post_message・report_problem・panel_* を「常に許可」にする（確認なしで投稿するため。安全確認が出た場合は記録してください）",
    "新しいチャットで ＋ → コネクタ から Roundtable を有効にし、下の「開始時の指示」を貼って送信",
    "Memory を使わない場合は、そのチャットだけ Memory をオフにする（他社の発言を記憶に残さないため）",
  ],
  chatgpt: [
    "chatgpt.com の プラグイン（chatgpt.com/plugins）→ ＋ →「Add custom MCP server」",
    "Server URL に下の MCP URL、認証は「No authentication」で作成し、自分のプラグインとしてインストール",
    "プラグインのページにツールとイベント（turn.assigned）が表示されることを確認",
    "アプリの確認設定を「重要な変更の前だけ」にする（確認の回数は記録してください）",
    "Work チャット（Web、またはデスクトップで Work＋Cloud）を開き、@Roundtable を付けて下の「開始時の指示」を送信",
  ],
  gemini: [
    "Gemini の Tasks（ブラウザを使うタスク）を開く（Google AI Pro/Ultra。地域・言語の条件あり）",
    "下の「開始時の指示（参加者ページ）」を貼ってタスクを開始",
    "フォーム送信の確認が出たら記録し、承認する（Gemini の公式仕様で、送信前の確認は省略できない場合があります）",
    "米国の個人アカウントで Custom apps（MCP）が使える場合は、MCP URL を Custom apps に追加し、MCP 用の指示を使う（書込みは毎回確認が必要と公式に記載）",
  ],
};
function renderSetup() {
  if (document.activeElement !== $("publicUrl") && !("publicUrl" in drafts)) $("publicUrl").value = S.publicUrl;
  const cards = S.setup.map((s) => {
    const w = s.wake;
    const ch = (k, label) =>
      el("label", { class: "inline small" }, el("input", { type: "checkbox", checked: w[k], disabled: !S.meeting || S.meeting.status !== "open", onchange: (e) => act("settings", { wake: { [s.id]: { [k]: e.target.checked } } }) }), label);
    return el(
      "div",
      { class: "card" },
      el("h2", {}, `2. ${s.name}`),
      el("ol", { class: "steps small" }, ...SERVICE_STEPS[s.id].map((t) => el("li", {}, t))),
      el("div", { class: "small" }, "MCP URL（秘密のURLです。他人に共有しないでください）"),
      s.mcpUrl ? el("div", { class: "row" }, el("code", {}, s.mcpUrl), copyBtn(s.mcpUrl)) : el("div", { class: "muted small" }, "公開URLを保存すると表示されます"),
      el("div", { class: "small" }, "参加者ページ（ブラウザで参加する場合）"),
      s.pageUrl ? el("div", { class: "row" }, el("code", {}, s.pageUrl), copyBtn(s.pageUrl)) : el("div", { class: "muted small" }, "—"),
      el("div", { class: "row wrap" }, el("span", { class: "small" }, "次の番の起こし方:"), ch("wait", "タスク内で待機"), ch("panel", "パネル（MCP App）"), ch("events", "MCP Events")),
      el("details", {}, el("summary", { class: "small" }, "開始時の指示（MCP）"), el("div", { class: "copybox" }, el("pre", {}, s.prompts.mcp), copyBtn(s.prompts.mcp))),
      el("details", {}, el("summary", { class: "small" }, "開始時の指示（参加者ページ）"), el("div", { class: "copybox" }, el("pre", {}, s.prompts.web), copyBtn(s.prompts.web))),
      el("div", { class: "row" }, el("button", { onclick: () => confirm(`${s.name} の接続URLを作り直しますか？今の URL は使えなくなります。`) && act("rotate-token", { participant: s.id }) }, "URLを作り直す（漏れた場合）")),
    );
  });
  $("setupCards").replaceChildren(...cards);
  $("subs").replaceChildren(
    S.subscriptions.length
      ? el("table", {}, el("tr", {}, ...["参加者", "イベント", "送信先", "有効期限", "最終送信"].map((h) => el("th", {}, h))), ...S.subscriptions.map((x) => el("tr", {}, el("td", {}, NAMES[x.participant]), el("td", {}, x.name), el("td", {}, x.host), el("td", {}, x.refreshBefore ? new Date(x.refreshBefore).toLocaleString("ja-JP") : "なし"), el("td", {}, x.lastDelivery ? `${x.lastDelivery.result} ${x.lastDelivery.detail}` : "—"))))
      : el("div", { class: "muted" }, "購読はまだありません（ChatGPT の Work チャットで開始時の指示を送ると作られます）"),
  );
}
$("publicUrl").addEventListener("input", () => (drafts.publicUrl = true));
$("savePublicUrl").addEventListener("click", async () => {
  await act("config", { publicUrl: $("publicUrl").value });
  delete drafts.publicUrl;
  toast("保存しました");
});

// ---------------------------------------------------------------- config
function keep(id, value) {
  const i = $(id);
  if (document.activeElement !== i && !(id in drafts)) i.value = value ?? "";
}
["cfgTopic", "cfgInstructions", "cfgTimeout", "cfgGrace", "cfgLength"].forEach((id) => $(id).addEventListener("input", () => (drafts[id] = true)));
let orderDraft = null;
function renderConfig(m) {
  keep("cfgTopic", m.premise.topic);
  keep("cfgInstructions", m.premise.instructions);
  keep("cfgTimeout", m.settings.requestTimeoutSec);
  keep("cfgGrace", m.settings.triggerGraceSec);
  keep("cfgLength", m.settings.lengthHint);
  // roles
  const box = $("roleEditors");
  if (!box.dataset.built || box.dataset.meeting !== m.id) {
    box.dataset.built = "1";
    box.dataset.meeting = m.id;
    box.replaceChildren(
      ...AI.map((id) => {
        const presetSel = el("select", { id: `rolePreset-${id}` }, el("option", { value: "" }, "（自由記述）"), ...Object.entries(S.presets.roles).map(([k, v]) => el("option", { value: k }, v.name)));
        presetSel.addEventListener("change", () => {
          const p = S.presets.roles[presetSel.value];
          if (p) {
            $(`roleName-${id}`).value = p.name;
            $(`roleText-${id}`).value = p.text;
          }
        });
        return el(
          "div",
          { class: "pcard " + id },
          el("div", { class: "name" }, NAMES[id]),
          el("label", {}, "プリセット", presetSel),
          el("label", {}, "役割名", el("input", { id: `roleName-${id}` })),
          el("label", {}, "内容", el("textarea", { id: `roleText-${id}`, rows: 2 })),
          el("button", { onclick: () => act("role", { participant: id, name: $(`roleName-${id}`).value, text: $(`roleText-${id}`).value }) }, "この役割を保存"),
          el("span", { class: "small muted", id: `roleVer-${id}` }),
        );
      }),
    );
  }
  for (const id of AI) {
    const p = S.participants.find((x) => x.id === id);
    if (document.activeElement?.id !== `roleName-${id}` && document.activeElement?.id !== `roleText-${id}`) {
      const n = $(`roleName-${id}`), t = $(`roleText-${id}`);
      if (n.dataset.v !== String(p.role.version)) {
        n.value = p.role.name;
        t.value = p.role.text;
        n.dataset.v = String(p.role.version);
      }
    }
    $(`roleVer-${id}`).textContent = ` 現在 v${p.role.version}`;
  }
  // order
  if (!orderDraft) orderDraft = [...m.order];
  const notIn = AI.filter((id) => !orderDraft.includes(id));
  $("orderEditor").replaceChildren(
    el(
      "div",
      { class: "row wrap" },
      ...orderDraft.map((id, i) =>
        el(
          "span",
          { class: "pcard " + id },
          el("span", { class: "name" }, `${i + 1}. ${NAMES[id]} `),
          el("button", { disabled: i === 0, onclick: () => { [orderDraft[i - 1], orderDraft[i]] = [orderDraft[i], orderDraft[i - 1]]; render(); } }, "↑"),
          el("button", { disabled: orderDraft.length === 1, onclick: () => { orderDraft.splice(i, 1); render(); } }, "外す"),
        ),
      ),
      ...notIn.map((id) => el("button", { onclick: () => { orderDraft.push(id); render(); } }, `＋ ${NAMES[id]}`)),
    ),
  );
  // members
  const mb = $("memberEditor");
  mb.replaceChildren(
    el(
      "table",
      {},
      el("tr", {}, el("th", {}, "参加者"), el("th", {}, "読取"), el("th", {}, "書込")),
      ...S.participants.map((p) =>
        el("tr", {}, el("td", {}, p.name), el("td", {}, el("input", { type: "checkbox", id: `mr-${p.id}`, checked: p.member.read })), el("td", {}, el("input", { type: "checkbox", id: `mw-${p.id}`, checked: p.member.write }))),
      ),
    ),
  );
}
$("savePremise").addEventListener("click", async () => {
  await act("premise", { topic: $("cfgTopic").value, instructions: $("cfgInstructions").value });
  delete drafts.cfgTopic;
  delete drafts.cfgInstructions;
  toast("保存しました");
});
$("saveOrder").addEventListener("click", async () => {
  await act("order", { order: orderDraft });
  orderDraft = null;
  toast("保存しました");
});
$("saveMembers").addEventListener("click", async () => {
  const members = {};
  for (const id of AI) members[id] = { read: $(`mr-${id}`).checked, write: $(`mw-${id}`).checked };
  await act("members", { members });
  toast("保存しました");
});
$("saveSettings").addEventListener("click", async () => {
  await act("settings", { requestTimeoutSec: Number($("cfgTimeout").value), triggerGraceSec: Number($("cfgGrace").value), lengthHint: $("cfgLength").value });
  ["cfgTimeout", "cfgGrace", "cfgLength"].forEach((k) => delete drafts[k]);
  toast("保存しました");
});

// ---------------------------------------------------------------- record
function renderRecord(m) {
  $("hypList").replaceChildren(
    m.hypotheses.length
      ? el(
          "table",
          {},
          el("tr", {}, ...["見出し", "状態", "出典", "反証条件", ""].map((h) => el("th", {}, h))),
          ...m.hypotheses.map((h) =>
            el("tr", {}, el("td", {}, h.title), el("td", {}, h.status), el("td", {}, (h.sourceSeqs || []).map((s) => `#${s}`).join(", ")), el("td", {}, h.falsification), el("td", {}, el("button", { onclick: () => editHyp(h) }, "編集"))),
          ),
        )
      : el("div", { class: "muted small" }, "まだ記録はありません"),
  );
}
function editHyp(h) {
  $("hypId").value = h.id;
  $("hypTitle").value = h.title;
  $("hypSources").value = (h.sourceSeqs || []).join(", ");
  $("hypDiff").value = h.difference;
  $("hypPred").value = h.prediction;
  $("hypFals").value = h.falsification;
  $("hypObs").value = h.observation;
  $("hypStatus").value = h.status;
}
$("saveHyp").addEventListener("click", async () => {
  await act("hypothesis", {
    id: $("hypId").value || undefined,
    title: $("hypTitle").value,
    sourceSeqs: $("hypSources").value.split(/[,、\s]+/).filter(Boolean),
    difference: $("hypDiff").value,
    prediction: $("hypPred").value,
    falsification: $("hypFals").value,
    observation: $("hypObs").value,
    status: $("hypStatus").value,
  });
  $("clearHyp").click();
  toast("保存しました");
});
$("clearHyp").addEventListener("click", () => {
  ["hypId", "hypTitle", "hypSources", "hypDiff", "hypPred", "hypFals", "hypObs"].forEach((id) => ($(id).value = ""));
});
