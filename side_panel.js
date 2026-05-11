// side_panel.js — Roundtable のサイドパネル UI ロジック
// ============================================================
// Phase 1 Step 1A:
//   - 「送信先タブ」ドロップダウンで claude.ai タブを明示的に選ぶ
//   - 起動時 / 「再読込」ボタンで list_claude_tabs を呼んで一覧更新
//   - 送信／ping 時に選択中の tabId を background に渡す
//   - background / content_script からの log メッセージをログエリアに反映
// ============================================================

const $log = document.getElementById("log");
const $message = document.getElementById("message");
const $send = document.getElementById("send");
const $clear = document.getElementById("clear-log");
const $domLogger = document.getElementById("dom-logger");
const $showLatestLog = document.getElementById("show-latest-log");
const $showLatestSnapshot = document.getElementById("show-latest-snapshot");
const $ping = document.getElementById("ping");
const $tabSelect = document.getElementById("tab-select");
const $reloadTabs = document.getElementById("reload-tabs");
const $useCurrentTab = document.getElementById("use-current-tab");

const NO_TAB_VALUE = "__none__";

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

function formatTabLabel(tab) {
  let path = "/";
  try {
    path = new URL(tab.url).pathname || "/";
  } catch (_) {}
  path = shortenPath(path);
  if (path.length > 36) path = path.slice(0, 33) + "...";
  const title = (tab.title || "").trim();
  const titleShort = title.length > 40 ? title.slice(0, 37) + "..." : title;
  const marker = tab.isCurrentWindowActive ? "★ " : "  ";
  return `${marker}[${path}] ${titleShort || "(無題)"}`;
}

function getSelectedTabId() {
  const v = $tabSelect.value;
  if (!v || v === NO_TAB_VALUE) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
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
  const previousTabId = getSelectedTabId();
  $reloadTabs.disabled = true;
  $useCurrentTab.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "list_claude_tabs",
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
      opt.textContent = "(claude.ai タブが開かれていません)";
      opt.disabled = true;
      opt.selected = true;
      $tabSelect.appendChild(opt);
      setActionButtonsEnabled(false);
      logWarn(
        "claude.ai のタブが見つかりません。Chrome で claude.ai を開いてから「再読込」を押してください。",
      );
      return;
    }
    for (const t of tabs) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      opt.textContent = formatTabLabel(t);
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
      `claude.ai タブ ${tabs.length} 件を読み込みました${reasonNote}。`,
    );
    if (selectCurrentActive && response.currentTabId == null) {
      const urlNote = response.currentTabUrl
        ? ` (url=${response.currentTabUrl})`
        : "";
      logWarn(
        `現在のアクティブタブは claude.ai ではありません${urlNote}。手動でドロップダウンから選んでください。`,
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

function appendResponseBlock({ text, selector }) {
  const frame = document.createElement("div");
  frame.className = "response-frame";

  const header = document.createElement("div");
  header.className = "response-header";
  const label = document.createElement("span");
  label.textContent = `🟧 Claude 応答 (${formatTimestamp()}, ${text.length}字)`;
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
    const response = await chrome.runtime.sendMessage({
      type: "start_dom_logger",
      tabId,
    });
    if (response && response.ok) {
      logOk(
        `DOMロガー開始成功。claude.ai タブに切替えて、送信→応答を1往復してください。結果は60秒後に表示されます。`,
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
  logInfo(`ping 開始 → tabId=${tabId}`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "ping_claude",
      tabId,
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
  logInfo(
    `送信開始 (tabId=${tabId}): "${text.length > 40 ? text.slice(0, 40) + "…" : text}"`,
  );
  try {
    const response = await chrome.runtime.sendMessage({
      type: "send_to_claude",
      tabId,
      text,
    });
    if (response && response.ok) {
      logOk(
        `送信成功 (input=${response.usedInputSelector || "?"}, ` +
          `inject=${response.usedInjectMethod || "?"}, ` +
          `submit=${response.usedSubmitSelector || "?"})`,
      );
      if (response.responseText) {
        logOk(
          `応答受信 (selector=${response.responseSelector}, ${response.responseText.length}字)`,
        );
        appendResponseBlock({
          text: response.responseText,
          selector: response.responseSelector,
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

logInfo(
  "サイドパネル起動。現在のアクティブタブが claude.ai なら自動で送信先に設定されます。",
);
// 起動時は「現在のウィンドウのアクティブタブ」を優先して選択する。
refreshTabs({ selectCurrentActive: true });
