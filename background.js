// background.js — Roundtable のバックグラウンド Service Worker
// ============================================================
// 役割（Phase 1 Step 1A 時点）:
//   - ツールバーアイコンクリックでサイドパネルを開く
//   - claude.ai タブの一覧をサイドパネルに返す（list_claude_tabs）
//   - サイドパネル → 明示的に指定された claude.ai タブの content_script への中継
//   - content_script が未注入のタブにはプログラム注入してから再送信する
//
// 送信先タブの自動選択は廃止。送信元（サイドパネル）が tabId を必ず指定する。
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

const NO_RECEIVER_RE =
  /Receiving end does not exist|Could not establish connection/;

async function getCurrentActiveTab() {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tabs[0] || null;
  } catch (_e) {
    return null;
  }
}

async function listClaudeTabs() {
  const [claudeTabs, currentTab] = await Promise.all([
    chrome.tabs.query({ url: ["https://claude.ai/*"] }),
    getCurrentActiveTab(),
  ]);
  const currentTabId = currentTab ? currentTab.id : null;
  const currentTabIsClaude = !!(
    currentTab &&
    currentTab.url &&
    currentTab.url.startsWith("https://claude.ai/")
  );

  const tabs = claudeTabs
    .map((t) => ({
      id: t.id,
      url: t.url || "",
      title: t.title || "",
      active: !!t.active,
      windowId: t.windowId,
      isCurrentWindowActive: t.id === currentTabId,
    }))
    .sort((a, b) => {
      // 1) 現在のウィンドウのアクティブタブ優先
      if (a.isCurrentWindowActive !== b.isCurrentWindowActive) {
        return a.isCurrentWindowActive ? -1 : 1;
      }
      // 2) その他ウィンドウのアクティブを次に
      if (a.active !== b.active) return a.active ? -1 : 1;
      // 3) id 昇順で安定化
      return a.id - b.id;
    });

  return {
    tabs,
    currentTabId: currentTabIsClaude ? currentTabId : null,
    currentTabIsClaude,
    currentTabUrl: currentTab ? currentTab.url || null : null,
  };
}

async function resolveTab(tabId) {
  if (typeof tabId !== "number") {
    return {
      error:
        "送信先タブが指定されていません。サイドパネル上部の「送信先タブ」ドロップダウンからタブを選んでください。",
    };
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_e) {
    return {
      error: `tabId=${tabId} のタブが見つかりません（閉じられた可能性）。「再読込」を押してタブ一覧を更新してください。`,
    };
  }
  if (!tab.url || !tab.url.startsWith("https://claude.ai/")) {
    return {
      error: `tabId=${tabId} は claude.ai のタブではありません (url=${tab.url || "?"})。`,
    };
  }
  return { tab };
}

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
      `tabId=${tabId} の content_script 未注入を検出。プログラム注入を試行...`,
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
    logToPanel("ok", `プログラム注入成功 (tabId=${tabId})。再送信します。`);
    await new Promise((r) => setTimeout(r, 250));
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function handleSendToClaude(text, tabId, settings) {
  const r = await resolveTab(tabId);
  if (r.error) {
    logToPanel("error", r.error);
    return { ok: false, error: r.error };
  }
  const tab = r.tab;
  logToPanel("info", `送信先 tabId=${tab.id} (${tab.url})`);
  try {
    const response = await sendToClaudeTab(tab.id, {
      type: "send_to_claude",
      text,
      settings: settings || {},
    });
    return (
      response || { ok: false, error: "content_script が応答を返しませんでした。" }
    );
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    return { ok: false, error: errMsg };
  }
}

async function handlePingClaude(tabId) {
  const r = await resolveTab(tabId);
  if (r.error) {
    logToPanel("error", r.error);
    return { ok: false, error: r.error };
  }
  const tab = r.tab;
  logToPanel("info", `ping → tabId=${tab.id} (${tab.url})`);
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

async function handleStartDomLogger(tabId) {
  const r = await resolveTab(tabId);
  if (r.error) {
    logToPanel("error", r.error);
    return { ok: false, error: r.error };
  }
  const tab = r.tab;
  logToPanel("info", `DOMロガー開始要求 → tabId=${tab.id} (${tab.url})`);
  try {
    const response = await sendToClaudeTab(tab.id, {
      type: "start_dom_logger",
    });
    return response || { ok: false, error: "content_script からの応答なし" };
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    logToPanel("error", `DOMロガー開始失敗: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

async function handleGetLatestDomLog() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all)
      .filter((k) => k.startsWith("dom_log_"))
      .sort();
    if (keys.length === 0) {
      return { ok: false, error: "保存されたDOMログがありません。" };
    }
    const latestKey = keys[keys.length - 1];
    return {
      ok: true,
      storage_key: latestKey,
      result: all[latestKey],
      total_logs: keys.length,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function handleListDomLogs() {
  try {
    const all = await chrome.storage.local.get(null);
    const entries = Object.keys(all)
      .filter((k) => k.startsWith("dom_log_"))
      .sort()
      .map((k) => ({
        key: k,
        captured_at: all[k] && all[k].captured_at,
        event_count: all[k] && all[k].event_count,
        url: all[k] && all[k].url,
      }));
    return { ok: true, logs: entries };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function handleGetLatestAssistantSnapshot() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all)
      .filter((k) => k.startsWith("assistant_snapshot_"))
      .sort();
    if (keys.length === 0) {
      return {
        ok: false,
        error: "保存された assistant スナップショットがありません。",
      };
    }
    const latestKey = keys[keys.length - 1];
    return {
      ok: true,
      storage_key: latestKey,
      snapshot: all[latestKey],
      total_snapshots: keys.length,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "list_claude_tabs") {
    listClaudeTabs()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e && e.message ? e.message : String(e),
        }),
      );
    return true;
  }

  if (msg.type === "send_to_claude") {
    handleSendToClaude(msg.text, msg.tabId, msg.settings).then(sendResponse);
    return true;
  }

  if (msg.type === "ping_claude") {
    handlePingClaude(msg.tabId).then(sendResponse);
    return true;
  }

  if (msg.type === "start_dom_logger") {
    handleStartDomLogger(msg.tabId).then(sendResponse);
    return true;
  }

  if (msg.type === "get_latest_dom_log") {
    handleGetLatestDomLog().then(sendResponse);
    return true;
  }

  if (msg.type === "list_dom_logs") {
    handleListDomLogs().then(sendResponse);
    return true;
  }

  if (msg.type === "get_latest_assistant_snapshot") {
    handleGetLatestAssistantSnapshot().then(sendResponse);
    return true;
  }

  if (msg.type === "log" && sender && sender.tab) {
    const lvl = msg.level || "info";
    console.log(`[Roundtable][content][${lvl}]`, msg.message);
    return false;
  }

  if (msg.type === "dom_log_result" && sender && sender.tab) {
    // content_script からの完了通知は side panel に直接届くので、background はログのみ
    console.log(
      `[Roundtable][content] DOM log result saved at ${msg.storage_key}`,
    );
    return false;
  }

  return false;
});
