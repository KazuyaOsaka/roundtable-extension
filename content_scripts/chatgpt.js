// content_scripts/chatgpt.js — chatgpt.com 用 Content Script
// ============================================================
// これは https://chatgpt.com/* のページが開かれた時に、Chromeが自動で
// そのページに「注入」して実行するスクリプト。
//
// Phase 3a Step1（ルーティング一般化）の段階:
//   - 中身の「調査ロジック（DOMロガー / スナップショット）」は Step2、
//     「送信パイプライン」は Step4 で実装する。
//   - この Step1 では、ルーティング層の疎通テスト（スコープ d）を成立
//     させるために必要な最小限だけを置く:
//       * 二重ロードガード（静的注入 + background のプログラム注入の両方が
//         走っても listener を二重登録しない。claude.js と同じ方式）
//       * ping 応答（background → content_script の到達確認）
//   - send_to_chatgpt / start_dom_logger には Step1 ではまだ応答しない
//     （未実装。Step2/Step4 で chatgpt.js 本体として実装予定）。
// 新規ログは最初からタグ付き（[ChatGPT][Init] 等）で書く運用ルールに従う。
// ============================================================

if (window.__roundtableChatgptLoaded__) {
  console.log(
    "[Roundtable] chatgpt.js は既にロード済み。再初期化をスキップ。",
  );
} else {
  window.__roundtableChatgptLoaded__ = true;
  initChatgptContentScript();
}

function initChatgptContentScript() {
  console.log("[Roundtable][ChatGPT][Init] chatgpt.js loaded on", window.location.href);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "ping") {
      sendResponse({ ok: true, url: window.location.href });
      return false;
    }

    // send_to_chatgpt / start_dom_logger は Step2/Step4 で実装。
    // Step1 では明示的に「未実装」を返し、サイドパネル側で原因が
    // 分かるようにする（無言で落とさない）。
    if (msg.type === "send_to_chatgpt" || msg.type === "start_dom_logger") {
      sendResponse({
        ok: false,
        error:
          "chatgpt.js は Phase 3a Step1 時点でルーティング疎通用の最小実装です（ping のみ対応）。送信 / DOMロガーは Step2 以降で実装予定。",
        notImplemented: true,
      });
      return false;
    }

    return false;
  });
}
