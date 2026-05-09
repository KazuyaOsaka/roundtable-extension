// side_panel.js — Roundtable のサイドパネル UI ロジック
// ============================================================
// Phase 1 Step 1A:
//   - 送信ボタンで background に送信リクエスト
//   - background / content_script からの log メッセージをログエリアに反映
//   - Kazuya は DevTools を開かなくても動作状況が読めるようにする
// ============================================================

const $log = document.getElementById("log");
const $message = document.getElementById("message");
const $send = document.getElementById("send");
const $clear = document.getElementById("clear-log");
const $domLogger = document.getElementById("dom-logger");
const $ping = document.getElementById("ping");

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

// content_script / background から飛んできたログメッセージを受信
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "log") {
    appendLog({
      level: msg.level || "info",
      message: msg.message || "",
      timestamp: msg.timestamp || null,
    });
  }
});

$clear.addEventListener("click", () => {
  $log.innerHTML = "";
});

$send.addEventListener("click", async () => {
  const text = $message.value;
  if (!text || !text.trim()) {
    logWarn("メッセージが空です。");
    return;
  }
  $send.disabled = true;
  logInfo(`送信開始: "${text.length > 40 ? text.slice(0, 40) + "…" : text}"`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "send_to_claude",
      text,
    });
    if (response && response.ok) {
      logOk(
        `送信成功 (input=${response.usedInputSelector || "?"}, ` +
          `inject=${response.usedInjectMethod || "?"}, ` +
          `submit=${response.usedSubmitSelector || "?"})`
      );
    } else {
      logError(`送信失敗: ${response && response.error ? response.error : "(原因不明)"}`);
    }
  } catch (e) {
    logError(`通信エラー: ${e && e.message ? e.message : e}`);
  } finally {
    $send.disabled = false;
  }
});

$ping.addEventListener("click", async () => {
  $ping.disabled = true;
  logInfo("ping 開始 → claude.ai content_script の到達性を確認");
  try {
    const response = await chrome.runtime.sendMessage({ type: "ping_claude" });
    if (response && response.ok) {
      logOk(`ping 成功。claude.ai に content_script 到達 (url=${response.url})`);
    } else {
      logError(`ping 失敗: ${response && response.error ? response.error : "(原因不明)"}`);
    }
  } catch (e) {
    logError(`ping 通信エラー: ${e && e.message ? e.message : e}`);
  } finally {
    $ping.disabled = false;
  }
});

// Step 1A 起動メッセージ
logInfo("サイドパネル起動。claude.ai を開いてからメッセージを送信してください。");
