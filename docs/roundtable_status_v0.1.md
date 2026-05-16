# Roundtable プロジェクト 進捗サマリー

**最終更新**: 2026-05-14
**現在のフェーズ**: Phase 1 完了 → Phase 2 準備中

---

## 環境

- **OS**: macOS
- **エディタ**: VS Code + Claude Code 拡張（実装はClaude Codeに全面委任）
- **ブラウザ**: Chrome（拡張は Load unpacked で読み込み中）
- **GitHubリポジトリ**: https://github.com/KazuyaOsaka/roundtable-extension
- **認証**: SSH鍵設定済み（id_ed25519）
- **ローカル作業フォルダ**: ~/Documents/roundtable-extension

---

## Phase 進捗

| Phase | 内容 | 状態 |
|-------|------|------|
| 0 | 環境準備（拡張の骨格） | ✅ 完了（commit ddd83b5） |
| 1 | Claudeタブで1往復（PoC） | ✅ 完了（commit 2bda463） |
| 2 | DOM操作の堅牢化 | 🎯 次の対象 |
| 3 | 3社対応 | 未着手 |
| 4 | 議論履歴共有とターン制御 | 未着手 |
| 5 | システムプロンプト整備 | 未着手 |
| 6 | UI整備 | 未着手 |
| 7 | セッション管理＋エクスポート | 未着手 |
| 8 | 実戦投入＋耐久 | 未着手 |

---

## Phase 0 完了内容

Chrome拡張の骨格を作成し、ChromeにLoad unpackedで読み込むと、ツールバーのアイコンクリックでサイドパネルが開くところまで動作確認済み。

### 作成済みファイル構成

```
~/Documents/roundtable-extension/
├── manifest.json              Chrome拡張の設計図 (Manifest V3)
├── background.js              Service Worker（裏方スクリプト）
├── side_panel.html            サイドパネルUI
├── side_panel.js              サイドパネルUIロジック
├── icons/                     ツールバー用アイコン (16/48/128 px PNG)
├── content_scripts/
│   ├── claude.js              claude.ai に注入
│   ├── chatgpt.js             chatgpt.com に注入（プレースホルダ）
│   └── gemini.js              gemini.google.com に注入（プレースホルダ）
├── docs/
│   ├── roundtable_spec_v0.4.md
│   ├── roundtable_roadmap_v0.1.md
│   └── roundtable_status_v0.1.md  ← 本ファイル
├── README.md
└── .gitignore
```

---

## Phase 1 完了内容

**完了日**: 2026-05-14
**最終コミット**: 2bda463

### 達成した完了条件（ロードマップ Phase 1）

1. ✅ claude.ai を開いてログイン状態
2. ✅ 拡張のサイドパネルを開く
3. ✅ サイドパネルから「こんにちは」を送信
4. ✅ claude.ai のチャット画面に「こんにちは」が反映
5. ✅ Claude が応答
6. ✅ 応答完了後、サイドパネルに応答テキストが表示
7. ✅ 30秒以内に完了（実測5〜6秒）
8. ✅ Cloudflare bot検知が出ない

### 重要な発見・学び

- **TipTap 注入**: `beforeinput-per-char` は常に失敗、`clipboard-paste` が安定動作。実運用ではほぼ常にフォールバック2段目で成功している
- **Cloudflare bot検知**: 揺らぎ（30-90msランダム文字入力遅延）と pointer 系イベント（pointerdown→pointerup→click）の組み合わせで現状回避できている
- **Claude 応答コンテナ**: 決定的なセレクタが無い（data-testid なし、aria-label なし、id なし、class="group" のみ）。`button[aria-label="Retry"]` を起点とした祖先方向の構造ベース探索が必要
- **aria-live プレフィックス**: innerText にスクリーンリーダー向け「Claudeが返答しました: 」が混入。抽出後のクリーンアップが必須
- **content_script の再注入**: 拡張をリロード後の既存タブには静的注入が再適用されない。`chrome.scripting.executeScript` のプログラム注入フォールバックが必須
- **複数タブUX**: Kazuya は常時 6-8 件の claude.ai タブを開く運用。送信先タブの自動選択（サイドパネルを開いたウィンドウのアクティブタブ）が UX 上必須

### 実装した主要機能

- **送信パイプライン**: 3手段フォールバック注入、pointer 系イベント連鎖、送信前後 Cloudflare ガード
- **応答完了検知**: `button[aria-label="応答を停止"]` の出現 → 消滅で完了判定
- **応答テキスト抽出**: 4戦略フォールバック（testid → author-role → Retry祖先 → user-message兄弟）+ prefix/suffix 除去 + 重複段落合体
- **DOMロガー**: 60秒 MutationObserver で要素変化を採取（JSON出力、storage 保存）
- **応答候補スナップショット**: querySelectorAll による構造的網羅採取
- **複数タブ対応**: 明示的タブ選択 ドロップダウン、自動選択（同ウィンドウ active タブ）、📍 現在のタブを送信先にボタン、★ マーカー
- **診断 ping ボタン**: content_script の到達性を DevTools なしで確認可能

---

## 既知の課題（Phase 2 で対応）

### 1. 長文応答の重複出力
- 現象: 350字級の長文応答で、ストリーミング途中スナップショット版と完全版が2回連続出力されるケースあり
- 例: `「日本の歴史は、...平和憲…」 + 「日本の歴史は、...発展した。」`
- 原因: `cleanAssistantText()` の重複検出が完全一致のみ対応。片方が途中切れの場合に重複判定できない
- 対応案: 「2つの段落のうち、片方が他方の prefix なら長い方を採用」のロジック追加

### 2. TipTap 注入の効率
- 現象: `beforeinput-per-char` が毎回失敗してから `clipboard-paste` にフォールバックする無駄
- 対応案: 注入順序を `clipboard-paste` 優先に変更（仕様書 v0.4 の注入優先順位の変更）

### 3. 応答ブロックセレクタの脆弱性
- 現象: 構造ベース（`fallback:retry-ancestor-depth-N`）のみで動作中
- リスク: claude.ai の DOM 構造変更（Retry ボタンの aria-label 変更や階層変化）で破綻する可能性
- 対応案: 将来 claude.ai に `data-testid="assistant-message"` 等が追加された場合の自動切替は既に対応済み（戦略 1, 2 が先に評価される）。Phase 2 では DOM 構造変更検知ロジックを追加

### 4. ツール使用 UI が応答テキストに混入（2026-05-16 発見、Phase 2 スコープ外）
- 現象: Claude が Skill / Tool use を行う応答（素数判定アルゴリズム生成など）で、応答コンテナの innerText に UI ボタンのラベルが混入
- 例: `"ファイルを作成しました, コマンドを実行しました\nファイルを作成しました, コマンドを実行しました"`
- 原因: Claude のツール使用 UI（"Presented file" 表示等）が応答ブロック内に DOM ノードとして存在し、innerText に取り込まれる
- 対応案: 応答ブロック内の特定要素（button / 特定 aria-label）を抽出時にスキップ。Phase 3 以降で対応（ChatGPT の Canvas / Gemini の "Show thinking" と統合的に扱う方が筋が良い）
- 影響範囲: ツール使用しない通常応答（議論や説明）には影響なし

---

## 重要な設計判断（仕様書から抜粋）

### コアコンセプト
1. 既存サブスクで動く（API課金ゼロ）
2. 議論履歴は各社の正規履歴に残る
3. 議長制ラウンドテーブル（人間が指名／進行モードで応答を発動、AIが勝手に喋り出さない）
4. モデル個性を活かす（名前・カラーを表示、忖度禁止プロトコル）
5. 議論は永続的に続く（セッション完了概念なし）

### ターン制御
- ターン進行モード: 指名 / 自動1周 / 自動2周 の3択
- デフォルトターン順: Gemini → ChatGPT → Claude（変更可）

### システムプロンプト方針
- 集団思考の警告を明示、同調圧力・権威への迎合を回避
- 「会議で自分はまだ発言の番じゃない」という状況メタファで待機指示

### UI
- Slack/Discord型のチャットUI、4色アバター、ターン数カウンタ

### エラーハンドリング
- 無音タイムアウト方式、「再試行 / スキップ / 中断」3択UI

---

## Kazuya の背景

- 37歳、東京・豊島区在住
- 観光・ブライダル領域で起業（2026年初頭創業）
- バックグラウンド: 天体物理研究 → システムインテグレーション → ベンチャー → 戦略・新規事業コンサル
- **コーディングスキル**: 自分でコードを書く・読むスキルはない。実装はClaude Codeに全委任
- 役割: 議長・意思決定者として仕様策定・指示・動作確認を行う

---

## 進め方のルール

1. 各フェーズで「動くもの」を作り、Kazuyaが手で動作確認する
2. 完了条件を満たしてから次のフェーズに進む（並行作業しない）
3. 想定外が見つかったら立ち止まり、仕様書を更新してから進む
4. ピボット判断ポイント（ロードマップ§ピボット判断）を意識する

---

## Phase 2 着手内容

**着手日**: 2026-05-14
**作業ブランチ**: feature/phase2-dom-hardening

### スコープ確定（2026-05-14 セッション）

| # | 項目 | 内容 |
|---|---|---|
| A1+C1 | ストリーミング完了の二重判定＋長文重複解消 | 「停止ボタン消滅」＋「テキスト変化停止」二重判定。長文応答での重複出力（途中版＋完全版）も同時解消 |
| A2+C3 | セレクタ fallback 強化＋脆弱性検知 | aria-label 優先、class 最後の階層を明文化。Retry 祖先構造の階層変化検知 |
| A3 | 無音タイムアウト処理 | 仕様書§10 準拠、無音 30 秒。Thinking バッジ表示中はリセット。サイドパネルから設定変更可能 |
| A4 | 構造化エラーログ＋自動DOMロガー | console ログをタグ付き構造化。通常時オフ、エラー検知時に自動起動して直前 60 秒採取 |
| E | 連続テストモード | サイドパネルに「Phase 2 連続テスト」ボタン。10 回連続で同一/類似プロンプトを送信、結果を集計表示 |

### スコープ外
- C2: TipTap 注入順序の clipboard-paste 優先化（Phase 2 完了後に独立した片付けコミットとして対応）

### 完了条件
- ✅ 2000 字以上の長文応答で完了が正確に検知される
- ✅ DevTools Slow 3G で動作する
- ✅ 連続テストモードで 10 回連続成功する
- ✅ Claude の extended thinking 応答でも完了検知できる

### 進捗ログ

#### 2026-05-14: A1+C1 実装完了
- コミット: f2fafcf
- 動作確認: 短文5回 + 長文1回、全て成功
- 安定化所要: 2613〜2620ms（X 閾値 2500ms に対して妥当）

**重要な発見**:
当初の設計仮説「X (二重判定) が主役、Y (重複検出) は保険」は誤り。
実態は「Y が主役、X は補助」が正しい。

理由: Claude の応答 DOM には画面表示用本文と aria-live スクリーン
リーダー用本文の合計 2 つが常に存在する。これは claude.ai の常時的な
仕様で、ストリーミング起因ではない。6 回中 6 回 Y が発火したことで判明。

→ Phase 3 (ChatGPT/Gemini 対応) では、同様に aria-live 用テキストの
有無を最初に調査すべき。各社で挙動が異なる可能性が高い。

#### 2026-05-15: A2+C3 実装完了
- コミット: 042be2d (初版) → ffad11f (fix)
- 動作確認: 短文 3 回 + 長文 3 回、全て成功
- 安定化所要: 2613〜2618ms で安定

**実装内容**:
- セレクタ優先順位の原則（aria-label > data-* > role > tag+属性 > class）をファイル冒頭に明記
- 停止ボタンを配列化（日本語 2 + 英語 2、英語版は Phase 3 で確定）
- 抽出時に `extractionMeta` を返却（W1〜W4 警告の判定材料）
- W3/W4 は error レベルで赤字＋太字表示

**初版 (042be2d) → fix (ffad11f) の経緯**:
初版で長文に対し Y が不発になり、371 字（途中版 + 完全版）が出力される
リグレッション疑いが発生。git diff で「dedup パイプライン未変更」を
確認、リグレッションではなく既存 Y の限界が露呈したと判明。fix で対応:
- Y の正規化に zero-width 文字除去を追加
- 末尾マーカー（「…」「。」「、」「！」「？」「．」「」」「』」「）」等）
  除去後の prefix 比較を追加（**比較専用、出力本文には影響しない**）
- W2 閾値を depth ≥ 5 → ≥ 7 に変更（現状 depth=5 が常態と判明）
- Y 不発時の診断ログを追加（取り損ねパターン解析用）

**重要な発見**:
末尾マーカー除去後の prefix 一致が、現状の claude.ai に対する Y の
主要な発火経路。aria-live スナップショットは「日本の歴史は…」と
「日本の歴史は、縄文・弥生時代の古代社会に始まり、…」の prefix 関係に
あるが、末尾に「…」「、」「。」が付いていて素の prefix 比較では
取り損ねていた。マーカー除去により安定化。

→ Phase 3 で ChatGPT / Gemini の aria-live を観察する際、末尾マーカー
の種類（言語・UI 別に異なる可能性）を最初にチェックすべき。

#### 2026-05-16: A3 実装完了
- コミット: 7f0f850
- 動作確認:
  - 短文「こんにちは」30 秒設定: 通常動作、無音タイムアウト不発
  - バリデーション: 0/-5 → エラー、3 → 警告付き保存、700 → 警告付き保存
  - 5 秒設定で短文: 誤発火なし
  - 1 秒設定で長文: 期待通り `⚠ 無音タイムアウト (1秒 活動なし)` 発火

**実装内容**:
- 設定 UI（折りたたみ式 `<details>`）をサイドパネルに追加
- 無音タイムアウトを `chrome.storage.local` に永続化、送信時に毎回 content_script へ配送
- バリデーション: 数値以外/0以下はエラー、5秒未満/600秒超は警告付き保存
- `waitForResponseComplete()` に無音判定組込（テキスト変化 + Thinking バッジで `lastActivityAt` 更新）
- バックストップ 120秒 → 600秒に緩和（仕様書§10 の精神に沿わせる）
- Thinking バッジ候補配列方式（aria-label / data-testid 6 パターン）

**Thinking バッジの状況**:
extended thinking 系の質問（素数判定）でも検出ログが出なかった。
検知ロジック自体は動作（`Thinking 0回` がログに出る）。claude.ai が
今回の応答で Thinking バッジを表示しなかった可能性が高い。
Phase 3 の英語 UI 採取時に DOM ロガーを並行して回して確定する方針。

#### 2026-05-16: A4 実装完了
- コミット: a2043d5 (初版) → 7d5cd0f (busy-state fix)
- 動作確認:
  - タグ付きログ動作、`[AutoLog]` で start/save/stop が観測可能
  - 1 秒設定で長文 → `silence_timeout` の自動採取保存成功、`📂 最新自動ログ` で JSON 表示
  - busy-state fix: 1 秒設定で失敗 → 即再送 → preflight でデッドロック完全阻止

**実装内容（A4 初版）**:
- AutoDomLogger 実装（応答セッション中のリングバッファ 60 秒、上限 2000 イベント）
- 1000ms 遅延起動でノイズ回避、保存時に古いキー自動削除（保持上限 10）
- 4 トリガー: `stop_button_no_appear` / `silence_timeout` / `extract_failed` / `warn_w3` / `warn_w4`
- 53 個の logPanel 呼び出しにタグ付け（[Wait] [A1] [A3] [Extract] [C1] [C3:W*] [Send] [Inject] [Submit] [CF] [DOM] [AutoLog]）
- サイドパネルに `📂 最新自動ログ` ボタン追加、既存ボタンを「手動」「自動」で命名整理
- コーディング規約: Phase 3 以降は最初からタグ付きで書く（本ドキュメントに明記）

**A4 fix の経緯**:
A4 テスト中に応答中の二重送信問題を発見。1 秒タイムアウト失敗後の即再送で
`findSubmitFallback` が停止ボタンを SVG button として誤クリック →
Claude の応答が中断、入力欄も触られず、お互い待機状態でデッドロック。

修正:
- `performSend()` 冒頭に応答中チェック（preflight）を追加、`{ busy: true }` で即時 reject
- `findSubmitFallback()` で停止ボタン aria-label を含むものを skip
- `STOP_BUTTON_ARIA_LABELS` を切り出し、`STOP_BUTTON_SELECTORS` を `.map()` で派生（DRY）
- side_panel.js で `response.busy` は logWarn 経由（Cloudflare 検知と同等の扱い）

**重要な発見**:
Kazuya 環境ではサイドパネルの送信ボタンが応答中は disabled になっており、
A4 fix の preflight は「UI 側 disabled + content_script 側 preflight」の
二重防御として機能する。将来 UI バグで disabled が解除されても、
デッドロックは発生しない設計に到達。

---

## コーディング規約（運用ルール）

### ログタグ付け（Phase 2 A4 以降）

content_script 内の `logPanel(level, message)` 呼び出しのメッセージ先頭には、フェーズ識別タグを付ける運用ルール。Phase 3 以降の新規実装は最初からタグ付きで書く。

利用中のタグ:
- `[Init]` content_script のロード等
- `[Send]` 送信プロセス全体（入力欄ヒット等）
- `[Inject]` TipTap 注入結果
- `[Submit]` 送信ボタン操作
- `[Wait]` 応答待機関連（停止ボタン検知等）
- `[A1]` テキスト安定化判定
- `[A3]` 無音タイムアウト・Thinking バッジ検知
- `[Extract]` 応答抽出
- `[C1]` 重複検出 (Y)、`[C1:診断]` Y 不発時診断
- `[C3:W1]` 〜 `[C3:W4]` 脆弱性検知の警告
- `[AutoLog]` AutoDomLogger 自動採取
- `[CF]` Cloudflare 検知
- `[DOM]` 手動 DOM ロガー

DevTools の Console フィルタや本番運用時のトリアージで「どのフェーズで起きた問題か」を即座に把握するため。新タグは必要に応じて追加可、既存タグは Kazuya の承認なく変更しない。

---

## 直近の次のアクション

1. A1+C1 実装着手（アプローチ決定後）
2. A2+C3 → A3 → A4 → E の順で実装
3. Phase 2 完了条件をクリアしてから Phase 3（3社対応）へ

---

*このサマリーは進捗とともに更新するライブドキュメント。*
