// side_panel.js — Roundtable のサイドパネル UI ロジック
// ============================================================
// Phase 3a Step1（ルーティング一般化）:
//   - 「対象 AI」ドロップダウン（claude / chatgpt）を追加
//   - 「送信先タブ」は対象 AI のタブのみを list_ai_tabs で取得
//   - 送信／ping／DOMロガー／連続テスト(E) は選択中の target を毎回渡す
//   - 対象 AI 切替時はタブ一覧を自動再取得
//   - background / content_script からの log メッセージをログエリアに反映
// claude を選んでいる限り送信パイプラインは Phase 2 と完全同一（リグレッ
// ションなし）。chatgpt の content_script 実装は Step2 以降。
// ============================================================

// 対象 AI のラベル / アバター絵文字（仕様書 §6: Claude🟧 / ChatGPT🟩）
const AI_TARGET_META = {
  claude: { label: "Claude", site: "claude.ai", emoji: "🟧" },
  chatgpt: { label: "ChatGPT", site: "chatgpt.com", emoji: "🟩" },
};
const DEFAULT_TARGET = "claude";

const $log = document.getElementById("log");
const $message = document.getElementById("message");
const $send = document.getElementById("send");
const $clear = document.getElementById("clear-log");
const $domLogger = document.getElementById("dom-logger");
const $showLatestLog = document.getElementById("show-latest-log");
const $showLatestSnapshot = document.getElementById("show-latest-snapshot");
const $showLatestAutoLog = document.getElementById("show-latest-auto-log");
const $ping = document.getElementById("ping");
const $aiTarget = document.getElementById("ai-target");
const $tabSelect = document.getElementById("tab-select");
const $reloadTabs = document.getElementById("reload-tabs");
const $useCurrentTab = document.getElementById("use-current-tab");
const $silenceTimeout = document.getElementById("silence-timeout");
const $backstopTimeout = document.getElementById("backstop-timeout");
const $saveSettings = document.getElementById("save-settings");
const $settingsStatus = document.getElementById("settings-status");
// Phase 2 E: 連続テストモード関連
const $testMessages = document.getElementById("test-messages");
const $testCount = document.getElementById("test-count");
const $testIntervalMin = document.getElementById("test-interval-min");
const $testIntervalMax = document.getElementById("test-interval-max");
const $testStart = document.getElementById("test-start");
const $testAbort = document.getElementById("test-abort");
const $testProgress = document.getElementById("test-progress");
const $testProgressText = document.getElementById("test-progress-text");
const $testProgressFill = document.getElementById("test-progress-fill");
const $testResults = document.getElementById("test-results");
const $testSummary = document.getElementById("test-summary");

const NO_TAB_VALUE = "__none__";

// Phase 2 A3: 無音タイムアウト設定。chrome.storage.local に永続化、
// 送信時に毎回 content_script へ渡す。
const SETTINGS_KEY = "roundtable_settings";
const DEFAULT_SILENCE_TIMEOUT_SEC = 30;
let cachedSilenceTimeoutSec = DEFAULT_SILENCE_TIMEOUT_SEC;
// Phase 3a Step1 fix3: バックストップ時間の可変化（最終安全弁）。
// content_script (claude.js) は settings.backstop_timeout_ms を既に解釈し、
// 「backstop_ms >= silence_ms」でなければ既定 600 秒にフォールバックする。
// よって UI 側で「バックストップ ≥ 無音タイムアウト」を保証して送る。
const DEFAULT_BACKSTOP_SEC = 600;
const MAX_BACKSTOP_SEC = 3600;
let cachedBackstopSec = DEFAULT_BACKSTOP_SEC;

// Phase 2 E: 連続テストモードの定数と状態
const E_TEST_RESULT_KEY_PREFIX = "e_test_result_";
const E_TEST_MAX_STORED = 5;
const E_TEST_BUSY_EXTRA_SLEEP_MS = 10000;
const DEFAULT_TEST_MESSAGES = [
  "こんにちは",
  "今日は何曜日？",
  "1+1=?",
  "コーヒーと紅茶どちらが好き？",
  "おすすめの本を 1 冊",
  "短く挨拶して",
  "JavaScript について 1 行で説明",
  "Hello",
];
let testRunning = false;
let testAbortRequested = false;

const LEVEL_PREFIX = {
  info: "•",
  ok: "✓",
  warn: "⚠",
  error: "✗",
};

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function formatTimestamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function appendLog({ level = "info", message = "", timestamp = null }) {
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = `[${formatTimestamp(timestamp)}]`;
  const prefix = LEVEL_PREFIX[level] || "•";
  line.appendChild(ts);
  line.appendChild(document.createTextNode(`${prefix} ${message}`));
  $log.appendChild(line);
  $log.scrollTop = $log.scrollHeight;
}

function logInfo(msg) { appendLog({ level: "info", message: msg }); }
function logOk(msg) { appendLog({ level: "ok", message: msg }); }
function logWarn(msg) { appendLog({ level: "warn", message: msg }); }
function logError(msg) { appendLog({ level: "error", message: msg }); }

function shortenPath(path) {
  // 各セグメントが 12 文字を超えていたら先頭 8 文字 + "..." に短縮。
  // /chat/92b351a5-1234-...  →  /chat/92b351a5...
  return path
    .split("/")
    .map((seg) => (seg.length > 12 ? seg.slice(0, 8) + "..." : seg))
    .join("/");
}

// ChatGPT の pathname を「小さなサブ情報」に圧縮する。
//   /                          → 新規チャット
//   /c/<uuid>                  → /c/<6文字>…
//   /g/g-p-.../c/<uuid>        → Proj /c/<6文字>…（プロジェクト内会話）
//   /g/g-...                   → カスタムGPT
//   その他 (/gpts 等)          → 短縮 path
function chatgptUrlHint(pathname) {
  if (!pathname || pathname === "/") return "新規チャット";
  const cMatch = pathname.match(/\/c\/([0-9a-f-]+)/i);
  const isProject = pathname.startsWith("/g/");
  if (cMatch) {
    return (isProject ? "Proj " : "") + "/c/" + cMatch[1].slice(0, 6) + "…";
  }
  if (isProject) return "カスタムGPT";
  let p = shortenPath(pathname);
  if (p.length > 20) p = p.slice(0, 18) + "…";
  return p;
}

// 対象 AI ごとにタブ表示を分岐。
//   Claude  : 既存挙動を維持（[path] title）。Kazuya 検証済みなので変えない
//   ChatGPT : タイトル優先、URL は小さなサブ情報（タイトルで話題を即識別）
// UX 最重要観点 = Kazuya が「どのタブが何の話か」を素早く識別できること。
// Claude Code 内で完璧を狙わず、Kazuya の FB で反復する前提。
function formatTabLabel(tab, targetKey) {
  const marker = tab.isCurrentWindowActive ? "★ " : "  ";
  let pathname = "/";
  try {
    pathname = new URL(tab.url).pathname || "/";
  } catch (_) {}
  const rawTitle = (tab.title || "").trim();

  if (targetKey === "chatgpt") {
    // タブタイトル末尾の " - ChatGPT" / " | ChatGPT" を剥がして読みやすく
    let title = rawTitle.replace(/\s*[-|]\s*ChatGPT\s*$/i, "").trim();
    const isNew = pathname === "/";
    if (!title || /^chatgpt$/i.test(title)) {
      title = isNew ? "新規チャット" : "(Untitled)";
    }
    const titleShort =
      title.length > 44 ? title.slice(0, 41) + "…" : title;
    return `${marker}${titleShort}  · ${chatgptUrlHint(pathname)}`;
  }

  // Claude（既存挙動を維持）
  let path = shortenPath(pathname);
  if (path.length > 36) path = path.slice(0, 33) + "...";
  const titleShort =
    rawTitle.length > 40 ? rawTitle.slice(0, 37) + "..." : rawTitle;
  return `${marker}[${path}] ${titleShort || "(無題)"}`;
}

function getSelectedTabId() {
  const v = $tabSelect.value;
  if (!v || v === NO_TAB_VALUE) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function getSelectedTarget() {
  const v = $aiTarget ? $aiTarget.value : DEFAULT_TARGET;
  return AI_TARGET_META[v] ? v : DEFAULT_TARGET;
}

function targetMeta(targetKey) {
  return AI_TARGET_META[targetKey] || AI_TARGET_META[DEFAULT_TARGET];
}

function setActionButtonsEnabled(enabled) {
  $send.disabled = !enabled;
  $ping.disabled = !enabled;
}

function trySelectTabId(tabId) {
  if (tabId == null) return false;
  for (const opt of $tabSelect.options) {
    if (parseInt(opt.value, 10) === tabId) {
      opt.selected = true;
      return true;
    }
  }
  return false;
}

async function refreshTabs(options = {}) {
  const { selectCurrentActive = false } = options;
  const target = getSelectedTarget();
  const tm = targetMeta(target);
  const previousTabId = getSelectedTabId();
  $reloadTabs.disabled = true;
  $useCurrentTab.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "list_ai_tabs",
      target,
    });
    if (!response || !response.ok) {
      logError(
        `タブ一覧取得失敗: ${response && response.error ? response.error : "(原因不明)"}`,
      );
      $tabSelect.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = NO_TAB_VALUE;
      opt.textContent = "(タブ一覧取得に失敗)";
      opt.disabled = true;
      opt.selected = true;
      $tabSelect.appendChild(opt);
      setActionButtonsEnabled(false);
      return;
    }
    const tabs = response.tabs || [];
    $tabSelect.innerHTML = "";
    if (tabs.length === 0) {
      const opt = document.createElement("option");
      opt.value = NO_TAB_VALUE;
      opt.textContent = `(${tm.site} タブが開かれていません)`;
      opt.disabled = true;
      opt.selected = true;
      $tabSelect.appendChild(opt);
      setActionButtonsEnabled(false);
      logWarn(
        `${tm.label} (${tm.site}) のタブが見つかりません。Chrome で ${tm.site} を開いてから「再読込」を押してください。`,
      );
      return;
    }
    for (const t of tabs) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      opt.textContent = formatTabLabel(t, target);
      opt.title = t.url;
      $tabSelect.appendChild(opt);
    }

    // 選択優先順位:
    //   selectCurrentActive=true なら currentTabId を最優先
    //   それ以外は previousTabId（直前の選択）→ currentTabId（初回ロード時）→ 先頭
    let chosen = null;
    let reason = "";
    if (selectCurrentActive && response.currentTabId != null) {
      chosen = response.currentTabId;
      reason = "current-active";
    } else if (previousTabId != null) {
      chosen = previousTabId;
      reason = "preserve-previous";
    } else if (response.currentTabId != null) {
      chosen = response.currentTabId;
      reason = "initial-current-active";
    }

    const selected = trySelectTabId(chosen);
    if (!selected) {
      $tabSelect.options[0].selected = true;
      reason = "fallback-first";
    }

    setActionButtonsEnabled(true);

    const reasonNote = {
      "current-active": "（現在のタブを選択）",
      "preserve-previous": "（前の選択を維持）",
      "initial-current-active": "（起動時: 現在のタブを自動選択）",
      "fallback-first": "（先頭にフォールバック）",
    }[reason] || "";

    logInfo(
      `[${tm.label}] ${tm.site} タブ ${tabs.length} 件を読み込みました${reasonNote}。`,
    );
    if (selectCurrentActive && response.currentTabId == null) {
      const urlNote = response.currentTabUrl
        ? ` (url=${response.currentTabUrl})`
        : "";
      logWarn(
        `現在のアクティブタブは ${tm.site} ではありません${urlNote}。手動でドロップダウンから選んでください。`,
      );
    }
  } catch (e) {
    logError(`タブ一覧取得エラー: ${e && e.message ? e.message : e}`);
    setActionButtonsEnabled(false);
  } finally {
    $reloadTabs.disabled = false;
    $useCurrentTab.disabled = false;
  }
}

function makeCopyButton(getText, label = "📋 コピー") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      const original = btn.textContent;
      btn.textContent = "✓ コピーしました";
      setTimeout(() => (btn.textContent = original), 1800);
    } catch (_e) {
      btn.textContent = "✗ コピー失敗";
    }
  });
  return btn;
}

function appendJsonBlock({ title, json, storageKey }) {
  const wrap = document.createElement("div");
  wrap.className = "log-line info";
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = `[${formatTimestamp()}]`;
  wrap.appendChild(ts);
  const titleText = storageKey
    ? `• ${title} — storage_key=${storageKey}`
    : `• ${title}`;
  wrap.appendChild(document.createTextNode(titleText));

  const pre = document.createElement("div");
  pre.className = "log-block";
  pre.textContent = JSON.stringify(json, null, 2);
  wrap.appendChild(pre);

  const actions = document.createElement("div");
  actions.className = "block-actions";
  actions.appendChild(
    makeCopyButton(() => JSON.stringify(json, null, 2), "📋 JSON をコピー"),
  );
  wrap.appendChild(actions);

  $log.appendChild(wrap);
  $log.scrollTop = $log.scrollHeight;
}

function appendResponseBlock({ text, selector, target }) {
  const tm = targetMeta(target || DEFAULT_TARGET);
  const frame = document.createElement("div");
  frame.className = "response-frame";

  const header = document.createElement("div");
  header.className = "response-header";
  const label = document.createElement("span");
  label.textContent = `${tm.emoji} ${tm.label} 応答 (${formatTimestamp()}, ${text.length}字)`;
  const meta = document.createElement("span");
  meta.className = "response-meta";
  meta.textContent = selector ? `selector=${selector}` : "";
  header.appendChild(label);
  header.appendChild(meta);
  frame.appendChild(header);

  const body = document.createElement("div");
  body.className = "response-text";
  body.textContent = text;
  frame.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "block-actions";
  actions.appendChild(makeCopyButton(() => text, "📋 コピー"));
  frame.appendChild(actions);

  $log.appendChild(frame);
  $log.scrollTop = $log.scrollHeight;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "log") {
    appendLog({
      level: msg.level || "info",
      message: msg.message || "",
      timestamp: msg.timestamp || null,
    });
    return;
  }
  if (msg.type === "dom_log_result") {
    logOk(
      `DOMログ受信。events=${msg.result && msg.result.event_count}, truncated=${msg.result && msg.result.truncated}`,
    );
    appendJsonBlock({
      title: "DOMロガー結果",
      json: msg.result,
      storageKey: msg.storage_key,
    });
    $domLogger.disabled = false;
    return;
  }
});

$clear.addEventListener("click", () => {
  $log.innerHTML = "";
});

$reloadTabs.addEventListener("click", () => {
  logInfo("タブ一覧を再読込します...");
  refreshTabs();
});

$useCurrentTab.addEventListener("click", async () => {
  logInfo("現在のウィンドウのアクティブタブを送信先に設定します...");
  await refreshTabs({ selectCurrentActive: true });
});

$domLogger.addEventListener("click", async () => {
  const tabId = getSelectedTabId();
  if (tabId == null) {
    logWarn("送信先タブが選ばれていません。「送信先タブ」ドロップダウンから選んでください。");
    return;
  }
  $domLogger.disabled = true;
  logInfo(
    `DOMロガー開始要求 (tabId=${tabId})。60秒間 MutationObserver で採取します...`,
  );
  try {
    const target = getSelectedTarget();
    const tm = targetMeta(target);
    const response = await chrome.runtime.sendMessage({
      type: "start_dom_logger",
      tabId,
      target,
    });
    if (response && response.ok) {
      logOk(
        `DOMロガー開始成功。${tm.site} タブに切替えて、送信→応答を1往復してください。結果は60秒後に表示されます。`,
      );
      // ボタンは dom_log_result 受信時に再度有効化される
    } else {
      logError(
        `DOMロガー開始失敗: ${response && response.error ? response.error : "(原因不明)"}`,
      );
      $domLogger.disabled = false;
    }
  } catch (e) {
    logError(`DOMロガー通信エラー: ${e && e.message ? e.message : e}`);
    $domLogger.disabled = false;
  }
});

$showLatestLog.addEventListener("click", async () => {
  $showLatestLog.disabled = true;
  logInfo("chrome.storage.local から最新DOMログを取得...");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get_latest_dom_log",
    });
    if (response && response.ok) {
      logOk(
        `最新DOMログ取得成功 (storage_key=${response.storage_key}, 全 ${response.total_logs} 件中の最新)`,
      );
      appendJsonBlock({
        title: "DOMロガー結果 (storage から取得)",
        json: response.result,
        storageKey: response.storage_key,
      });
    } else {
      logWarn(
        `最新ログ取得失敗: ${response && response.error ? response.error : "(原因不明)"}`,
      );
    }
  } catch (e) {
    logError(`通信エラー: ${e && e.message ? e.message : e}`);
  } finally {
    $showLatestLog.disabled = false;
  }
});

$showLatestAutoLog.addEventListener("click", async () => {
  $showLatestAutoLog.disabled = true;
  logInfo("chrome.storage.local から最新自動ログを取得...");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get_latest_auto_dom_log",
    });
    if (response && response.ok) {
      const r = response.result || {};
      logOk(
        `最新自動ログ取得成功 (storage_key=${response.storage_key}, trigger=${r.trigger || "?"}, 全 ${response.total_logs} 件中の最新, events=${r.event_count || 0})`,
      );
      appendJsonBlock({
        title: `自動採取ログ (trigger=${r.trigger || "?"})`,
        json: response.result,
        storageKey: response.storage_key,
      });
    } else {
      logWarn(
        `最新自動ログ取得失敗: ${response && response.error ? response.error : "(原因不明)"}`,
      );
    }
  } catch (e) {
    logError(`通信エラー: ${e && e.message ? e.message : e}`);
  } finally {
    $showLatestAutoLog.disabled = false;
  }
});

$showLatestSnapshot.addEventListener("click", async () => {
  $showLatestSnapshot.disabled = true;
  logInfo("chrome.storage.local から最新 assistant スナップショットを取得...");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get_latest_assistant_snapshot",
    });
    if (response && response.ok) {
      logOk(
        `最新スナップショット取得成功 (storage_key=${response.storage_key}, 全 ${response.total_snapshots} 件中の最新、候補 ${response.snapshot && response.snapshot.candidate_count} 件)`,
      );
      appendJsonBlock({
        title: "Assistant スナップショット (storage から取得)",
        json: response.snapshot,
        storageKey: response.storage_key,
      });
    } else {
      logWarn(
        `スナップショット取得失敗: ${response && response.error ? response.error : "(原因不明)"}`,
      );
    }
  } catch (e) {
    logError(`通信エラー: ${e && e.message ? e.message : e}`);
  } finally {
    $showLatestSnapshot.disabled = false;
  }
});

$ping.addEventListener("click", async () => {
  const tabId = getSelectedTabId();
  if (tabId == null) {
    logWarn("送信先タブが選ばれていません。「送信先タブ」ドロップダウンから選択するか、「再読込」を押してください。");
    return;
  }
  $ping.disabled = true;
  const pingTarget = getSelectedTarget();
  logInfo(`[${targetMeta(pingTarget).label}] ping 開始 → tabId=${tabId}`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "ping_ai",
      tabId,
      target: pingTarget,
    });
    if (response && response.ok) {
      logOk(`ping 成功。content_script 到達 (url=${response.url})`);
    } else {
      logError(
        `ping 失敗: ${response && response.error ? response.error : "(原因不明)"}`,
      );
    }
  } catch (e) {
    logError(`ping 通信エラー: ${e && e.message ? e.message : e}`);
  } finally {
    $ping.disabled = false;
  }
});

$send.addEventListener("click", async () => {
  const tabId = getSelectedTabId();
  if (tabId == null) {
    logWarn("送信先タブが選ばれていません。「送信先タブ」ドロップダウンから選択するか、「再読込」を押してください。");
    return;
  }
  const text = $message.value;
  if (!text || !text.trim()) {
    logWarn("メッセージが空です。");
    return;
  }
  $send.disabled = true;
  const sendTarget = getSelectedTarget();
  logInfo(
    `[${targetMeta(sendTarget).label}] 送信開始 (tabId=${tabId}): "${text.length > 40 ? text.slice(0, 40) + "…" : text}"`,
  );
  try {
    const response = await chrome.runtime.sendMessage({
      type: "send_to_ai",
      tabId,
      target: sendTarget,
      text,
      settings: {
        silence_timeout_sec: cachedSilenceTimeoutSec,
        backstop_timeout_ms: cachedBackstopSec * 1000,
      },
    });
    if (response && response.ok) {
      logOk(
        `送信成功 (input=${response.usedInputSelector || "?"}, ` +
          `inject=${response.usedInjectMethod || "?"}, ` +
          `submit=${response.usedSubmitSelector || "?"})`,
      );
      if (response.responseText) {
        const rawLenNote =
          typeof response.responseRawLength === "number"
            ? ` / raw ${response.responseRawLength}字`
            : "";
        logOk(
          `応答受信 (selector=${response.responseSelector}, ${response.responseText.length}字${rawLenNote})`,
        );
        appendResponseBlock({
          text: response.responseText,
          selector: response.responseSelector,
          target: sendTarget,
        });
      } else if (response.responseError) {
        logWarn(`応答取得エラー: ${response.responseError}`);
        if (response.assistantSnapshot) {
          logInfo(
            `Assistant スナップショット採取済み（候補 ${response.assistantSnapshot.candidate_count} 件、storage_key=${response.assistantSnapshotKey || "?"}）。JSON をチャット側 Claude に貼ってセレクタ確定してください。`,
          );
          appendJsonBlock({
            title: "Assistant スナップショット",
            json: response.assistantSnapshot,
            storageKey: response.assistantSnapshotKey,
          });
        }
      }
    } else if (response && response.busy) {
      // Phase 2 A4 fix: 応答中は使用中エラー扱い（warn）。Cloudflare 検知と同じレベル。
      logWarn(`使用中: ${response.error}`);
    } else {
      logError(
        `送信失敗: ${response && response.error ? response.error : "(原因不明)"}`,
      );
    }
  } catch (e) {
    logError(`通信エラー: ${e && e.message ? e.message : e}`);
  } finally {
    $send.disabled = false;
  }
});

// Phase 2 A3: 設定の読み込み・保存・バリデーション
function setSettingsStatus(level, msg) {
  $settingsStatus.className = `settings-status ${level}`;
  $settingsStatus.textContent = msg;
}

function validateSilenceTimeout(raw) {
  // raw: input.value (string)
  const trimmed = (raw || "").trim();
  if (trimmed === "") {
    return { error: `数値を入力してください (input="")` };
  }
  const n = Number(trimmed);
  if (!isFinite(n) || !Number.isInteger(n)) {
    return { error: `数値を入力してください (input="${trimmed}")` };
  }
  if (n < 1) {
    return { error: `1 秒以上を指定してください (input="${trimmed}")` };
  }
  const warnings = [];
  if (n > 600) {
    warnings.push("無音 600 秒超は長め。バックストップ以下である必要があります");
  } else if (n < 5) {
    warnings.push("5 秒未満は誤発火リスクが高いです");
  }
  return { value: n, warnings };
}

// Phase 3a Step1 fix3: バックストップ時間の検証。
//   - 整数・1 以上・上限 MAX_BACKSTOP_SEC（3600 秒）
//   - 「バックストップ ≥ 無音タイムアウト」は saveSettings で横断検証する
//     （単体ではここまで。silenceSec を渡せば下回りもここで弾く）
function validateBackstopTimeout(raw, silenceSec) {
  const trimmed = (raw || "").trim();
  if (trimmed === "") {
    return { error: `数値を入力してください (input="")` };
  }
  const n = Number(trimmed);
  if (!isFinite(n) || !Number.isInteger(n)) {
    return { error: `数値を入力してください (input="${trimmed}")` };
  }
  if (n < 1) {
    return { error: `1 秒以上を指定してください (input="${trimmed}")` };
  }
  if (n > MAX_BACKSTOP_SEC) {
    return {
      error: `バックストップは上限 ${MAX_BACKSTOP_SEC} 秒以下を指定してください (input="${trimmed}")`,
    };
  }
  if (typeof silenceSec === "number" && n < silenceSec) {
    return {
      error: `バックストップ (${n}秒) は無音タイムアウト (${silenceSec}秒) 以上である必要があります`,
    };
  }
  const warnings = [];
  if (n < 60) {
    warnings.push("バックストップ 60 秒未満は長考モデルで早期打ち切りの恐れ");
  }
  return { value: n, warnings };
}

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = result[SETTINGS_KEY] || {};
    if (
      typeof stored.silence_timeout_sec === "number" &&
      Number.isInteger(stored.silence_timeout_sec) &&
      stored.silence_timeout_sec >= 1
    ) {
      cachedSilenceTimeoutSec = stored.silence_timeout_sec;
    } else {
      cachedSilenceTimeoutSec = DEFAULT_SILENCE_TIMEOUT_SEC;
    }
    if (
      typeof stored.backstop_timeout_sec === "number" &&
      Number.isInteger(stored.backstop_timeout_sec) &&
      stored.backstop_timeout_sec >= 1 &&
      stored.backstop_timeout_sec <= MAX_BACKSTOP_SEC &&
      stored.backstop_timeout_sec >= cachedSilenceTimeoutSec
    ) {
      cachedBackstopSec = stored.backstop_timeout_sec;
    } else {
      cachedBackstopSec = DEFAULT_BACKSTOP_SEC;
    }
    $silenceTimeout.value = String(cachedSilenceTimeoutSec);
    $backstopTimeout.value = String(cachedBackstopSec);
  } catch (e) {
    logWarn(`設定読み込み失敗: ${e && e.message ? e.message : e}（デフォルト 無音 ${DEFAULT_SILENCE_TIMEOUT_SEC} 秒 / バックストップ ${DEFAULT_BACKSTOP_SEC} 秒を使用）`);
    cachedSilenceTimeoutSec = DEFAULT_SILENCE_TIMEOUT_SEC;
    cachedBackstopSec = DEFAULT_BACKSTOP_SEC;
    $silenceTimeout.value = String(cachedSilenceTimeoutSec);
    $backstopTimeout.value = String(cachedBackstopSec);
  }
}

async function saveSettings() {
  const rawSilence = $silenceTimeout.value;
  const vs = validateSilenceTimeout(rawSilence);
  if (vs.error) {
    setSettingsStatus("error", `✗ 無音タイムアウト: ${vs.error}`);
    logWarn(`設定保存失敗: 無音タイムアウト値が不正 (input="${rawSilence}") — ${vs.error}`);
    return;
  }
  const rawBackstop = $backstopTimeout.value;
  const vb = validateBackstopTimeout(rawBackstop, vs.value);
  if (vb.error) {
    setSettingsStatus("error", `✗ バックストップ: ${vb.error}`);
    logWarn(`設定保存失敗: バックストップ値が不正 (input="${rawBackstop}") — ${vb.error}`);
    return;
  }
  try {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        silence_timeout_sec: vs.value,
        backstop_timeout_sec: vb.value,
      },
    });
    cachedSilenceTimeoutSec = vs.value;
    cachedBackstopSec = vb.value;
    const warnings = [...(vs.warnings || []), ...(vb.warnings || [])];
    const summary = `無音 ${vs.value}秒 / バックストップ ${vb.value}秒`;
    if (warnings.length > 0) {
      setSettingsStatus("warn", `⚠ 保存しました (${summary}): ${warnings.join(", ")}`);
      logWarn(`設定保存: ${summary}（${warnings.join(", ")}）`);
    } else {
      setSettingsStatus("ok", `✓ 保存しました (${summary})`);
      logOk(`設定保存: ${summary}`);
    }
  } catch (e) {
    setSettingsStatus("error", `✗ 保存失敗: ${e && e.message ? e.message : e}`);
    logError(`設定保存失敗（storage エラー）: ${e && e.message ? e.message : e}`);
  }
}

$saveSettings.addEventListener("click", saveSettings);

// ============================================================
// Phase 2 E: 連続テストモード
// ------------------------------------------------------------
//   - 通常送信と同じ send_to_ai 経路（target 付き）を流用して、
//     送信パイプラインのリグレッションを起こさない設計
//     （Phase 3a Step1 で send_to_claude→send_to_ai に追従。claude
//      選択時の挙動は Phase 2 と完全同一）
//   - 中断フラグは side_panel.js のローカル変数（サイドパネル閉じたら消滅）
//   - 連続テスト中は通常送信ボタン (送信 / ping) を disabled に
//   - busy 検知時は次の sleep を +10 秒延長、リトライはなし
//   - 1 回失敗しても継続、最後まで実行
//   - 集計は e_test_result_{timestamp} で保存、保持上限 5
// ============================================================

function eTestSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function eTestShortenMsg(msg, max = 30) {
  if (!msg) return "";
  return msg.length <= max ? msg : msg.slice(0, max) + "…";
}

function eTestParseMessages() {
  return $testMessages.value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function eTestFormatDetail(iter) {
  const parts = [];
  parts.push(`inject=${iter.inject || "-"}`);
  parts.push(`selector=${iter.selector || "-"}`);
  if (iter.dedup) {
    parts.push(
      `dedup=${iter.dedup.kind}(${iter.dedup.kept_length}字採用, ${iter.dedup.dropped_length}字破棄)`,
    );
  } else {
    parts.push("dedup=-");
  }
  if (iter.warnings && iter.warnings.length) {
    parts.push(`warn=${iter.warnings.join(",")}`);
  } else {
    parts.push("warn=-");
  }
  parts.push(
    `extracted=${iter.response_length != null ? iter.response_length + "字" : "-"}`,
  );
  if (iter.error) {
    parts.push(`error="${iter.error}"`);
  }
  return parts.join(" / ");
}

function eTestAppendResultRow(iter) {
  const row = document.createElement("details");
  row.className = `test-result-row ${iter.ok ? "ok" : "fail"}`;
  const summary = document.createElement("summary");
  const num = document.createElement("span");
  num.textContent = `#${iter.iteration}`;
  const result = document.createElement("span");
  result.textContent = iter.ok
    ? "✓"
    : `✗ ${iter.short_error || ""}`.trim();
  const elapsed = document.createElement("span");
  elapsed.textContent = iter.elapsed_ms
    ? `${(iter.elapsed_ms / 1000).toFixed(1)}s`
    : "-";
  const msg = document.createElement("span");
  msg.textContent = eTestShortenMsg(iter.message);
  msg.title = iter.message;
  summary.appendChild(num);
  summary.appendChild(result);
  summary.appendChild(elapsed);
  summary.appendChild(msg);
  row.appendChild(summary);
  const detail = document.createElement("div");
  detail.className = "detail";
  detail.textContent = eTestFormatDetail(iter);
  row.appendChild(detail);
  // 失敗行はデフォルトで展開
  if (!iter.ok) row.open = true;
  $testResults.appendChild(row);
  $testResults.scrollTop = $testResults.scrollHeight;
}

function eTestUpdateProgress(done, total, elapsedMs) {
  $testProgressText.textContent = `${done}/${total} (経過 ${Math.round(elapsedMs / 1000)}秒)`;
  $testProgressFill.style.width = `${(done / total) * 100}%`;
}

function eTestShowSummary(aggregate) {
  $testSummary.classList.remove("empty");
  const total = aggregate.results.length;
  const success = aggregate.success_count;
  const failed = total - success;
  const okResults = aggregate.results.filter((r) => r.ok && r.elapsed_ms);
  const avgMs =
    okResults.length > 0
      ? okResults.reduce((a, r) => a + r.elapsed_ms, 0) / okResults.length
      : 0;
  let s = `📊 集計: ${success}/${total} 成功`;
  if (failed > 0) s += `、${failed} 失敗`;
  if (okResults.length > 0) s += `、成功時平均 ${(avgMs / 1000).toFixed(1)} 秒`;
  if (aggregate.aborted) s += "（中断）";
  s += ` / 全体経過 ${Math.round(aggregate.total_elapsed_ms / 1000)} 秒`;
  s += ` / storage: ${aggregate.session_key}`;
  $testSummary.textContent = s;
}

async function eTestCleanupOldKeys() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all)
      .filter((k) => k.startsWith(E_TEST_RESULT_KEY_PREFIX))
      .sort();
    if (keys.length <= E_TEST_MAX_STORED) return;
    const toRemove = keys.slice(0, keys.length - E_TEST_MAX_STORED);
    await chrome.storage.local.remove(toRemove);
    logInfo(
      `[E] 古い e_test_result_* キー ${toRemove.length} 件削除（保持上限 ${E_TEST_MAX_STORED}）`,
    );
  } catch (e) {
    logWarn(`[E] 古いキー削除失敗: ${e && e.message ? e.message : e}`);
  }
}

async function runConnectivityTest() {
  if (testRunning) {
    logWarn("[E] テスト実行中です。中断してから再開してください。");
    return;
  }
  const tabId = getSelectedTabId();
  if (tabId == null) {
    logWarn("[E] 送信先タブが選ばれていません。");
    return;
  }
  const eTarget = getSelectedTarget();
  const eTm = targetMeta(eTarget);
  const messages = eTestParseMessages();
  if (messages.length === 0) {
    logWarn("[E] メッセージが 1 つも入っていません。");
    return;
  }
  const count = parseInt($testCount.value, 10);
  const intervalMin = parseInt($testIntervalMin.value, 10);
  const intervalMax = parseInt($testIntervalMax.value, 10);
  if (!Number.isInteger(count) || count < 1) {
    logWarn("[E] 試行回数は 1 以上の整数を指定してください。");
    return;
  }
  if (
    !Number.isInteger(intervalMin) ||
    intervalMin < 1 ||
    !Number.isInteger(intervalMax) ||
    intervalMax < intervalMin
  ) {
    logWarn("[E] 間隔は min ≥ 1、max ≥ min の整数を指定してください。");
    return;
  }

  testRunning = true;
  testAbortRequested = false;
  $testStart.disabled = true;
  $testAbort.disabled = false;
  setActionButtonsEnabled(false);
  if ($aiTarget) $aiTarget.disabled = true;
  $testResults.innerHTML = "";
  $testSummary.textContent = "";
  $testSummary.classList.add("empty");
  $testProgress.hidden = false;
  eTestUpdateProgress(0, count, 0);

  const sessionStartedMs = Date.now();
  const sessionKey = `${E_TEST_RESULT_KEY_PREFIX}${sessionStartedMs}`;
  const results = [];
  let extraSleepMs = 0;

  logOk(
    `[E] 連続テスト開始 [${eTm.label}] (${count} 回、メッセージ ${messages.length} 個、間隔 ${intervalMin}〜${intervalMax} 秒)`,
  );

  try {
    for (let i = 0; i < count; i++) {
      if (testAbortRequested) {
        logWarn(`[E] 中断要求受信、iteration ${i + 1} 前で停止`);
        break;
      }
      const message = messages[i % messages.length];
      const iterStart = Date.now();
      logInfo(
        `[E] iteration ${i + 1}/${count}: "${eTestShortenMsg(message)}" 送信`,
      );

      let response = null;
      let commError = null;
      try {
        response = await chrome.runtime.sendMessage({
          type: "send_to_ai",
          tabId,
          target: eTarget,
          text: message,
          settings: {
            silence_timeout_sec: cachedSilenceTimeoutSec,
            backstop_timeout_ms: cachedBackstopSec * 1000,
          },
        });
      } catch (e) {
        commError = e && e.message ? e.message : String(e);
      }
      const elapsedMs = Date.now() - iterStart;
      const ok = !!(response && response.ok && response.responseText);
      const busy = !!(response && response.busy);
      let shortError = null;
      if (!ok) {
        if (busy) shortError = "busy";
        else if (response && response.cloudflare) shortError = "cloudflare";
        else if (response && response.responseError) shortError = "no_extract";
        else if (commError) shortError = "comm_err";
        else shortError = "fail";
      }

      const iter = {
        iteration: i + 1,
        message,
        elapsed_ms: elapsedMs,
        ok,
        short_error: shortError,
        error:
          commError ||
          (response && (response.responseError || response.error)) ||
          null,
        inject: response && response.usedInjectMethod,
        selector: response && response.responseSelector,
        dedup: response && response.responseDedup,
        warnings:
          response && response.extractionMeta && response.extractionMeta.warnings,
        response_length:
          response && response.responseText
            ? response.responseText.length
            : null,
        busy,
      };
      results.push(iter);
      eTestAppendResultRow(iter);
      eTestUpdateProgress(results.length, count, Date.now() - sessionStartedMs);

      if (busy) {
        extraSleepMs = E_TEST_BUSY_EXTRA_SLEEP_MS;
        logWarn(`[E] iteration ${i + 1} busy 検知。次の sleep を +10 秒延長`);
      }

      if (i < count - 1 && !testAbortRequested) {
        const interval = intervalMin + Math.random() * (intervalMax - intervalMin);
        const totalSleepMs = Math.round(interval * 1000) + extraSleepMs;
        extraSleepMs = 0;
        logInfo(
          `[E] 次の iteration まで ${Math.round(totalSleepMs / 1000)} 秒待機`,
        );
        await eTestSleep(totalSleepMs);
      }
    }

    const aggregate = {
      session_key: sessionKey,
      target: eTarget,
      target_label: eTm.label,
      started_at: new Date(sessionStartedMs).toISOString(),
      total_elapsed_ms: Date.now() - sessionStartedMs,
      requested_count: count,
      messages_pool: messages,
      interval_min_sec: intervalMin,
      interval_max_sec: intervalMax,
      results,
      success_count: results.filter((r) => r.ok).length,
      aborted: testAbortRequested,
    };

    try {
      await chrome.storage.local.set({ [sessionKey]: aggregate });
      logOk(`[E] 集計保存: ${sessionKey}`);
      await eTestCleanupOldKeys();
    } catch (e) {
      logError(`[E] 集計保存失敗: ${e && e.message ? e.message : e}`);
    }

    eTestShowSummary(aggregate);
    logOk(
      `[E] 連続テスト終了: ${aggregate.success_count}/${aggregate.results.length} 成功` +
        (aggregate.aborted ? "（中断）" : "") +
        `、全体経過 ${Math.round(aggregate.total_elapsed_ms / 1000)} 秒`,
    );
  } finally {
    testRunning = false;
    testAbortRequested = false;
    $testStart.disabled = false;
    $testAbort.disabled = true;
    setActionButtonsEnabled(true);
    if ($aiTarget) $aiTarget.disabled = false;
  }
}

function abortConnectivityTest() {
  if (!testRunning) return;
  testAbortRequested = true;
  logWarn("[E] 中断要求受信。現在のターン完了後に停止します。");
  $testAbort.disabled = true;
}

// テストメッセージのデフォルトを初期化
$testMessages.value = DEFAULT_TEST_MESSAGES.join("\n");
$testStart.addEventListener("click", runConnectivityTest);
$testAbort.addEventListener("click", abortConnectivityTest);

// 対象 AI 切替: タブ一覧を即時再取得し、現在のアクティブタブが新対象なら自動選択
if ($aiTarget) {
  $aiTarget.addEventListener("change", () => {
    const tm = targetMeta(getSelectedTarget());
    logInfo(`対象 AI を ${tm.label} (${tm.site}) に切替。タブ一覧を再取得します...`);
    refreshTabs({ selectCurrentActive: true });
  });
}

logInfo(
  "サイドパネル起動。対象 AI（既定: Claude）の現在のアクティブタブを自動で送信先に設定します。",
);
loadSettings();
// 起動時は「現在のウィンドウのアクティブタブ」を優先して選択する。
refreshTabs({ selectCurrentActive: true });
