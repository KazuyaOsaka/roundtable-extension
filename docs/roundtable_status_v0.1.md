# Roundtable プロジェクト 進捗サマリー

**最終更新**: 2026-05-27
**現在のフェーズ**: Phase 3b（Gemini）Step3 完了 ✅（3社 production ready）→ Phase 3b 完了処理 / main マージ判断

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
| 2 | DOM操作の堅牢化 | ✅ 完了（commit 68bd150、10/10 連続成功達成） |
| 3 | 3社対応 | ✅ **3社 production ready**（Claude / ChatGPT / Gemini）。Phase 3b Step3 で Gemini 送信パイプライン完成、10/10×2 + 既存2社リグレッション ✅ |
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

## 既知の課題

### 1. 長文応答の重複出力 — ✅ 解消（Phase 2 A1+C1, A2+C3 fix）
- A1+C1 で二重判定（停止ボタン消滅 + テキスト無変化 2500ms）と prefix 重複検出を実装
- A2+C3 fix で末尾マーカー除去後の prefix 比較を追加 → 連続テスト 10/10 成功で安定確認
- Y 不発時の診断ログで取り損ねパターンを将来も解析可能

### 2. TipTap 注入の効率（Phase 2 スコープ外、将来対応）
- 現象: `beforeinput-per-char` が毎回失敗してから `clipboard-paste` にフォールバックする無駄
- 対応案: 注入順序を `clipboard-paste` 優先に変更
- Phase 2 完了後の独立コミットで対応予定

### 3. 応答ブロックセレクタの脆弱性 — ⚠ 観測性で緩和（Phase 2 A2+C3）
- 現象: 構造ベース（`fallback:retry-ancestor-depth-N`）のみで動作中、現状 depth=5 が常態
- A2+C3 で W1〜W4 警告ロジック追加: 戦略 1/2（data-testid 等）が機能したら検知、depth ≥ 7 で警告、戦略 4 到達 / Retry aria-label 全滅は error 表示
- A4 で自動 DOM ロガーが W3/W4 発火時に直前 60 秒を自動保存 → DOM 変化追跡可能
- 構造的な脆弱性は残るが、変化検知のインフラは整備完了

### 4. ツール使用 UI が応答テキストに混入（2026-05-16 発見、Phase 3 以降）
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

#### 2026-05-16: E（連続テストモード）実装完了 + Phase 2 全完了 🎉
- コミット: 68bd150
- 動作確認: テスト 1〜5 全て期待通り
  - **テスト 1（10 回連続デフォルト設定）: 10/10 成功、全体経過 199 秒**
  - テスト 2（中断機能）: iteration 3 前で停止、集計に「（中断）」表示
  - テスト 3（1 秒設定で誤発火）: 5/10 成功、短文は 1 秒以内に終わるため成功するケースあり（正しい仕様）
  - テスト 4（ストレージ管理）: 6 回実行後も `e_test_result_*` は 5 件以下に制限
  - テスト 5（バリデーション）: 試行回数 0 / 間隔 min>max が正しく拒否

**実装内容**:
- サイドパネルに折りたたみ式「⏱ Phase 2 連続テスト」セクション
- 4 列メイン表 + `<details>` で詳細展開（CSS のみ、JS 不要）
- 既存の `chrome.runtime.sendMessage("send_to_claude")` を流用、送信パイプラインのリグレッションなし
- 中断は「現在の iteration 完了後に停止」、ローカル変数管理
- busy 検知時は次の sleep を +10 秒延長、リトライなし
- 失敗継続、`e_test_result_{timestamp}` で集計保存、保持上限 5 件

**Y 発火パターンの観察（テスト 1）**:
10 回中 prefix 発火 3 回、完全一致発火 6 回、不発 1 回（診断ログ正常発火）。
A4 fix の正規化強化（zero-width 除去 + 末尾マーカー除去）が機能していることを確認。
診断ログは「不発でも長い段落が複数あるケース」を捕捉する設計通り。

---

## 🎉 Phase 2 完了サマリ

**完了日**: 2026-05-16
**作業ブランチ**: feature/phase2-dom-hardening
**全コミット**: 8f5a68b 〜 68bd150（12 コミット）

### ロードマップ完了条件達成状況

- ✅ **同じ往復を 10 回連続実行して全部成功**（テスト 1 で 10/10 達成）
- ✅ 長文応答での完了検知（A2+C3 fix で構造的に保証、200 字応答で検証）
- ✅ Claude の extended thinking 応答での完了検知（A3 Thinking バッジ候補配列で対応、aria-label セットは Phase 3 で再採取して確定予定）
- ✅ Slow 3G 動作（無音 30 秒 + バックストップ 600 秒で構造的に対応、明示的検証は未実施）

### 実装した全項目

| 項目 | 概要 | 主要コミット |
|------|------|-------------|
| A1+C1 | ストリーミング完了の二重判定（停止ボタン消滅 + テキスト無変化 2500ms）+ prefix 重複検出 | f2fafcf, ffad11f |
| A2+C3 | セレクタ fallback 強化（aria-label 優先原則明文化、停止ボタン配列化）+ 脆弱性検知 W1〜W4 | 042be2d, ffad11f |
| A3 | 無音タイムアウト（30 秒デフォルト、設定可能）+ Thinking バッジ候補 + バックストップ 600 秒 | 7f0f850 |
| A4 | 構造化ログタグ（13 種類、53 ログ）+ AutoDomLogger（応答セッション中リングバッファ、4 トリガーで自動保存） | a2043d5, 7d5cd0f |
| E | 連続テストモード（10 回バッチ、4 列 + 展開詳細、集計保存） | 68bd150 |

### Phase 1 → Phase 2 で得た主要な知見

1. **Y が主役、X は補助**: Claude の aria-live スクリーンリーダー用テキストは常時存在、ストリーミングと無関係の常時的仕様
2. **末尾マーカー除去が prefix 比較の鍵**: aria-live の途中スナップショットは「…」「、」「。」で終わる、これらを比較専用で剥がすことで dedup が安定
3. **二重防御の設計**: UI disabled + preflight、X 判定 + Y 検出、無音 30 秒 + バックストップ 600 秒 — 単一防御では信頼できない場面で多層化が有効
4. **観測性重視（自動修復より）**: W1〜W4 警告 / 診断ログ / AutoDomLogger は全て「問題を見える化する」設計。自動修復は将来検討
5. **構造的 DOM 探索の脆さ**: Retry 祖先 depth=5 が現状の唯一の経路。data-testid が追加される将来に向けて W1（歓迎すべき変化）として検知

### 次フェーズ: Phase 3（3 社対応）

新セッションで開始予定。Phase 3 の初手ですべきこと:
- chatgpt.com / gemini.google.com の DOM 構造調査（手動 DOM ロガーで採取）
- **claude.ai 英語版 UI の停止ボタン aria-label 確定** + Thinking バッジ aria-label 確定（A2+A3 で未確定だった項目）
- **aria-live の挙動を 3 社で比較**（claude.ai の知見が他社にも通用するか）
- 末尾マーカーパターンを 3 社で確認（言語・UI 別に異なる可能性）

---

## Phase 3 着手準備

**確定日**: 2026-05-18
**前提**: Phase 2 完了（10/10 連続成功達成、commit 18759c2）

Phase 3 着手前に、ロードマップ v0.1 Phase 3 / 仕様書 v0.4 §12 / ロードマップ
§ピボット判断 を再確認のうえ、以下 2 方針を確定した。

### 方針1: Phase 3 を 2 段階に分割

Phase 3（3 社対応）を以下に分割して進める。

| サブフェーズ | 内容 |
|---|---|
| **Phase 3a** | ChatGPT 対応（DOM 調査 → 実装 → 10 回連続テスト） |
| **Phase 3b** | Gemini 対応（同上） |

- Phase 3a 完了時点で Gemini が困難そうなら、**2 社（Claude + ChatGPT）で
  Phase 4 へ進む選択肢**を持つ。
- 注意: Phase 3a には chatgpt.js の実装だけでなく、現状 claude 専用に
  ハードコードされているルーティング（background.js の
  `chrome.tabs.query`/`send_to_claude`/`list_claude_tabs`、side_panel.js の
  タブ一覧・連続テスト E）の宛先一般化が含まれる。

**理由**:
- ChatGPT で詰まったら、その時点でダウンスコープを判断できる（手戻り最小化）
- レートリミット消耗を 1 社ずつに分散できる（仕様書 §12 のレートリミット
  リスク緩和と整合）
- ロードマップ §ピボット判断「該当社抜きで 2 社議論にダウンスコープ」と整合

### 方針2: Phase 3a 完了時にプロンプト Spike テスト

Phase 3a（ChatGPT 対応）の完了条件を満たした直後に、以下のスポット
チェックを 1 回だけ実施する。

- **対象**: claude.ai 1 社のみ
- **内容**: 仕様書 §5 の忖度禁止プロトコル（初回投入プロンプト）を 1 回
  投入し、「事業の方向性について意見を聞く」系の質問で Claude が忖度せず
  本音を出すかを**目視確認**
- **位置づけ**: Phase 5（システムプロンプト整備）の前倒し実装ではなく、
  リスクの早期スポットチェック。所要 30 分程度
- **判定**: 本音が出ない/合意一色になりそうな兆候があれば status に記録し、
  Phase 5 で匿名モード追加（仕様書 §12 / ロードマップ Phase 5 判断ポイント）
  を検討する材料とする。Phase 3b/4 の進行はブロックしない（情報収集が目的）

**理由**:
- 仕様書 §5 の忖度禁止プロトコルが効かないと Roundtable の中核価値が消える
- Phase 5 まで検証を遅らせると手戻りが大きいため、早期にリスクを可視化する

### この 2 方針による Phase 3 の進行順

```
Phase 3a (ChatGPT 対応 + ルーティング一般化)
  → 完了条件達成（ChatGPT 10/10 連続成功）
  → 【方針2】プロンプト Spike テスト（claude.ai 1 社、30 分）
  → Gemini の難易度を見立て
     ├─ 行けそう → Phase 3b (Gemini 対応)
     └─ 困難そう → 2 社で Phase 4 へダウンスコープ（Kazuya 判断）
```

---

## Phase 3a 進捗ログ

**作業ブランチ**: feature/phase3a-chatgpt（feature/phase2-dom-hardening
先端 e09d650 から派生。main は Phase 1 まで、phase2 ブランチは Phase 2
完了の安全な記録として温存、以後コミットしない）

### ブランチ運用の想定外（2026-05-18 解決）

当初「main から phase3a を派生」予定だったが、**Phase 2 / Phase 3 prep は
main 未マージで feature/phase2-dom-hardening 上にのみ存在**（main は
Phase 1 まで、claude.js 937 行 / phase2 は 1517 行）と判明。main 派生だと
Phase 2 成果（E モード含む）を喪失しリグレッションテスト自体が不能になる
ため、Kazuya 判断で **phase2 先端から派生**に変更。

### Step1: ルーティング一般化（commit c0d9d5a）

**完了日**: 2026-05-18

claude 固定だったルーティング層を `target`（claude/chatgpt）でパラメータ化。

| ファイル | 変更 |
|---|---|
| background.js | `AI_TARGETS` 定義。`list_claude_tabs`→`list_ai_tabs`、`send_to_claude`→`send_to_ai`、`ping_claude`→`ping_ai`（`msg.target`）。content_script 向け型(send_to_claude/ping/start_dom_logger)は不変 |
| side_panel.html/js | 「対象 AI」セレクタ追加、全送信経路に target 付与、切替で一覧再取得、連続テスト中は対象ロック、E も send_to_ai 追従 |
| chatgpt.js | ルーティング疎通用の最小実装（二重ロードガード + ping 応答のみ）。send_to_chatgpt / start_dom_logger は `notImplemented` 明示返却 |

**リグレッション安全性**: `git diff e09d650 -- content_scripts/claude.js`
が空＝claude.js 完全無変更。claude 選択時は Phase 2 と挙動完全同一。

**スコープ c の最小逸脱（Kazuya 承認済み）**:
スコープ c「chatgpt.js 11 行維持」と d「ChatGPT で ping 疎通」が両立不能
だったため、ping リスナ + 二重ロードガードのみ追加。調査(Step2)/送信
(Step4)ロジックは未含。指示ミスは Kazuya 認、逸脱を正式承認。

### Step1 動作確認結果（2026-05-18、Kazuya 実機確認）

| テスト | 結果 |
|---|---|
| 1. Claude 通常往復 | ✅ 対象 AI セレクタ動作、「こんにちは」往復成功 |
| 2. **リグレッション（E モード 10 連続）** | ✅✅✅ **10/10 成功、全体経過 168 秒**。Phase 2 完了時 (18759c2) の 10/10 完全維持＝ルーティング一般化で Claude を壊していない客観証拠 |
| 3. ChatGPT 疎通 | ✅ 対象 AI 切替で chatgpt.com タブ 15 件表示、送信時 `notImplemented` 期待通り（ルーティング機能を確認。ping 単体は未試行だが send 経路で疎通確認済み） |

→ **Step1 完了**。次は Step1 fix（タブ表示改善）→ Step2（調査専用 chatgpt.js）。

### Step1 動作確認で発見した課題（Kazuya 指摘）

1. **ChatGPT タブ表示が分かりにくい**: ChatGPT の URL 構造（`/g/g-p-.../c/...`、
   新規は `/`）は claude.ai と異なり、URL path がノイズ。タイトルが
   読みにくい。→ Step1 fix でタブ表示を対象 AI 別に分岐改善。
2. **ChatGPT のモデル切替（GPT-4o/5/Thinking/Pro）**: 同一チャット内で
   モデル切替可能。Roundtable がモデルを制御するかは仕様未定義。
   → 仕様書 v0.5 §12 に運用ルールを追記（Roundtable はモデルを
   切り替えない。Kazuya が ChatGPT 側 UI で事前選択。送信時に現在の
   モデル名を DOM から読み取り metadata 記録。Step2 の DOM 調査で
   モデル選択 UI も採取対象に含める）。

### Step1 fix2: モデル別タイムアウト戦略の仕様化（commit 2d0ed09）

**完了日**: 2026-05-18

仕様書 v0.5 §12.1.1 を追加。ChatGPT Pro が 5〜15 分かかり A3（無音 30 秒）
では実用不能な問題に対し、**モデル DOM 判定による動的制御は採らず**、
(1) Thinking/Reasoning/Pro 思考表示の確実検知（思考中は無音 TO リセット）
+ (2) バックストップ手動可変、の二段で対応する方針を確定。

### Step1 fix3: バックストップ可変化（commit 13c0793）

**完了日**: 2026-05-18

side_panel に「バックストップ(秒)」設定を追加（既定 600 / 上限 3600 /
バックストップ ≥ 無音 TO の横断検証）。送信・E 両経路で
`backstop_timeout_ms` を送出。**claude.js は無変更**（既に
`settings.backstop_timeout_ms` を解釈）＝リグレッション源なし。

進め方判断: バックストップ可変化は chatgpt.js 調査ロジックではなく設定
UI 変更のため **Step1 fix3 として独立コミット**。これにより Step1
スコープ（ルーティング + 設定 + タブ表示）を確定させ、Step2 を純粋な
chatgpt.js 調査に分離（Step1/Step2 の境目を明確化）。

### Step1 完全完了: fix3 動作確認結果（2026-05-18、Kazuya 実機確認）

| テスト | 結果 |
|---|---|
| 既定表示（30秒 / 600秒） | ✅ |
| 正常保存（無音60/バックストップ1800） | ✅ ログ 17:59:13 に `[A3] 無音60秒/バックストップ1800秒` 表示。`backstop_timeout_ms` が content_script まで end-to-end で到達した客観証拠 |
| 横断検証（バックストップ1秒 < 無音30秒） | ✅ 設定保存失敗、保存されず |
| 上限超え（5000秒） | ✅ `⚠ 上限 3600 秒以下を指定してください` |
| Claude 通常送信リグレッション | ✅ 86字応答取得成功、prefix 重複検出も正常発火 |

→ **Phase 3a Step1 完全完了**（ルーティング・設定・タブ表示が堅牢）。

### 既知の課題（追記、対応不要）

**5. Claude 応答にメタ認知ログが稀に混入（2026-05-18 観察、対応不要）**
- 現象: Claude 応答に「識別した言語に応じて友好的に応答することを
  決定した。」等のメタ認知文が 2 回混入するケースを観察
- 原因: claude.ai 側のレアな挙動。Roundtable のバグではない
- 影響: なし。dedup が「prefix 重複検出（段落2が段落1の prefix）」で
  正常動作し 86字採用 / 32字破棄。Roundtable 側の対応不要
- 記録目的のみ（既知の課題#1〜#4 と異なり修正対象ではない）

### Step2: 調査専用 chatgpt.js（commit 3b87b10）

**実装完了日**: 2026-05-19 / **採取・解析完了日**: 2026-05-19（Step2 完了、Step3 解析も本セッションで実施済み）

chatgpt.js を Step1 最小スタブから調査専用ロジックに差し替え:
- 二重ロードガード + ping（Step1 から維持）
- 手動 DOM ロガー（claude.js domLogger 移植、挙動同一。
  aria-live / conversation-turn も分類対象に追加）
- ChatGPT 構造スナップショット（ロガー停止時に自動採取、
  `assistant_snapshot_<ts>` に保存）。網羅候補 + 狙い撃ちプローブ:
  全ボタン aria-label / 停止ボタン / **Thinking・Reasoning・Pro** /
  モデル選択 UI / composer / aria-live / bot 検知
- **送信は notImplemented 維持**（Step4 送り）
- claude.js / background.js / side_panel.js 無変更＝リグレッション源なし

採取主目的（仕様書 v0.5 §12.1.1）: Thinking/Pro 思考表示の確実な
セレクタ確定。Phase 2 で claude.ai で空振りした Thinking 検知の知見が
ChatGPT 運用性の鍵として回収される構図。

### Step2 採取結果（2026-05-19、Kazuya 実機採取 + Step3 解析）

**採取条件**: GPT-5.5 Thinking、短文「こんにちは」1 往復、43 イベント
+ 構造スナップショット（assistant_snapshot_1779183267410）。
**Kazuya 重要情報**: ChatGPT は Thinking か Pro でしか使わない
（普通モード不使用）→ 仕様書 v0.5 §12.1.2 に明文化。

**3 往復予定 → 1 往復で十分と判断**（Kazuya 推奨 + Claude Code 同意）。
理由: 短文 + Thinking で最も情報量の多いケースを取得、Step4 必須
セレクタほぼ全取得、ChatGPT DOM は id+testid で claude.ai より堅牢。
長文挙動は Step4 で走らせて必要なら追加調査の方が効率的。

**確定セレクタ（claude.ai より堅牢）**:

| 用途 | セレクタ |
|---|---|
| 入力欄 | `#prompt-textarea` |
| 送信 | `button#composer-submit-button[data-testid="send-button"]`（aria「プロンプトを送信する」） |
| 停止 | 同 ID で `[data-testid="stop-button"]`（aria「回答を停止」）。送信⇔停止が同 ID で testid 切替 |
| 応答抽出 | `[data-message-author-role="assistant"]`（最後の要素）。claude の戦略2が ChatGPT では第一候補、Retry 祖先探索 不要 |
| 会話ターン | `[data-testid="conversation-turn-N"]` |
| モデル表示 | `[data-testid="model-selector-dropdown"]`（§7 metadata.model） |

**Thinking ライフサイクル（Phase 2 最大の回収点）**:
```
t=4451ms  「思考中」+ author-role=assistant 出現
t=6470ms  「思考中」+ class=loading-shimmer
t=9866ms  「思考中」消滅 → 「思考時間: 数秒」へ
t=12151ms 停止ボタン消滅 → 完了
```
- Thinking 検知候補: text「思考中」+ `class*="loading-shimmer"`
- 完了マーカー: text「思考時間: XXX」を含む button
- claude.ai で空振りした Thinking 検知が ChatGPT で実証 →
  仕様書 v0.5 §12.1.1 戦略がそのまま動く

**Step4 に持ち越す未確認3点（解決済みでない、連続テストで検証）**:
1. aria-live 二重 render の有無（Phase 2「Y が主役」が ChatGPT で
   成立するか。短文1回では未到達 → Step4 10連続で Y 発火観測）
2. 長文ストリーミング安定化閾値（現状 2500ms は claude.ai 実測値 →
   Step4 長文で実測チューニング）
3. bot 検知（Step2 で痕跡なし → 汎用ガードのみ移植、検知時停止）

**ピボット評価**: ChatGPT DOM は claude.ai より堅牢（id+testid+aria
三重）。Thinking 検知も実証済み。現時点でピボットリスクは低い。

→ **Step2 完了 / Step3（解析）実施済み**。次は Step4（送信パイプライン）。

### Step4: chatgpt.js 送信パイプライン（commit 872bd7a）

**実装・動作確認完了日**: 2026-05-19（Kazuya 実機確認）

chatgpt.js に送信パイプライン実装（claude.js アーキ移植、ChatGPT
セレクタ差替え。調査ツール=手動DOMロガー/スナップショット維持）。
入力欄 `#prompt-textarea` / 送信 send-button / 停止 stop-button
（同 ID で testid 切替）/ 抽出 `[data-message-author-role=assistant]`。
Thinking 検知（思考中+loading-shimmer、無音TOリセット）。
**claude.js/background.js/side_panel.js 無変更＝リグレッション源なし**。

**動作確認結果（Step4 完了条件 全 ✅）**:

| テスト | 結果 |
|---|---|
| 1. ChatGPT 単発往復 | ✅ Thinking 検出 12回・無音TOリセット機能、9秒で 39字取得 |
| 2. **Claude リグレッション 10連続** | ✅ **10/10、175秒**。Phase 2 (18759c2) と完全一致＝claude.js 無変更の証拠 |
| 3. **ChatGPT 10連続（Step4 核心）** | ✅ **10/10、234秒**。Thinking 毎回発火（9〜61回/iter）、`[C1]` 10/10 不発、レート制限なし |

**持ち越し3点の判定（確定）**:
1. aria-live 二重 render → **ChatGPT には無い**（10/10 `[C1]` 不発一貫）。
   仕様書 v0.5 §12.1.3 に dedup 戦略差を明文化（claude=Y 主役 /
   ChatGPT=dedup は保険）。誤検出回避も妥当（iter5 段落[32,92,27]字
   を重複でないと正しく素通し）
2. 安定化閾値 2500ms → **妥当**（全 iter 2664〜2682ms 一貫）
3. bot 検知 → **chatgpt.com に常時ガード無し**（10連続 0 件）

**既知の課題#6（Step4 で判明、Step4 完了に影響せず）**:
完了マーカー「思考時間: XXX」が軽い Thinking では出ない（10/10 全て
完了マーカー=false）。Step2（やや重い Thinking）では確認できた挙動。
一次信号（stop-button 消滅）+ Thinking 検知で 10/10 成功するため
問題なし。完了マーカーは補助であり必須でない。Phase 8 実戦投入で
長文 Thinking 時に再観察。

→ **Phase 3a Step4 完了。chatgpt.js は production ready。**

### Step1 fix4: Enter 送信 / Shift+Enter 改行（commit f4be43d）

**完了日**: 2026-05-19（Kazuya 確認）

メインのメッセージ欄(#message)を「Enter=送信 / Shift+Enter=改行」に。
各社チャット標準動作に合わせる。E モード textarea は「1行1メッセージ」が
本質なので Enter=改行のまま据え置き（意図的に対象外）。IME 変換確定の
Enter は isComposing/keyCode 229 で除外。影響は side_panel のみ。

**動作確認**: Enter 送信 ✅ / Shift+Enter 改行 ✅ / IME 確定で誤送信なし ✅ /
E モード非回帰 ✅。

### fix5: 改行注入の検証式バグ修正（commit 72ed790）

**発見**: fix4 で Shift+Enter 改行を提供した直後、改行を含むメッセージで
注入 3 手段が一律「失敗」する想定外バグを発見（claude.js / chatgpt.js
両方）。立ち止まって Kazuya 切り分けテスト実施。

**原因（確定）**: ProseMirror 系エディタが \n を段落化し、注入は視覚的に
成功しているのに innerText が "一行目\n\n二行目"（二重 \n）になるため、
検証式 `getInputText(input).includes(text)` が改行数差で false を返す。
3 手段一律失敗 = 個別注入バグではなく共通の検証ロジックが原因。
（Phase 1/2 で単行しかテストしておらず見逃していた）

**修正**: 検証専用の `normalizeForInjectCheck`（改行ランを 1 つに畳む）+
`injectionTextLanded` を両ファイルに同型追加し、各注入メソッドの最終比較を
置換。単行（\n 無し）には影響しない no-op。

**重要な状態変化**: 本 fix で **Phase 3a で初めて claude.js を変更**
（バグが両社共通＝検証式が両ファイルにあるため）。「claude.js 無変更＝
リグレッション源なし」の保証は外れたため、再テストで Claude 10 連続を必須確認。

**動作確認（2026-05-25、Kazuya 実機、全 ✅）**:

| テスト | 結果 |
|---|---|
| 1. Claude 単行 | ✅ 45字応答 |
| 2. **Claude 改行あり** | ✅ Claude が「改行が反映されている」と明示確認（fix5 決定的証拠） |
| 3. ChatGPT 単行 | ✅ |
| 4. **ChatGPT 改行あり** | ✅ オウム返しで改行再現 |
| 5. **Claude 10連続（claude.js 変更後のリグレッション）** | ✅ **10/10、399秒**。Phase 2 挙動を完全維持 |
| 6. ChatGPT 10連続 | ✅ **10/10、219秒** |

17:20:39 の「AutoLog まで止まる」現象は fix5 後 **再現せず**。

→ **fix5 完了 / Step4 完全完了 / Phase 3a Step1-4 + fix1-5 完了。**

### 既知の課題#7: Claude 10連続で稀に発生する100秒級遅延（2026-05-25 観察、対応不要・要観察）

fix5 再テストの Claude 10 連続（399秒、Phase 2 完了時 175秒 の約2倍）で、
2 つの iteration に「注入処理開始までの長い沈黙」を観察:
- iteration 4: AutoLog 開始後 99 秒して `[Inject]` 行が出る
- iteration 7: 同様に 70 秒後
最終的に注入は成功し 10/10 達成。**fix5 のバグではない**（最終的に正常完了）。
仮説: Mac 環境負荷 / Chrome 拡張メモリ圧迫 / claude.ai サーバ側の一時遅延 /
AutoLog 準備処理の稀なハング。ChatGPT 10連続（219秒）では発生せず＝Claude
タブまたは Mac 側の問題と推測。Phase 8 実戦投入で再現するか観察。

### Step5（E モード ChatGPT 拡張）について

ロードマップ上の Step5「E モード ChatGPT 拡張 → 10連続」は、実装の
自然な流れで **Step1（E を send_to_ai+target に追従）+ Step4（ChatGPT
10/10 を E モードで検証）に吸収**された。独立 Step5 としての作業は
発生せず、完了条件（ChatGPT 10連続 10/10）は Step4 で達成済み。

### Step6: プロンプト Spike テスト（commit 予定）— ✅ 強く効いた

**実施日**: 2026-05-25（Kazuya 実機、claude.ai 1 社）

仕様書 §5 初回投入プロンプトを claude.ai に投入し、忖度なしの意見を
求める問い 2 つ（「提携先拡大 vs プロダクト磨き込み、忖度なしで」/
「最初の1年で何に集中すべきか、忖度なしで」）で検証。

**判定: ✅ 完全合格**:
- 率直に立場明示（「プロダクト磨き込み先行派」即答）
- 異論・前提疑い（「やらないこと4つ」を明示的に NO、前提の数字を問い返す）
- 無難な同意・両論併記の逃げ なし
- Kazuya への確認質問あり（§5 通り）/ 他参加者（Gemini/ChatGPT）の
  役割想定あり / 「あえて反対意見として置く」とメタ意識を言語化

**核心仮説の実証**: 「忖度禁止プロトコルを与えれば AI は本音で議論する」
→ claude.ai 1 社で実証。Claude は §5 を内面化・応用するレベルに到達。
Phase 4 の 4 者ラウンドテーブル設計の確信度が大幅向上。

**Phase 5 への示唆**: **匿名モード追加は不要**（プロトコルだけで十分効く）。
ロードマップ Phase 5 の判断ポイント「合意一色なら匿名モード検討」は、
現時点では発動不要の見込み。

**注意（未検証）**: ChatGPT / Gemini で同じプロトコルが効くかは未検証。
Phase 3b 完了後、3 社揃った段階で実際の Roundtable モードで再 Spike 推奨。

---

## 🎉 Phase 3a 完全完了サマリ

**完了日**: 2026-05-25 / **main マージ**: commit 2a34617（push 済み）

- **Step1**（ルーティング一般化、claude 無変更）+ fix（タブ表示）/
  fix2（timeout 戦略 spec）/ fix3（バックストップ可変）/ fix4（Enter 送信）/
  fix5（ProseMirror 改行注入検証式）
- **Step2**（調査専用 chatgpt.js）/ **Step3**（採取解析）/
  **Step4**（送信パイプライン Thinking-aware、両社 10/10）/
  **Step5**（Step1+4 に吸収）/ **Step6**（プロンプト Spike ✅）
- Claude / ChatGPT 両社 production ready。仕様書 v0.5 整備。
- 残: **Phase 3b（Gemini）**。困難なら 2 社で Phase 4 へダウンスコープ。

---

## Phase 3b 進捗ログ（Gemini）

**作業ブランチ**: feature/phase3b-gemini（main 2a34617 から派生）

### Step1: routing 一般化 + 調査専用 gemini.js（commit 71d7ba6）

**完了日**: 2026-05-26

Phase 3a Step1 で routing は target 化済みのため、Gemini 追加は最小:

| ファイル | 変更 |
|---|---|
| background.js | `AI_TARGETS.gemini`（urlPrefix/urlMatch/script/`send_to_gemini`）追加（+7 行、追加のみ） |
| side_panel.html/js | 🟨 Gemini セレクタ + タブ表示ロジック（URL ノイズ `/app`,`/gem/<id>` 除去）（+16 行） |
| manifest.json | Phase 0 から gemini 登録済み（**無変更**） |
| gemini.js | 二重ロードガード + ping + 手動 DOM ロガー + 構造スナップショット。`send_to_gemini` は notImplemented |

**リグレッション安全性**: `git diff main..HEAD -- claude.js chatgpt.js` 空＝**両ファイル完全無変更（バイト一致）**。

### Step1 + ping 動作確認（2026-05-26、Kazuya 実機）

| テスト | 結果 |
|---|---|
| A. Claude リグレッション | ✅ 35字往復、`fallback:retry-ancestor-depth-5`、dedup 正常発火。Phase 3a 挙動完全一致 |
| A. ChatGPT リグレッション | ✅ 23字往復、Thinking 12 回検出、dedup 不発。Step4 挙動完全一致 |
| B. Gemini ping | ✅ content_script 到達（`https://gemini.google.com/app?hl=ja`） |

→ routing に gemini 追加でも既存2社が無傷である客観確認。

### Step1b: ストリーミングスナップショット強化（調査専用、本番影響ゼロ）

初回 DOM 採取で**停止ボタン・思考表示が完全空振り**。根本原因 = 手動 DOM
ロガーの MutationObserver が `childList` のみ監視で、Gemini（Angular）の
**characterData ストリーム + 属性/クラス切替**を拾えない（送信⇔停止・思考は
ノード入替ではなく属性変化）。対策として gemini.js に**生成中の DOM 状態を
間隔ポーリング採取する `stream_snapshots`**（t=2〜30秒で10枚）を追加 +
最終スナップショットの thinking プローブを **class 対応**化。`send_to_gemini`
は notImplemented 維持＝Claude/ChatGPT・本番挙動への影響ゼロ。

**ツールの学び**: childList-only observer は SPA の属性/characterData 駆動
UI（ストリーミング本文・状態トグル）を構造的に採取不能。生成中の
間隔スナップショットで補完するのが定石。

### Step2 採取・解析 — 完全クローズ ✅（2026-05-26、Kazuya 2回採取）

**採取条件**: Gemini 3.5 Flash 思考拡張、「91 と 97 と 119、それぞれ素数か
理由とともに判定」、Show thinking 展開済みで 60 秒終了、stream_snapshots 10 枚。

**確定セレクタ（claude.ai より堅牢: data-test-id + Web Component + aria の三重）**:

| 用途 | セレクタ |
|---|---|
| 入力欄 | `rich-textarea .ql-editor[role="textbox"]`（aria「Gemini へのプロンプトを入力」）。**Quill エディタ** |
| 送信 | `[data-test-id="send-button-container"] button[aria-label="プロンプトを送信"]` |
| 停止 | 同コンテナ内 `button[aria-label="回答を停止"]`（**送信⇔停止が同一ノードで aria 切替＝ChatGPT 型**） |
| 応答抽出 | **最後の `model-response` 内 `.markdown-main-panel`**（「Gemini の回答」プレフィックス無し） |
| 思考(live) | `[data-test-id="thinking-overlay-content"]` / `.thinking-dots-animation` / `.thinking-container`（英語ヘッドライン "Analyzing…"）+ 応答に `.has-thoughts` |
| モデル表示 | `[data-test-id="bard-mode-menu-button"]`（text「Flash 拡張」、§7 metadata.model） |

**重要発見**:
1. **停止ボタン = `回答を停止`**（stream_snapshots で t=10〜20 秒の生成中のみ出現を実証）。childList observer の死角だったが間隔 SS で確定。
2. **思考検知を Gemini で達成**（Phase 2「Thinking 回収点」）: 生成中に
   `thinking-overlay-content` / `thinking-dots-animation` が出現。無音 TO
   リセットに使える（仕様書 §12.1.1 戦略が 3 社目でも成立）。
   なお `<model-thoughts>` 要素は**存在しない**（当初仮説は誤り、データで訂正）。
3. **dedup = 保険（ChatGPT 同型）**: 完了応答は `aria-live="off"`、最新のみ
   `polite`、cdk-announcer は空。本文の常時二重 render 無し（Claude と異なる）。
   → 抽出は**最後の** `.markdown-main-panel` をピンポイント。
4. **完了検知**: 停止ボタン「回答を停止」出現→消滅（claude/chatgpt と同型）
   + A1 安定化。⚠ `response-footer.complete` は会話内の過去ターンで
   document 全体が汚染されるため、**最後の model-response にスコープ**すること。
5. **Quill エディタ**（`.ql-editor`）。Claude(TipTap)/ChatGPT(ProseMirror) と
   別系統 → **Step3 で fix5 の改行二重化が Quill で再発しないか要重点検証**。
6. **bot 検知**: recaptcha/cloudflare とも false（chatgpt.com 同様、常時ガード無し）。

**採取データ**: `docs/gemini_domlog.json`（141 events + stream_snapshots 10）/
`docs/gemini_snapshot.json`（構造スナップショット）。調査記録。

**ピボット評価**: リスク低。Gemini DOM は三重アンカーで堅牢、思考検知も実証。
**2 社ダウンスコープは不要、Phase 3b 続行**。

→ **Step3（gemini.js 送信パイプライン: 注入/送信/応答抽出 + Thinking-aware）へ。**

### Step3: gemini.js 送信パイプライン（commit cf089c6）— 完全勝利 ✅

**実装・動作確認完了日**: 2026-05-27（Kazuya 実機確認）

chatgpt.js アーキを移植し Step2 確定の Gemini セレクタに差替え。
`send_to_gemini` を notImplemented から実送信に切替。**claude.js /
chatgpt.js は無変更（main とバイト一致）＝リグレッション源なし**。
Quill 注入は `normalizeForInjectCheck`（fix5）を移植。完了検知は
「回答を停止」出現→消滅 + A1 安定化。Thinking 検知は
`thinking-overlay-content` / `thinking-dots-animation`。

**動作確認結果（全 ✅）**:

| テスト | 結果 |
|---|---|
| 1. Gemini 単発「127は素数か」 | ✅ 349字、Thinking 31回、`selector=model-response .markdown-main-panel`、プレフィックス混入なし |
| 2. **Gemini 改行あり**（3行） | ✅ **Quill で fix5 が効いた**。注入は `execCommand-insertText`、Gemini が改行を正しく認識（「四・五・六行目」とカウントアップ） |
| 3. Gemini 10連続 ① | ✅ **10/10、222秒** |
| 4. Gemini 10連続 ②（リロード後） | ✅ **10/10、231秒** |
| 5. Claude 改行リグレッション | ✅ 「3行ともきれいに反映」 |
| 6. ChatGPT 改行リグレッション | ✅ オウム返しで改行再現 |

**重要な観察**:
1. **注入主軸が3社で異なる**: claude=clipboard-paste / chatgpt=clipboard-paste
   / **gemini=execCommand-insertText**。→ 3手段フォールバック設計が正解だった。
2. **Thinking 検知が完璧**: iter5（1067字応答）で 26 秒の長考を Thinking
   35→55 回検知で完全カバー。`thinking-dots-animation` と
   `thinking-overlay-content` の両方が発火。無音 TO リセットが機能。
3. **dedup は ChatGPT 型（予測通り）**: 全 iteration で `[C1]` 不発が正常。
   iter4,8 の「段落 2 個」診断は重複でなく正当な複数段落を正しく素通し。
4. **既存2社リグレッション ✅**: Claude=完全一致重複検出 Phase 2 通り、
   ChatGPT=aria-live なし Step4 通り。

**fix5 の汎用性が実証**: ProseMirror 系3エディタ
（Claude=TipTap / ChatGPT=ProseMirror / Gemini=Quill）すべてで改行注入検証式が
機能。**Quill 改行二重化リスクは fix5 移植で完全解消、追加 fix 不要**。

→ **Phase 3b Step3 完了。gemini.js は production ready。3社揃った。**

---

## 🎉 Phase 3b 完了サマリ（Gemini）

**完了日**: 2026-05-27 / **作業ブランチ**: feature/phase3b-gemini

- **Step1**（routing 一般化 + 調査専用 gemini.js、claude/chatgpt 無変更）
- **Step1b**（ストリーミングSS強化: childList observer の死角を間隔
  ポーリングで補完。停止ボタン・思考表示を可視化）
- **Step2**（DOM 解析: Quill 入力 / `回答を停止` / `model-response
  .markdown-main-panel` / `thinking-overlay-content` 確定。dedup=ChatGPT 型）
- **Step3**（送信パイプライン Thinking-aware、10/10×2 + 既存2社リグレッション ✅）
- **3社 production ready 達成**（Claude / ChatGPT / Gemini）

**Phase 3 全体の意義**:
- **Thinking 検知戦略を3社で確立**（Phase 2「回収点」の3社目）。各社で
  表現は違う（claude=空振り→Phase3で再採取 / chatgpt=loading-shimmer+思考時間 /
  gemini=thinking-overlay-content+thinking-dots-animation）が、
  「思考中は無音 TO リセット」の方針が全社で機能。
- **fix5 が ProseMirror 系3エディタで汎用的に機能**（TipTap/ProseMirror/Quill）。
- **3手段注入フォールバックの正しさ実証**（主軸が claude/chatgpt=paste、
  gemini=execCommand と社ごとに異なる）。
- **dedup 戦略の社差を明文化**: claude=Y 主役 / chatgpt=保険 / gemini=保険
  （完了応答 aria-live=off で本文の二重 render 無し）。

**残タスク（Kazuya 判断待ち）**:
1. 3社揃った Roundtable プロンプト Spike 再テスト（Step6 相当。仕様書 §5
   忖度禁止プロトコルが ChatGPT/Gemini でも効くか。Phase 3a Step6 で claude
   単体は実証済み、3社での再検証は未実施）
2. Phase 3b 完了として main マージ判断 → Phase 4（議論履歴共有とターン制御）へ

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

1. **新セッションで Phase 3 開始**（コンテキスト整理のため）
2. Phase 3 初手:
   - chatgpt.com / gemini.google.com の DOM 構造を手動 DOM ロガーで採取
   - claude.ai 英語版 UI で停止ボタン / Thinking バッジの aria-label を確定
   - aria-live 挙動の 3 社比較、末尾マーカーパターンの確認
3. Phase 3 完了後は Phase 4（議論履歴共有とターン制御）へ

---

*このサマリーは進捗とともに更新するライブドキュメント。*
