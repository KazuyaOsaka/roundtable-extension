// content_scripts/chatgpt.js — chatgpt.com 用 Content Script
// ============================================================
// これは https://chatgpt.com/* のページが開かれた時に、Chromeが自動で
// そのページに「注入」して実行するスクリプト。
// ページのDOMに直接アクセスでき、入力欄に文字を入れたり、送信ボタンを
// クリックしたり、応答テキストを抽出したりできる。
//
// Phase 0 ではプレースホルダ（実装は Phase 3 以降）。
// ============================================================

console.log("[Roundtable] chatgpt.js loaded on", window.location.href);
