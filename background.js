// background.js — Roundtable のバックグラウンド Service Worker
// ============================================================
// 役割:
//   - ツールバーアイコンクリックでサイドパネルを開く
//   - 対象 AI（claude / chatgpt）のタブ一覧をサイドパネルに返す（list_ai_tabs）
//   - サイドパネル → 明示的に指定された対象 AI タブの content_script への中継
//   - content_script が未注入のタブには対象 AI 用スクリプトをプログラム注入
//
// 送信先タブの自動選択は廃止。送信元（サイドパネル）が tabId と target を
// 必ず指定する。
//
// Phase 3a Step1（ルーティング一般化）:
//   - claude 固定だったタブクエリ / URL チェック / 注入対象を AI_TARGETS で
//     パラメータ化。claude の送信パスは完全互換（content_script へ送る
//     メッセージ型 send_to_claude / ping / start_dom_logger は不変なので
//     claude.js は一切変更しない＝リグレッションなし）。
//   - メッセージ型を一般化: list_claude_tabs→list_ai_tabs、
//     send_to_claude→send_to_ai、ping_claude→ping_ai（いずれも msg.target）。
// ============================================================

// ------------------------------------------------------------
// 対象 AI 定義。新社追加時はここに 1 エントリ足すだけで済むようにする。
//   - urlPrefix : resolveTab での URL 検証（startsWith）
//   - urlMatch  : chrome.tabs.query のパターン
//   - script    : 未注入時にプログラム注入する content_script
//   - sendType  : content_script へ送る「送信」メッセージ型。
//                 claude は既存 claude.js のリスナ（send_to_claude）に
//                 合わせて不変に保つ＝claude.js を触らない。
//                 chatgpt は Phase 3a Step4 で chatgpt.js 側に実装予定。
// ------------------------------------------------------------
const AI_TARGETS = {
  claude: {
    label: "Claude",
    urlPrefix: "https://claude.ai/",
    urlMatch: ["https://claude.ai/*"],
    script: "content_scripts/claude.js",
    sendType: "send_to_claude",
  },
  chatgpt: {
    label: "ChatGPT",
    urlPrefix: "https://chatgpt.com/",
    urlMatch: ["https://chatgpt.com/*"],
    script: "content_scripts/chatgpt.js",
    sendType: "send_to_chatgpt",
  },
  gemini: {
    label: "Gemini",
    urlPrefix: "https://gemini.google.com/",
    urlMatch: ["https://gemini.google.com/*"],
    script: "content_scripts/gemini.js",
    sendType: "send_to_gemini",
  },
};
const DEFAULT_TARGET = "claude";

function getTargetConf(targetKey) {
  return AI_TARGETS[targetKey] || AI_TARGETS[DEFAULT_TARGET];
}

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

async function listAiTabs(targetKey) {
  const conf = getTargetConf(targetKey);
  const [aiTabs, currentTab] = await Promise.all([
    chrome.tabs.query({ url: conf.urlMatch }),
    getCurrentActiveTab(),
  ]);
  const currentTabId = currentTab ? currentTab.id : null;
  const currentWindowId = currentTab ? currentTab.windowId : null;
  const currentTabIsTarget = !!(
    currentTab &&
    currentTab.url &&
    currentTab.url.startsWith(conf.urlPrefix)
  );

  const tabs = aiTabs
    .map((t) => ({
      id: t.id,
      url: t.url || "",
      title: t.title || "",
      active: !!t.active,
      windowId: t.windowId,
      // Step1.5 (Phase 4): 並び順の主キーに使う。Chrome 121+ で利用可。
      // 未対応環境では undefined → 0 扱いで②を飛ばし③(tabId)で安全動作。
      lastAccessed: typeof t.lastAccessed === "number" ? t.lastAccessed : 0,
      // Step1.5: 並び順の最優先キー。同じ Chrome ウィンドウのタブを優先。
      isCurrentWindow:
        currentWindowId != null && t.windowId === currentWindowId,
      // 既存: ★ マーカー表示用（panel の formatTabLabel が参照）。
      isCurrentWindowActive: t.id === currentTabId,
    }))
    .sort((a, b) => {
      // Step1.5 (Phase 4) の選択ルール:
      //  旧並び（アクティブ1枚優先 + tabId 昇順）だと、フォーカス外の社で
      //  別ウィンドウの最古タブが選ばれていた事故（要望①②）を解消する。
      // 1) 同じウィンドウのタブを最優先（フォーカス外の社も同ウィンドウ内を選ぶ）
      if (a.isCurrentWindow !== b.isCurrentWindow) {
        return a.isCurrentWindow ? -1 : 1;
      }
      // 2) lastAccessed が新しい順（最近触ったタブ）
      if (a.lastAccessed !== b.lastAccessed) {
        return b.lastAccessed - a.lastAccessed;
      }
      // 3) tabId 大きい順（最近開いたタブ）にフォールバック
      return b.id - a.id;
    });

  // Step1.6 (Phase 4 Step2b 後発見): 同 window 候補数を返し、panel 側で
  // 「同 window に対象タブが無ければ自動選択しない」policy を取れるようにする。
  // 旧挙動（同 window 候補ゼロ時に別 window の sort 先頭を fallback 選択）が、
  // content_script 未注入の古い別 window タブを掴んで Step3 自動進行で配信を
  // 壊しうる致命性があったため、構造的にゼロ事故化する。
  const sameWindowCount = tabs.filter((t) => t.isCurrentWindow).length;

  return {
    target: targetKey || DEFAULT_TARGET,
    targetLabel: conf.label,
    tabs,
    sameWindowCount,
    currentTabId: currentTabIsTarget ? currentTabId : null,
    currentTabIsTarget,
    currentTabUrl: currentTab ? currentTab.url || null : null,
    currentWindowId,
  };
}

async function resolveTab(tabId, targetKey) {
  const conf = getTargetConf(targetKey);
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
  if (!tab.url || !tab.url.startsWith(conf.urlPrefix)) {
    return {
      error: `tabId=${tabId} は ${conf.label} (${conf.urlPrefix}*) のタブではありません (url=${tab.url || "?"})。対象 AI とタブの組み合わせを確認してください。`,
    };
  }
  return { tab };
}

async function injectScript(tabId, targetKey) {
  const conf = getTargetConf(targetKey);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [conf.script],
  });
}

async function sendToTab(tabId, targetKey, msg) {
  const conf = getTargetConf(targetKey);
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    if (!NO_RECEIVER_RE.test(errMsg)) throw e;

    logToPanel(
      "warn",
      `tabId=${tabId} の content_script 未注入を検出。${conf.label} 用スクリプトをプログラム注入...`,
    );
    try {
      await injectScript(tabId, targetKey);
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

async function handleSendToAi(text, tabId, settings, targetKey) {
  const conf = getTargetConf(targetKey);
  const r = await resolveTab(tabId, targetKey);
  if (r.error) {
    logToPanel("error", r.error);
    return { ok: false, error: r.error };
  }
  const tab = r.tab;
  logToPanel("info", `[${conf.label}] 送信先 tabId=${tab.id} (${tab.url})`);
  try {
    const response = await sendToTab(tab.id, targetKey, {
      type: conf.sendType,
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

async function handlePingAi(tabId, targetKey) {
  const conf = getTargetConf(targetKey);
  const r = await resolveTab(tabId, targetKey);
  if (r.error) {
    logToPanel("error", r.error);
    return { ok: false, error: r.error };
  }
  const tab = r.tab;
  logToPanel("info", `[${conf.label}] ping → tabId=${tab.id} (${tab.url})`);
  try {
    const response = await sendToTab(tab.id, targetKey, { type: "ping" });
    if (response && response.ok) {
      logToPanel("ok", `[${conf.label}] ping 応答: ${response.url}`);
      return { ok: true, url: response.url };
    }
    return { ok: false, error: "ping 応答が異常" };
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    logToPanel("error", `[${conf.label}] ping 失敗: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

async function handleStartDomLogger(tabId, targetKey) {
  const conf = getTargetConf(targetKey);
  const r = await resolveTab(tabId, targetKey);
  if (r.error) {
    logToPanel("error", r.error);
    return { ok: false, error: r.error };
  }
  const tab = r.tab;
  logToPanel(
    "info",
    `[${conf.label}] DOMロガー開始要求 → tabId=${tab.id} (${tab.url})`,
  );
  try {
    const response = await sendToTab(tab.id, targetKey, {
      type: "start_dom_logger",
    });
    return response || { ok: false, error: "content_script からの応答なし" };
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    logToPanel("error", `[${conf.label}] DOMロガー開始失敗: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

// 以下のストレージ読み出し系は対象 AI 非依存（storage_key prefix で識別）。
// Phase 3a Step2 以降で chatgpt.js が同じ prefix に書く設計なので、ここは不変。
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

// Phase 2 A4: 自動採取ログ (auto_dom_log_*) の最新を取得
async function handleGetLatestAutoDomLog() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all)
      .filter((k) => k.startsWith("auto_dom_log_"))
      .sort();
    if (keys.length === 0) {
      return { ok: false, error: "保存された自動採取ログがありません。" };
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

  if (msg.type === "list_ai_tabs") {
    listAiTabs(msg.target)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e && e.message ? e.message : String(e),
        }),
      );
    return true;
  }

  if (msg.type === "send_to_ai") {
    handleSendToAi(msg.text, msg.tabId, msg.settings, msg.target).then(
      sendResponse,
    );
    return true;
  }

  if (msg.type === "ping_ai") {
    handlePingAi(msg.tabId, msg.target).then(sendResponse);
    return true;
  }

  if (msg.type === "start_dom_logger") {
    handleStartDomLogger(msg.tabId, msg.target).then(sendResponse);
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

  if (msg.type === "get_latest_auto_dom_log") {
    handleGetLatestAutoDomLog().then(sendResponse);
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
