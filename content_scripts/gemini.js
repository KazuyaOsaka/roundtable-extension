// content_scripts/gemini.js — gemini.google.com 用 Content Script
// ============================================================
// これは https://gemini.google.com/* のページが開かれた時に、Chromeが
// 自動でそのページに「注入」して実行するスクリプト。
// ページのDOMに直接アクセスでき、入力欄に文字を入れたり、送信ボタンを
// クリックしたり、応答テキストを抽出したりできる。
//
// Phase 0 ではプレースホルダ（実装は Phase 3 以降）。
// ============================================================

console.log("[Roundtable] gemini.js loaded on", window.location.href);
