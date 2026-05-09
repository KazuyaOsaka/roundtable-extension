// background.js — Roundtable のバックグラウンド Service Worker
// ============================================================
// 役割（Phase 1 Step 1A 時点）:
//   - ツールバーアイコンクリックでサイドパネルを開く
//   - サイドパネル → claude.ai タブの content_script の中継
//   - 該当タブが無い場合のエラーをサイドパネルに返す
//   - content_script が未注入のタブにはプログラム注入してから再送信する
//     （SPA ナビゲーション後 / 拡張リロード後の既存タブ等を救済）
// ============================================================

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    console.error("[Roundtable] サイドパネルの設定に失敗:", error);
  });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`[Roundtable] 拡張がロードされました (reason: ${reason})`);
});

function logToPanel(level, message) {
  chrome.runtime
    .sendMessage({ type: "log", level, message, timestamp: Date.now() })
    .catch(() => {
      // サイドパネルが閉じている時は受け手がいないため無視
    });
}

async function findClaudeTab() {
  const tabs = await chrome.tabs.query({ url: ["https://claude.ai/*"] });
  if (!tabs.length) return null;
  const active = tabs.find((t) => t.active);
  if (active) return active;
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

const NO_RECEIVER_RE =
  /Receiving end does not exist|Could not establish connection/;

async function injectClaudeScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content_scripts/claude.js"],
  });
}

async function sendToClaudeTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    if (!NO_RECEIVER_RE.test(errMsg)) throw e;

    logToPanel(
      "warn",
      "content_script 未注入を検出。プログラム注入を試行...",
    );
    try {
      await injectClaudeScript(tabId);
    } catch (injErr) {
      const m =
        "プログラム注入に失敗: " +
        (injErr && injErr.message ? injErr.message : injErr) +
        "。manifest の host_permissions と Chrome のページタイプを確認してください。";
      logToPanel("error", m);
      throw new Error(m);
    }
    logToPanel("ok", "プログラム注入成功。再送信します。");
    // listener が登録されるまで少し待つ
    await new Promise((r) => setTimeout(r, 250));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function handleSendToClaude(text) {
  const tab = await findClaudeTab();
  if (!tab) {
    const msg =
      "claude.ai のタブが見つかりません。Chromeで claude.ai を開いてログイン後、再度送信してください。";
    logToPanel("error", msg);
    return { ok: false, error: msg };
  }
  logToPanel("info", `claude.ai タブ検出 (tabId=${tab.id}, url=${tab.url})`);
  try {
    const response = await sendToClaudeTab(tab.id, {
      type: "send_to_claude",
      text,
    });
    return (
      response || { ok: false, error: "content_script が応答を返しませんでした。" }
    );
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    return { ok: false, error: errMsg };
  }
}

async function handlePingClaude() {
  const tab = await findClaudeTab();
  if (!tab) {
    const msg = "claude.ai のタブが見つかりません。";
    logToPanel("error", msg);
    return { ok: false, error: msg };
  }
  logToPanel("info", `ping → tab ${tab.id} (${tab.url})`);
  try {
    const response = await sendToClaudeTab(tab.id, { type: "ping" });
    if (response && response.ok) {
      logToPanel("ok", `ping 応答: ${response.url}`);
      return { ok: true, url: response.url };
    }
    return { ok: false, error: "ping 応答が異常" };
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    logToPanel("error", `ping 失敗: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "send_to_claude") {
    handleSendToClaude(msg.text).then(sendResponse);
    return true;
  }

  if (msg.type === "ping_claude") {
    handlePingClaude().then(sendResponse);
    return true;
  }

  if (msg.type === "log" && sender && sender.tab) {
    const lvl = msg.level || "info";
    console.log(`[Roundtable][content][${lvl}]`, msg.message);
    return false;
  }

  return false;
});
