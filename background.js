// background.js — Roundtable のバックグラウンド Service Worker
// ============================================================
// これは拡張の「裏方」スクリプト。Chrome内部で動き、UI を持たない。
// 役割（最終的に）:
//   - サイドパネルと content_script の間でメッセージを中継
//   - 議論ターン進行の制御
//   - chrome.storage への議論セッション保存
//
// Phase 0 では「アイコンクリックでサイドパネルを開く」だけ。
// 中身は最小限。
// ============================================================

// ツールバーのRoundtableアイコンがクリックされたら、
// サイドパネルが自動で開くように設定する。
// （これを呼ばないと、アイコンクリックで何も起きない）
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    console.error("[Roundtable] サイドパネルの設定に失敗:", error);
  });

// 拡張のインストール時／更新時に1回だけ呼ばれる。
// Phase 0 では起動確認用のログだけ出す。
chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`[Roundtable] 拡張がロードされました (reason: ${reason})`);
});
