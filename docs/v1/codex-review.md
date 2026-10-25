# Codex への引継ぎ：再現とレビューの手順

## 再現

```
git fetch origin ccr-85719f93-q7j8p2 && git checkout ccr-85719f93-q7j8p2
cd app
npm ci
npm test                 # 45件。期待値: "# pass 45" "# fail 0"（HTTPS 試験に openssl を使用）
npm run check:panel      # パネルを公式ホストSDK（AppBridge）で動かす。Playwright＋Chromium が必要
npm run check:ui         # 議長画面を模擬参加者で操作する。Playwright＋Chromium が必要
npm run demo:mock        # 模擬参加者つきで起動 → http://127.0.0.1:8787/
```

- Node.js 22 以上が必要です（検証は v22.22.0 で行いました）。
- `demo:mock` は実サービスに接続しません。模擬 Claude（2025年版MCP・タスク内待機）、模擬 ChatGPT（2026-07-28版MCP・MCP Events）、模擬 Gemini（参加者ページ）が自動で応答します。
- 実データは `app/data/`（gitignore 済み）に入ります。`config.json` は参加者トークンと議長トークン、`subscriptions.json` は Webhook の署名鍵、`meetings/*.jsonl` は議事録のイベント記録です。いずれもコミットしないでください。

## コードの地図

| ファイル | 役割 |
|---|---|
| `app/src/core/engine.js` | 会議の中核。議長コマンド、参加者コマンド、進行（`_advance`）、期限（`tick`）、表示用の状態 |
| `app/src/core/reducer.js` | イベント → 状態の純粋関数（再生で復元） |
| `app/src/core/render.js` | AIに渡す依頼文（差分、データの囲み）、Markdown 出力 |
| `app/src/core/report.js` | 接続試験・連結試験の判定（起こされ方の分類、引用チェック） |
| `app/src/core/store.js` | JSONL 追記と fsync、末尾の破損行への対応 |
| `app/src/mcp/server.js` | MCP ツール、MCP Events のメソッド、パネル（MCP App）、旧版／新版の振り分け |
| `app/src/mcp/events.js` | MCP Events：購読、コールバック検証、Standard Webhooks 署名、SSRF 対策、再送 |
| `app/src/mcp/panel.js` | パネルの HTML（公式 ext-apps バンドルを埋め込み） |
| `app/src/web/participant.js` | トンネルで公開するルート（`/mcp/<token>`・`/p/<token>`） |
| `app/src/web/chair.js` | 議長 API（localhost のみ）と SSE |
| `app/public/` | 議長画面 |
| `app/test/` | 単体・結合試験。`mocks.js` は模擬参加者。`review-fixes.test.js` は独立レビューの指摘の回帰試験 |
| `app/scripts/check-panel-host.mjs` | パネルを公式ホストSDKで動かす検証 |
| `app/scripts/check-ui.mjs`・`mock-lib.mjs`・`demo-mock.mjs` | 模擬参加者での画面確認・デモ |

## 重点的に見てほしい点

1. **一回性の不変条件**（`engine.js` の `post`・`_advance`・`_interrupt`・`_markStepDone`）
   - 1つの依頼に、受理される回答は1件まで
   - 割込・停止・期限切れ・終了の後に届いた回答は、転送もされず、回数にも数えられない
   - 並行ステップで1人だけ旧前提にされた場合、その人だけに再依頼する
   - `timeUp` と `maxTurns` の境界
2. **再生の決定性**：reducer が時計や外部状態を読んでいないか。`request_delivered` で差分の範囲（`deltaExclude`・`seen`）を確定させる処理が、再生で同じ結果になるか。
3. **独立ラウンドの見え方**：同じラウンドの他AIの回答が漏れないこと（`hideAiAfterSeq`）。次のラウンドで、漏れも重複もなく届くこと。
4. **起こす通知の一回性**：パネルの `claimTrigger` と MCP Events の `claimPushWake` が、経路をまたいで1依頼1回になっているか。結果が「不明」「失敗」のときに自動で再送しないか。
5. **MCP Events の安全性**（`events.js`）
   - 名前解決したアドレスへの固定接続、private アドレスの拒否、リダイレクト不可
   - 検証チャレンジの比較
   - 購読IDの決定性
   - 自動再送をしないこと（議長の許可で送る場合は新しいイベントIDになる）
   - `RT_ALLOW_PRIVATE_CALLBACKS` が本番で有効にならないか
6. **トランスポート**：旧版（2025）のリクエストを JSON 応答へ振り分ける部分（`server.js` の `handlerFor`）。待機中に接続が切れた場合の扱い（`waitForTurn` の `signal`）。
7. **ツール注釈の正直さ**：`get_my_turn`／`wait_for_my_turn` は「受信済み」の記録だけを書き、`readOnlyHint: true` にしています。この判断の妥当性を見てください。`post_message` は書込み（非破壊・冪等）と申告しています。
8. **議長 API**：Host 検査、POST に議長トークン必須、SSE の `?k=`、静的ファイルのパストラバーサル。
9. **画面の XSS**：AIの本文は `textContent` でのみ表示しているか。
10. **文書の主張と出典**：[connection-research.md](connection-research.md) の各行が、出典と矛盾していないか。

## 実機で決着していない点（設計判断に影響するもの）

- claude.ai がパネルの `ui/message` を、クリックなしで受け付けるか
- claude.ai で `wait_for_my_turn` を何回まで続けられるか
- ChatGPT（Plus/Pro）で書込みツールが使えるか、Work チャットで MCP Events が購読されるか、イベントでの実行時に確認が出るか
- Gemini Tasks で、参加者ページの再読み込みと投稿を、本人操作なしでどこまで続けられるか

結果は [verification.md](verification.md) に記録されます。上の点が否定された場合、v1 の「AIだけで続ける」は、その社について本人の確認操作が必要になります（[README](../../README.md) の「既知の制限」）。
