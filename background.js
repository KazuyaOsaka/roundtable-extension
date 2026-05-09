// background.js — Roundtable のバックグラウンド Service Worker
// ============================================================
// 役割（Phase 1 Step 1A 時点）:
//   - ツールバーアイコンクリックでサイドパネルを開く
//   - サイドパネル → claude.ai タブの content_script の中継
//   - 該当タブが無い場合のエラーをサイドパネルに返す
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
  // アクティブなものを優先、それ以外は最後に更新されたタブを使う
  const active = tabs.find((t) => t.active);
  if (active) return active;
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function handleSendToClaude(text) {
  const tab = await findClaudeTab();
  if (!tab) {
    const msg =
      "claude.ai のタブが見つかりません。Chromeで claude.ai を開いてログイン後、再度送信してください。";
    logToPanel("error", msg);
    return { ok: false, error: msg };
  }
  logToPanel("info", `claude.ai タブ検出 (tabId=${tab.id})`);
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "send_to_claude",
      text,
    });
    return response || { ok: false, error: "content_script が応答を返しませんでした。" };
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    const msg = `content_script との通信に失敗: ${errMsg}。claude.ai タブをリロードしてください。`;
    logToPanel("error", msg);
    return { ok: false, error: msg };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "send_to_claude") {
    handleSendToClaude(msg.text).then(sendResponse);
    return true; // 非同期レスポンス
  }

  // content_script からのログはサイドパネル側でも直接受け取れるが、
  // 念のため background でも console に流しておく（バグ追跡用）。
  if (msg.type === "log" && sender && sender.tab) {
    const lvl = msg.level || "info";
    console.log(`[Roundtable][content][${lvl}]`, msg.message);
    return false;
  }

  return false;
});
