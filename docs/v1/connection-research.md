# 接続経路の調査（公式資料・2026-10-25 時点）

Roundtable v1 で、各社のAIを会議参加者としてつなぐ経路を、公式資料で確認した結果です。
**ここに書いたのは「資料に何と書いてあるか」です。実機で動くかどうかは、[verification.md](verification.md) の実機試験で確かめます。**

確度の表記:
- **明記**：公式資料に書かれている
- **推定**：資料から推論した
- **不明**：資料に記載がない
- **［抜粋］**：本文を取得できず、検索結果の抜粋でしか確認できていない（help.openai.com は自動取得に 403 を返すため）

区別して記録している点が2つあります。
- **読書き**：会議室を読み、自分の発言を投稿できるか
- **再発言**：自分の処理が終わった後に次の番が来たとき、人が転記・送信しなくても再び動き出せるか

---

## Claude（claude.ai Web／デスクトップアプリ）

| 項目 | 結果 | 確度 | 出典 |
|---|---|---|---|
| カスタムコネクタ（リモートMCP） | Free（1件まで）／Pro／Max／Team／Enterprise で追加できる。個人は Customize → Connectors → ＋ → Add custom connector | 明記 | https://support.claude.com/en/articles/11175166 |
| 通信方式 | Streamable HTTP（旧 HTTP+SSE も可）。認証なし（No sign-in）も既定で可 | 明記 | https://claude.com/docs/connectors/building/index.md ・ https://claude.com/docs/connectors/building/authentication.md |
| 到達性 | MCPサーバーは Anthropic のIP帯域から公開インターネット経由で届く必要がある（ローカルならトンネルが要る） | 明記 | https://claude.com/docs/connectors/building/index.md ・ https://claude.com/docs/connectors/building/testing.md |
| ツール呼び出しの時間上限 | 1回 240 秒 | 明記 | https://claude.com/docs/connectors/building/index.md |
| 1ターンのツール呼び出し回数 | 公式の上限記載なし（非公式報告では約20回で「Continue」） | 不明 | — |
| 書込みの確認 | ツールごとに「常に許可／承認が必要／ブロック」を設定できる。読取専用ツールは確認なしで動ける。破壊的なツールは常に確認が出る。新しい Auto モードでは、書込みツールの実行可否を Claude が判断し、安全確認が入る | 明記 | https://claude.com/docs/connectors/getting-started.md ・ https://claude.com/docs/connectors/building/review-criteria.md ・ https://support.claude.com/en/articles/16761823 |
| **再発言：MCP Apps の `ui/message`** | MCP Apps は claude.ai／デスクトップ／モバイルで対応。アプリは会話へメッセージを送れる。ただし仕様は「ホストは利用者の同意を求めてよい」。claude.ai が同意を求めるか、クリック操作を要求するか、回数制限があるかは記載なし | 対応は明記・挙動は不明 | https://claude.com/blog/interactive-tools-in-claude ・ ext-apps 仕様 `specification/2026-01-26/apps.mdx` |
| パネル（ウィジェット）の生存 | 古いウィジェットは自動で外れない（複数インスタンスが残る）。開き直した会話では、スクロールで表示されたときに読み込まれる | 明記 | https://claude.com/docs/connectors/building/mcp-apps/instance-supersession.md |
| 再発言：外部イベントで claude.ai のチャットを起こす公式手段 | なし（スケジュールタスクは毎回新しいセッション） | 明記（記載なし） | https://support.claude.com/en/articles/13854387 |
| Project／Memory | Team/Enterprise ではコネクタはプライベートProjectのみ。Memory はチャット単位でオフにできる。Project ごとに記憶が分かれる | 明記 | https://support.claude.com/en/articles/11176164 ・ https://support.claude.com/en/articles/11817273 |
| 自動アクセスの規約 | 「APIキー経由または明示的に許可された場合を除き、ボットやスクリプト等の自動・非人間的な手段でサービスにアクセスしない」 | 明記 | https://www.anthropic.com/legal/consumer-terms §3 |

**結論（資料上）**：読書きはカスタムコネクタで可能です。再発言の候補は2つあり、どちらも実機確認が必要です。
1. 稼働中のタスク内で `wait_for_my_turn` を繰り返し呼んで待機する（1回最大240秒。回数上限は不明）
2. タスク終了後に、パネル（MCP App）の `ui/message` で次のターンを起こす（同意やクリックが必要かは不明）

## ChatGPT（chatgpt.com／デスクトップアプリ）

| 項目 | 結果 | 確度 | 出典 |
|---|---|---|---|
| カスタムMCPサーバー | chatgpt.com/plugins → ＋ → Add custom MCP server → Server URL → 認証（OAuth／No authentication）→ プラグインとして作成・インストール。読取・書込ツールの両方に対応 | 明記 | https://developers.openai.com/api/docs/guides/custom-mcp-server |
| 対象プラン | 「Developer mode を不要にした」とのスタッフ投稿あり（2026-10-01）。一方、ヘルプには「Pro は read/fetch のみ」とも書かれており、Plus/Pro で書込ツールが使えるかは確認できていない | 矛盾あり・**要実機確認** | https://community.openai.com/t/developer-mode-missing-from-security-login-on-chatgpt-pro/1402157 ・ https://help.openai.com/en/articles/12584461 ［抜粋］ |
| 書込みの確認 | 書込みは既定で確認が出る。同じ会話内では記憶されるが、新しい会話では再度確認が出る。2026-06-12 から「常に／変更前／重要な変更の前だけ」確認するかを設定できる | 明記 | 上記 custom-mcp-server ・ https://developers.openai.com/plugins/changelog |
| **再発言：MCP Events** | ChatGPT が MCP サーバーのイベントを購読し、届いたイベントを「購読したチャット」で受けて、利用者の指示どおり処理する。**Work チャット（Web、またはデスクトップで Cloud を選択）と dots で利用可。** MCP 2.0（プロトコル `2026-07-28`）が必要。配送は Webhook のみ（Standard Webhooks 署名） | 明記 | https://developers.openai.com/plugins/build/mcp-events |
| MCP Events の回数制限 | MCP Events 自体には記載なし。イベント起動タスクは「1時間30回・1日720回」との記載あり（MCP Events に適用されるかは不明） | 不明 ［抜粋］ | https://help.openai.com/en/articles/10291617 |
| 再発言：ウィジェットの `sendFollowUpMessage`／`ui/message` | API は存在する。ただし「ユーザー操作の直後でないと呼べない」との開発者報告が複数あり、公式の明記はない | 推定（不可の可能性が高い） | https://developers.openai.com/plugins/build/chatgpt-ui ・ https://community.openai.com/t/1372062 |
| ツール呼び出しの時間上限 | Web版の公式記載なし（報告では約60秒）。OpenAI 公式トンネルは120秒、デスクトップ（Codex系）の既定は60秒 | 不明 | https://developers.openai.com/api/docs/guides/secure-mcp-tunnels ・ https://learn.chatgpt.com/docs/extend/mcp |
| Work とモデル | Work は Free〜Enterprise に含まれ、「Web 版 Work」は Plus 以上。Work で使えるモデルは画面のモデル選択に従う | 明記 | https://learn.chatgpt.com/docs/get-started-with-work ・ https://learn.chatgpt.com/docs/pricing |
| Memory／Project | Work は利用者の Memory 設定を使う。「Project 専用メモリーの Project では Work を使えない」 | 明記／［抜粋］ | https://learn.chatgpt.com/docs/customization/memories |
| 自動アクセスの規約 | 「データや出力を自動的・プログラム的に抽出しない」「レート制限や保護策を回避しない」 | ［抜粋］ | https://openai.com/policies/terms-of-use/ |

**結論（資料上）**：読書きはカスタムMCPで可能です。再発言の本命は **Work チャット＋MCP Events** です。補助として、タスク内での待機も候補にします。書込みの確認がどこまで省けるか、Plus/Pro で書込みツールが使えるかは、実機で確かめます。

## Gemini（gemini.google.com）

| 項目 | 結果 | 確度 | 出典 |
|---|---|---|---|
| カスタムMCP（Custom apps） | 設定 → Connected Apps → Custom apps → MCP サーバーURLを追加。**条件：18歳以上・米国・個人アカウント・英語のみ・Keep Activity オン** | 明記 | https://support.google.com/gemini/answer/17209137 |
| 書込みの確認 | **「現在、Gemini は書込み操作に必ず手動の確認を求める」** | 明記 | 同上 |
| Tasks（旧 Gemini Agent）のブラウザ操作 | Google AI Pro/Ultra、18歳以上、個人アカウント、Personal Intelligence に参加、EEA・英国・スイス・ナイジェリアは対象外。端末の Chrome かクラウドのブラウザで動く | 明記 | https://support.google.com/gemini/answer/17094507 ・ https://support.google.com/gemini/answer/18766567 |
| フォーム送信の確認 | 「Webフォームの入力・送信」の前に確認する。「常に許可」にしても組み込みの安全確認は働く | 明記 | 同上 |
| タスク内で数分待機して再確認 | 記載なし | 不明 | — |
| 再発言：外部イベント | スケジュール（最短1時間ごと）と Gmail フィルタでの起動のみ | 明記 | https://support.google.com/gemini/answer/17094710 |
| Chrome の auto browse | 米国・英語・Pro は1日20回まで。フォーム送信前に確認する | 明記 | https://support.google.com/chrome/answer/16821166 |
| 自動アクセスの規約 | robots.txt に反する自動アクセスや、保護策の回避を禁止。gemini.google.com/robots.txt は `/app/` を Disallow | 明記 | https://policies.google.com/terms ・ https://gemini.google.com/robots.txt |

**結論（資料上）**：日本の個人アカウントでは Custom apps（MCP）の条件を満たさない可能性が高いです。残る経路は **Tasks のブラウザで参加者ページを読み書きする方式**ですが、送信のたびに確認が入ることが資料に明記されています。つまり、1発言ごとに本人の承認クリックが要る見込みです（転記ではありませんが、本人操作です）。再発言（数分待って再確認する）が同じタスク内でできるかは記載がなく、実機で確かめる必要があります。

---

## 採らなかった方法と理由

| 方法 | 採らない理由 |
|---|---|
| 各社のWeb画面をDOM操作で動かす（旧 Chrome 拡張） | 自動アクセスの規約（上表）に抵触するおそれがあります。旧コードは bot 検知を入力の揺らぎで回避しており、要件の「制限回避の禁止」に反します。毎回「了解」と返させ、全履歴を再投入する点も要件に反します |
| 書込みを読取専用ツールとして申告し、確認を避ける | 確認の仕組みを欺くことになり、制限回避にあたります。`post_message` は書込み（非破壊・冪等）として正直に申告しています |
| 参加者ページの送信を、フォーム以外の仕組み（リンク遷移など）に偽装する | 同上（Gemini の送信前確認を回避することになる） |
| 各社の推論API、Claude Code／Codex などの開発CLIを参加者にする | 依頼の必須要件で禁止 |
| OpenAI Secure MCP Tunnel | OpenAI Platform（API組織）のアカウントとトンネルIDが必要なため、v1 では汎用トンネル（cloudflared など）を使います |
