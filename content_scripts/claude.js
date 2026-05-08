// content_scripts/claude.js — claude.ai 用 Content Script
// ============================================================
// これは https://claude.ai/* のページが開かれた時に、Chromeが自動で
// そのページに「注入」して実行するスクリプト。
// ページのDOMに直接アクセスでき、入力欄に文字を入れたり、送信ボタンを
// クリックしたり、応答テキストを抽出したりできる。
//
// Phase 0 ではプレースホルダ（実装は Phase 1 以降）。
// ============================================================

console.log("[Roundtable] claude.js loaded on", window.location.href);
