# Roundtable

Claude / ChatGPT / Gemini の Web UI と人間1名で、4者ラウンドテーブル議論を行う Chrome 拡張。

## コンセプト

- 既存サブスク（Claude Pro / ChatGPT Plus / Gemini Advanced）をそのまま活用、API課金ゼロ
- 議論履歴は各社の正規履歴に残るので、後日「あの議論の続き」が各アプリで可能
- 議長制ラウンドテーブル：人間が指名／進行モードで応答を発動
- 忖度禁止＋集団思考回避プロトコル

詳細は [docs/roundtable_spec_v0.4.md](docs/roundtable_spec_v0.4.md) を参照。

## 開発状況

ロードマップ（[docs/roundtable_roadmap_v0.1.md](docs/roundtable_roadmap_v0.1.md)）に沿って Phase 0 → Phase 8 の段階で実装。

| Phase | 内容 | 状態 |
|-------|------|------|
| 0 | 環境準備（拡張の骨格） | ✅ 完了 |
| 1 | Claudeタブで1往復（PoC） | 未着手 |
| 2 | DOM操作の堅牢化 | 未着手 |
| 3 | 3社対応 | 未着手 |
| 4 | 議論履歴共有とターン制御 | 未着手 |
| 5 | システムプロンプト整備 | 未着手 |
| 6 | UI整備 | 未着手 |
| 7 | セッション管理＋エクスポート | 未着手 |
| 8 | 実戦投入＋耐久 | 未着手 |

## ローカルでの読み込み方法

1. Chrome で `chrome://extensions/` を開く
2. 右上の「デベロッパー モード」をON
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. このリポジトリのルートフォルダを選択

## ファイル構成（Phase 0 時点）

```
.
├── manifest.json         Chrome拡張の設計図 (Manifest V3)
├── background.js         Service Worker（裏方スクリプト）
├── side_panel.html       サイドパネルUI（議論UIの予定地）
├── icons/                ツールバー用アイコン (16/48/128)
├── content_scripts/      各AIサイトに注入するスクリプト
│   ├── claude.js
│   ├── chatgpt.js
│   └── gemini.js
└── docs/                 仕様書・ロードマップ
```

## ライセンス

未定（個人利用想定）
