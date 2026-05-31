// content_scripts/claude.js — claude.ai 用 Content Script
// ============================================================
// Phase 1 Step 1A:
//   - 入力欄を発見（セレクタ fallback チェーン）
//   - TipTap/ProseMirror に対し 3 手段でテキスト注入
//       1. beforeinput InputEvent を 1 文字ずつ（30–90ms 揺らぎ）
//       2. ClipboardEvent('paste') で一括
//       3. document.execCommand('insertText', false, text)
//   - 200–600ms ランダム待機後、送信ボタンに pointerdown→pointerup→click
//   - 事前/事後に Cloudflare 検証画面の出現をガード（保守的）
//   - 経過は console + サイドパネルログの両方に流す
// ============================================================

// 二重ロードガード — 静的 content_script と background のプログラム注入が
// 両方走った場合でも listener が二重登録されないようにする。
if (window.__roundtableClaudeLoaded__) {
  console.log(
    "[Roundtable] claude.js は既にロード済み。再初期化をスキップ。",
  );
  // background 側からの ping/inject 後の状態通知用に「既にロード済み」を返せるよう、
  // listener 自体は1回登録済みなので何もしない。
} else {
  window.__roundtableClaudeLoaded__ = true;
  initClaudeContentScript();
}

function initClaudeContentScript() {

console.log("[Roundtable] claude.js loaded on", window.location.href);

// ============================================================
// セレクタ優先順位の原則 (Phase 2 A2)
// ------------------------------------------------------------
// 各セレクタチェーンは以下の優先順位で並べる:
//   1. aria-label    — i18n に強く、UI 改修でも残りやすい
//   2. data-testid / data-* — 開発者が意図的に付与、最も安定
//   3. role 属性     — ARIA 標準で意味論的に安定
//   4. tag + 必須属性 — contenteditable など仕様レベルの属性
//   5. class 名     — 最後の手段。リファクタで頻繁に変わる
// claude.ai では現状 data-testid が少ないため、aria-label と role を
// 第一線に置く。class ベースの判定は最終フォールバックに限定する。
// ============================================================

const INPUT_SELECTORS = [
  '[data-testid="chat-input"]',
  'div[contenteditable="true"][role="textbox"]',
  'div.ProseMirror[contenteditable="true"]',
];

const SUBMIT_SELECTORS = [
  'button[aria-label="メッセージを送信"]',
  'button[aria-label="Send Message"]',
  'button[aria-label="Send message"]',
];

// Cloudflare Turnstile / Challenge 系の要素。保守的に多めに列挙。
const CLOUDFLARE_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="cloudflare"]',
  'iframe[title*="Cloudflare"]',
  "div.cf-turnstile",
  'div[class*="cf-turnstile"]',
  "div#cf-wrapper",
  "div#cf-content",
  "div#challenge-form",
  "div#challenge-stage",
  'div[id^="cf-challenge"]',
];

const CLOUDFLARE_TITLE_PATTERNS = [
  "Just a moment",
  "Cloudflare",
  "確認中",
  "あなたが人間",
];

function rand(min, max) {
  return min + Math.random() * (max - min);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logPanel(level, message) {
  chrome.runtime
    .sendMessage({ type: "log", level, message, timestamp: Date.now() })
    .catch(() => {});
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  fn(`[Roundtable][${level}]`, message);
}

function findFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return { element: el, selector: sel };
  }
  return null;
}

function findSubmitFallback() {
  const inputResult = findFirst(INPUT_SELECTORS);
  if (!inputResult) return null;
  let container = inputResult.element;
  for (let depth = 0; depth < 6 && container; depth++) {
    const buttons = container.querySelectorAll('button[type="button"]');
    for (const btn of buttons) {
      if (!btn.querySelector("svg")) continue;
      // Phase 2 A4 fix: 停止ボタンを誤クリックしないよう、aria-label に停止系
      // 文字列を含むボタンはスキップ。応答中フェーズでは「送信ボタン」が
      // 消滅して「応答を停止」が同じ位置・同じ構造で表示されるため、
      // 単純な SVG ボタン探索だと停止ボタンを誤取得してしまう。
      const ariaLabel = btn.getAttribute("aria-label") || "";
      if (STOP_BUTTON_ARIA_LABELS.some((l) => ariaLabel.includes(l))) {
        continue;
      }
      return { element: btn, selector: "fallback:nearest-button-with-svg" };
    }
    container = container.parentElement;
  }
  return null;
}

function detectCloudflare() {
  for (const sel of CLOUDFLARE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return { detected: true, by: `selector:${sel}` };
  }
  const title = document.title || "";
  for (const pat of CLOUDFLARE_TITLE_PATTERNS) {
    if (title.includes(pat)) {
      return { detected: true, by: `title:"${pat}"` };
    }
  }
  return { detected: false };
}

function getInputText(input) {
  // 不可視文字 (U+200B〜U+200D, U+FEFF) を除去してから比較する。
  // ProseMirror が空ノードのプレースホルダなどに入れることがあるため。
  return (input.innerText || input.textContent || "").replace(/[​-‍﻿]/g, "");
}

// Phase 3a fix5: 注入成否の検証専用の正規化。
//   ProseMirror 系エディタは改行 \n を段落化するため、注入した
//   "一行目\n二行目" がエディタ上では <p>一行目</p><p>二行目</p> となり、
//   innerText は "一行目\n\n二行目"（二重 \n）になる。素の
//   `.includes(text)` だと改行数の差で一致せず「注入失敗」と誤判定する。
//   改行ランを 1 つに畳んで比較することで、改行を含むメッセージでも
//   正しく「注入成功」と判定する。単行（\n 無し）には影響しない no-op。
//   claude.js / chatgpt.js に同型で適用（Phase 3b 完了後の共通化で 1 箇所に）。
function normalizeForInjectCheck(s) {
  return (s || "").replace(/\r\n?/g, "\n").replace(/\n+/g, "\n").trim();
}
function injectionTextLanded(actual, expected) {
  return normalizeForInjectCheck(actual).includes(
    normalizeForInjectCheck(expected),
  );
}

async function injectViaBeforeInput(input, text) {
  input.focus();
  await sleep(40);
  for (const ch of text) {
    const evt = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: ch,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(evt);
    await sleep(rand(30, 90));
  }
  await sleep(120);
  return injectionTextLanded(getInputText(input), text);
}

async function injectViaPaste(input, text) {
  input.focus();
  await sleep(40);
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const evt = new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(evt);
  await sleep(150);
  return injectionTextLanded(getInputText(input), text);
}

async function injectViaExecCommand(input, text) {
  input.focus();
  await sleep(40);
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, text);
  } catch (_e) {
    ok = false;
  }
  await sleep(150);
  return ok && injectionTextLanded(getInputText(input), text);
}

const INJECT_METHODS = [
  { name: "beforeinput-per-char", fn: injectViaBeforeInput },
  { name: "clipboard-paste", fn: injectViaPaste },
  { name: "execCommand-insertText", fn: injectViaExecCommand },
];

async function clickSubmit(button) {
  const rect = button.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const baseOpts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  const pointerOpts = {
    ...baseOpts,
    buttons: 1,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
  };
  try {
    button.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  } catch (_e) {
    button.dispatchEvent(new MouseEvent("mousedown", baseOpts));
  }
  await sleep(rand(20, 60));
  try {
    button.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  } catch (_e) {
    button.dispatchEvent(new MouseEvent("mouseup", baseOpts));
  }
  await sleep(rand(10, 30));
  button.dispatchEvent(new MouseEvent("click", baseOpts));
}

// ============================================================
// 応答完了検知 + 応答テキスト抽出 (Step 1B 後半)
//   - 停止ボタン: button[aria-label="応答を停止"]  （DOMロガー採取で確定）
//   - 応答ブロック: data-testid="assistant-message" を第1候補に
//     2 段のフォールバック付きで抽出
// ============================================================

// Phase 2 A2: 停止ボタンの aria-label を配列化。
// 日本語版 ('応答を停止') は Phase 1 で実機確認済み。英語版の正確な値は
// 未確定のため候補を複数並べる。Phase 3 で英語 UI を DOM ロガーで採取して確定。
//
// Phase 2 A4 fix: ラベル配列と selector 配列を分離 (DRY)。
// findSubmitFallback の安全装置（停止ボタン誤検出回避）でラベル側を再利用する。
const STOP_BUTTON_ARIA_LABELS = [
  "応答を停止",
  "Stop response",
  "Stop",
  "停止",
];
const STOP_BUTTON_SELECTORS = STOP_BUTTON_ARIA_LABELS.map(
  (l) => `button[aria-label="${l}"]`,
);

function findStopButton() {
  for (const sel of STOP_BUTTON_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return { element: el, selector: sel };
  }
  return null;
}

// Phase 2 A3: Thinking バッジ候補。
// Claude の extended thinking 中に表示される要素の aria-label / data-testid を
// 既知パターンとして並べる。1 つも当たらない場合は Phase 3 で DOM ロガー再採取して確定。
// Thinking 検知は無音タイムアウトの「補助機能」: テキスト変化検知が主で、
// テキスト変化が無い長考のみを救う役割。取れなくても致命的ではない。
const THINKING_INDICATOR_SELECTORS = [
  '[aria-label*="思考"]',
  '[aria-label*="考え"]',
  '[aria-label*="Thinking"]',
  '[aria-label*="Reasoning"]',
  '[data-testid*="thinking"]',
  '[data-testid*="reasoning"]',
];

function findThinkingIndicator() {
  for (const sel of THINKING_INDICATOR_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return { element: el, selector: sel };
  }
  return null;
}

// Phase 2 A3:
//   - settings.silence_timeout_sec: 無音タイムアウト（秒）。デフォルト 30 秒
//   - settings.backstop_timeout_ms: 真の最大時間（仕様書§10 の精神から外れるが
//     最終バックストップとして残す）。デフォルト 600,000ms = 10 分
//   仕様書§10 は「単純な時間タイムアウトはかけない、無音タイムアウト方式」を明記。
//   実装上は (a) 無音タイムアウト = 一次防衛、(b) バックストップ = 異常時の安全弁
//   の二段構えとする。
async function waitForResponseComplete(settings = {}) {
  const silenceTimeoutSec =
    typeof settings.silence_timeout_sec === "number" &&
    settings.silence_timeout_sec >= 1
      ? settings.silence_timeout_sec
      : 30;
  const SILENCE_TIMEOUT_MS = silenceTimeoutSec * 1000;
  const BACKSTOP_TIMEOUT_MS =
    typeof settings.backstop_timeout_ms === "number" &&
    settings.backstop_timeout_ms >= SILENCE_TIMEOUT_MS
      ? settings.backstop_timeout_ms
      : 600000;

  // 1) 停止ボタン出現を待つ（送信→応答開始）
  const appearStart = Date.now();
  let firstHit = null;
  while (!(firstHit = findStopButton())) {
    if (Date.now() - appearStart > 10000) {
      return {
        ok: false,
        error:
          "停止ボタンが10秒以内に出現しませんでした。応答開始失敗の可能性。",
      };
    }
    await sleep(150);
  }
  logPanel("info", `[Wait] 停止ボタン出現 → 応答中 (selector=${firstHit.selector})`);
  logPanel(
    "info",
    `[A3] 無音タイムアウト=${silenceTimeoutSec}秒、バックストップ=${Math.round(BACKSTOP_TIMEOUT_MS / 1000)}秒`,
  );

  // 2) 停止ボタン消滅を待つ + 無音タイムアウト判定（A3）
  //    各ポーリングで以下を観察し、活動があれば lastActivityAt を更新:
  //    - 抽出対象テキストの変化
  //    - Thinking バッジの表示
  //    無音 = 上記いずれも無いまま SILENCE_TIMEOUT_MS 経過。
  const startWait = Date.now();
  let lastHeartbeat = startWait;
  let lastActivityAt = startWait;
  let lastObservedText = extractLatestAssistantMessage().text || "";
  let lastThinkingLogAt = 0;
  let thinkingHitCount = 0;
  while (findStopButton()) {
    const now = Date.now();
    const elapsed = now - startWait;

    // バックストップ（真の最大時間）
    if (elapsed > BACKSTOP_TIMEOUT_MS) {
      return {
        ok: false,
        error: `応答完了タイムアウト（バックストップ ${Math.round(BACKSTOP_TIMEOUT_MS / 1000)}秒 経過）`,
        backstop: true,
      };
    }

    // テキスト変化検知
    const curText = extractLatestAssistantMessage().text || "";
    if (curText !== lastObservedText) {
      lastObservedText = curText;
      lastActivityAt = now;
    }

    // Thinking バッジ検知（テキスト変化が無い長考を救う補助）
    const thinking = findThinkingIndicator();
    if (thinking) {
      lastActivityAt = now;
      thinkingHitCount++;
      if (now - lastThinkingLogAt >= 10000) {
        lastThinkingLogAt = now;
        logPanel(
          "info",
          `[A3] Thinking バッジ検出 (selector=${thinking.selector})、無音タイムアウトをリセット`,
        );
      }
    }

    // 無音タイムアウト判定（A3 一次防衛）
    const silenceMs = now - lastActivityAt;
    if (silenceMs > SILENCE_TIMEOUT_MS) {
      return {
        ok: false,
        error: `無音タイムアウト (${silenceTimeoutSec}秒 活動なし)。再試行 / スキップ / 中断を選んでください。`,
        silenceTimeout: true,
        thinkingHitCount,
      };
    }

    // 10秒ごとに進捗ログ
    if (now - lastHeartbeat >= 10000) {
      lastHeartbeat = now;
      logPanel(
        "info",
        `[Wait] 応答中... ${Math.round(elapsed / 1000)}秒経過 (無音 ${Math.round(silenceMs / 1000)}秒, Thinking ${thinkingHitCount}回)`,
      );
    }
    await sleep(300);
  }

  // 3) 消滅の安定化（瞬間的な再出現の保険）
  await sleep(500);
  if (findStopButton()) {
    logPanel("warn", "[Wait] 停止ボタンが再出現。応答継続として待機を再開。");
    return await waitForResponseComplete(settings);
  }
  logPanel("info", "[A1] 停止ボタン消滅 → テキスト安定化を確認中...");

  // 4) [Phase 2 A1] テキスト安定化判定（二重判定の後半）
  //    停止ボタン消滅後も aria-live の途中スナップショット残留などで
  //    DOM 更新が続くケースがあるため、抽出対象テキストが連続 2500ms
  //    変化なしを確認してから「応答完了」と確定する。
  //    最大 10 秒待っても安定化しない場合は警告して現在値で確定。
  const STABLE_THRESHOLD_MS = 2500;
  const STABLE_POLL_MS = 200;
  const STABLE_MAX_WAIT_MS = 10000;

  const stableStartedAt = Date.now();
  let lastText = extractLatestAssistantMessage().text || "";
  let stableSince = Date.now();
  while (Date.now() - stableSince < STABLE_THRESHOLD_MS) {
    await sleep(STABLE_POLL_MS);
    const curText = extractLatestAssistantMessage().text || "";
    if (curText !== lastText) {
      lastText = curText;
      stableSince = Date.now();
    }
    if (Date.now() - stableStartedAt > STABLE_MAX_WAIT_MS) {
      logPanel(
        "warn",
        `[A1] テキスト安定化判定が ${STABLE_MAX_WAIT_MS}ms で打ち切り。現在のテキストで確定。`,
      );
      break;
    }
  }
  logPanel(
    "ok",
    `[A1] 応答完了（テキスト安定化確認 OK、安定化所要 ${Date.now() - stableStartedAt}ms）`,
  );
  return { ok: true };
}

// innerText に混入する aria-live スクリーンリーダー用プレフィックス
const ASSISTANT_TEXT_PREFIXES = [
  /^Claudeが返答しました:\s*/,
  /^Claude responded:\s*/,
  /^Claude replied:\s*/,
  /^Assistant said:\s*/,
];

// 末尾のタイムスタンプ / アクションボタンラベル
const ASSISTANT_TEXT_SUFFIX_PATTERNS = [
  /\n\s*\d{1,2}:\d{2}\s*$/, // 末尾の HH:MM
  /\n\s*(Retry|再試行|Regenerate|再生成|Copy|コピー|Edit|編集|Give positive feedback|Give negative feedback|高評価|低評価|Bad response|Good response)\s*$/,
];

// Phase 2 A1+C1: 戻り値を { text, dedup, diagnostic } 形式に変更。
//   dedup が null なら重複検出は不発、オブジェクトなら発火。
//   diagnostic は不発時に長い段落が複数あった場合のみ非 null。
//   呼出側で発火状況をログ出力するために構造化情報を返す。
//
// Phase 2 A2+C3 fix:
//   - 比較専用の正規化（zero-width 文字除去）を追加
//   - 末尾マーカー（…/句読点/閉じカッコ等）を剥がしたうえで prefix 比較
//     → aria-live の途中スナップショットが「…」等の末尾マーカーで終わる
//        ケースを捕捉する
//   - 出力本文 (kept) はマーカー除去前のオリジナルを採用するので破壊なし
function cleanAssistantText(raw) {
  if (!raw) return { text: "", dedup: null, diagnostic: null };
  let text = raw.trim();

  // プレフィックス除去
  for (const pat of ASSISTANT_TEXT_PREFIXES) {
    text = text.replace(pat, "");
  }

  // 重複検出: aria-live が同じ本文を二重 render しているケース
  // Phase 2: 完全一致 + prefix 一致 + 末尾マーカー除去後の prefix 一致を検出
  let dedup = null;
  let diagnostic = null;
  const parts = text
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const norm0 = normalizeForCompare(parts[0]);
    const norm1 = normalizeForCompare(parts[1]);
    let keepIdx = null; // 0 or 1: 採用する段落の index
    let dedupKind = null;
    let prefixIdx = null; // 0 or 1: prefix だった段落の index（prefix のみ）

    if (norm0 === norm1) {
      keepIdx = 0;
      dedupKind = "exact";
    } else if (norm1.startsWith(norm0)) {
      keepIdx = 1;
      dedupKind = "prefix";
      prefixIdx = 0;
    } else if (norm0.startsWith(norm1)) {
      keepIdx = 0;
      dedupKind = "prefix";
      prefixIdx = 1;
    } else {
      // 末尾マーカーを剥がして再比較。
      // 「途中版に末尾「…」が付き、完全版にはそれが無い」ケースを救う。
      const trim0 = trimTrailingDedupMarkers(norm0);
      const trim1 = trimTrailingDedupMarkers(norm1);
      if (trim0.length > 0 && trim1.length > 0) {
        if (trim0 === trim1) {
          // 末尾マーカーが違うだけ → 長い方（より完成形）を採用
          keepIdx = norm0.length >= norm1.length ? 0 : 1;
          dedupKind = "exact";
        } else if (norm1.startsWith(trim0)) {
          keepIdx = 1;
          dedupKind = "prefix";
          prefixIdx = 0;
        } else if (norm0.startsWith(trim1)) {
          keepIdx = 0;
          dedupKind = "prefix";
          prefixIdx = 1;
        }
      }
    }

    if (keepIdx !== null) {
      const kept = parts[keepIdx];
      const dropped = parts[keepIdx === 0 ? 1 : 0];
      text =
        kept +
        (parts.length > 2 ? "\n\n" + parts.slice(2).join("\n\n") : "");
      dedup = {
        kind: dedupKind,
        prefix_idx: prefixIdx,
        kept_length: kept.length,
        dropped_length: dropped.length,
      };
    } else if (parts[0].length >= 30 && parts[1].length >= 30) {
      // Y 不発だが両方が substantial → 取り損ねパターン解析用に診断情報
      diagnostic = {
        num_parts: parts.length,
        part_lengths: parts.slice(0, 4).map((p) => p.length),
        part_heads: parts.slice(0, 2).map((p) => p.slice(0, 60)),
      };
    }
  }

  // 末尾の時刻 + アクションラベルが連続するパターンに対応するためループで剥がす
  let changed = true;
  while (changed) {
    changed = false;
    for (const pat of ASSISTANT_TEXT_SUFFIX_PATTERNS) {
      const newText = text.replace(pat, "").trim();
      if (newText !== text) {
        text = newText;
        changed = true;
      }
    }
  }

  return { text: text.trim(), dedup, diagnostic };
}

// Phase 2 A2+C3 fix: 比較専用の正規化ヘルパ。出力本文には影響しない。
//   - zero-width 文字 (U+200B〜U+200D, U+FEFF) を除去
//   - whitespace を 1 個のスペースに圧縮
function normalizeForCompare(s) {
  return s
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Phase 2 A2+C3 fix: 末尾マーカーを剥がす（比較専用）。
//   aria-live の途中スナップショットは文の途中で止まるため、末尾に
//   「…」「...」「。」「、」「！」「？」「．」「」」「』」「）」「)」「"」「'」、
//   ホワイトスペースが付くケースが多い。これらを剥がして prefix 比較する。
//   出力本文 (kept) には影響しないので過剰削除のリスクは無い。
const TRAILING_DEDUP_TRIM_RE = /[…。．、！？\.\s」』）)"'…]+$/u;
function trimTrailingDedupMarkers(s) {
  return s.replace(TRAILING_DEDUP_TRIM_RE, "");
}

const ASSISTANT_RETRY_LABELS = ["Retry", "再試行", "Regenerate", "再生成"];
// 新戦略3（action-bar 祖先）で「本文を採れた」と見なす最小文字数。これ未満は
// ツールバーのアイコン由来ゴミ（2026-05-27 の depth=0,1字 事故）とみなして
// 不採用 → 失敗扱いに落とす（戦略4 → 最終 null → スナップショット保存を発火）。
// 実応答は通常これを大きく上回るので短文応答も壊さない。
const MIN_ASSISTANT_CHARS = 2;

function extractLatestAssistantMessage() {
  // Phase 2 C3: 抽出メタデータを構造化して返す。
  // 呼出側で W1〜W4 警告判定や将来の集計（連続テストモード）に使う。
  // - retry_hit_count: 全 aria-label 横断で見つかった Retry ボタン総数
  // - retry_aria_label_matched: 最初にヒットした Retry の aria-label
  // - retry_ancestor_depth: 旧戦略3 の depth（互換のため残置、新方式では未使用）
  // - action_bar_anchor: 新戦略3 が使ったアンカー種別（testid or aria-label）
  // - action_bar_hit_count: action-bar-* testid の総数（W4 のアンカー全滅判定用）
  // - assistant_turn_depth: 新戦略3 で採用した「応答ターン祖先」の depth
  const meta = {
    retry_hit_count: 0,
    retry_aria_label_matched: null,
    retry_ancestor_depth: null,
    action_bar_anchor: null,
    action_bar_hit_count: 0,
    assistant_turn_depth: null,
  };
  for (const label of ASSISTANT_RETRY_LABELS) {
    const cnt = document.querySelectorAll(
      `button[aria-label="${label}"]`,
    ).length;
    if (cnt > 0) {
      meta.retry_hit_count += cnt;
      if (meta.retry_aria_label_matched === null) {
        meta.retry_aria_label_matched = label;
      }
    }
  }

  // 戦略1: [data-testid="assistant-message"] — 将来 claude.ai が追加するかもしれないので最優先で残す
  const byTestid = document.querySelectorAll(
    '[data-testid="assistant-message"]',
  );
  if (byTestid.length > 0) {
    const last = byTestid[byTestid.length - 1];
    const raw = last.innerText || "";
    const { text, dedup, diagnostic } = cleanAssistantText(raw);
    if (text) {
      return {
        text,
        selector: '[data-testid="assistant-message"]',
        raw_length: raw.length,
        dedup,
        diagnostic,
        extractionMeta: meta,
      };
    }
  }

  // 戦略2: [data-message-author-role="assistant"]
  const byAuthor = document.querySelectorAll(
    '[data-message-author-role="assistant"]',
  );
  if (byAuthor.length > 0) {
    const last = byAuthor[byAuthor.length - 1];
    const raw = last.innerText || "";
    const { text, dedup, diagnostic } = cleanAssistantText(raw);
    if (text) {
      return {
        text,
        selector: '[data-message-author-role="assistant"]',
        raw_length: raw.length,
        dedup,
        diagnostic,
        extractionMeta: meta,
      };
    }
  }

  // 戦略3: アクションバー（コピー/再試行）を起点に応答ターン全体を取る。
  //  2026-05-27 の claude.ai DOM 変更で、旧「Retry 祖先を上にたどり最初に
  //  1 字以上ある祖先」方式が depth=0 のツールバー（アイコンのみ、1 字）で
  //  誤打ち切りしていた（既知の課題#3 の現実化）。対策:
  //   (a) 起点を data-testid="action-bar-retry"/"action-bar-copy"（言語非依存で
  //       堅い）を最優先、無ければ従来の aria-label 再試行ボタンにフォールバック。
  //   (b) 「最初に 1 字以上」ではなく「user-message を含まない最高位の祖先」
  //       ＝応答ターン全体を採る。祖先は入れ子で innerText が単調増加するため
  //       これは実質「テキスト最大の祖先」。本文込みの親は必ずツールバー単体
  //       より文字数が多いので 1 字ゴミは自然に除外され、短文応答も壊さない
  //       （閾値マジックナンバー不要）。
  //   (c) 採用テキストが MIN_ASSISTANT_CHARS 未満なら本文未発見として不採用
  //       → 戦略4 / 最終 null へ落とす（スナップショット保存を発火＝副次バグ修正）。
  const actionBarRetry = document.querySelectorAll(
    '[data-testid="action-bar-retry"]',
  );
  const actionBarCopy = document.querySelectorAll(
    '[data-testid="action-bar-copy"]',
  );
  meta.action_bar_hit_count = actionBarRetry.length + actionBarCopy.length;

  let anchorEls = null;
  if (actionBarRetry.length > 0) {
    anchorEls = actionBarRetry;
    meta.action_bar_anchor = '[data-testid="action-bar-retry"]';
  } else if (actionBarCopy.length > 0) {
    anchorEls = actionBarCopy;
    meta.action_bar_anchor = '[data-testid="action-bar-copy"]';
  } else if (meta.retry_aria_label_matched) {
    anchorEls = document.querySelectorAll(
      `button[aria-label="${meta.retry_aria_label_matched}"]`,
    );
    meta.action_bar_anchor = `aria-label:${meta.retry_aria_label_matched}`;
  }

  if (anchorEls && anchorEls.length > 0) {
    const anchor = anchorEls[anchorEls.length - 1];
    // 起点から上へ、user-message を含まない最高位の祖先（応答ターン全体）を探す。
    let best = null;
    let bestDepth = -1;
    let cur = anchor;
    for (let depth = 0; cur && depth < 15; depth++) {
      if (cur.querySelector && cur.querySelector('[data-testid="user-message"]')) {
        break; // ここから上は user 発言を含む → 行き過ぎ
      }
      best = cur;
      bestDepth = depth;
      cur = cur.parentElement;
    }
    if (best) {
      // Phase 4 Step2b で発見: claude.ai が新ラベル（「ポジティブな
      // フィードバックを送る」「改善フィードバックを送る」「共有」等）の
      // <button> を応答ターン直下に追加しており、これらが innerText の
      // 末尾に混入していた。ASSISTANT_TEXT_SUFFIX_PATTERNS の維持ゲームを
      // 避けるため、構造的に <button> 子孫を除外したクローンの innerText を
      // 採用する。チャット応答本文は通常 <button> を含まないので副作用は
      // 実質ゼロ（ツール使用UI等で本文側 button を含む特殊ケースは
      // 既知の課題#4 として Phase 8 以降で再検討）。
      //
      // 重要: detached node の innerText は WHATWG 仕様上「レンダリングツリー
      // 外＝textContent と同等」になり、ブロック要素境界の \n が入らない。
      // dedup（段落分割前提の Y 検出、Phase 2 で「主役」と確立）が機能しなく
      // なる。そのため clone を画面外に一時 attach してから innerText を読み、
      // 即 remove する（off-screen position で視覚的副作用ゼロ、同期処理で
      // MutationObserver 副発火も実質無視可能）。
      const clone = best.cloneNode(true);
      clone.querySelectorAll("button").forEach((b) => b.remove());
      clone.style.cssText = "position:absolute;left:-9999px;top:0;";
      document.body.appendChild(clone);
      let raw = "";
      try {
        raw = clone.innerText || "";
      } finally {
        clone.remove();
      }
      const { text, dedup, diagnostic } = cleanAssistantText(raw);
      if (text && text.length >= MIN_ASSISTANT_CHARS) {
        meta.assistant_turn_depth = bestDepth;
        return {
          text,
          selector: `fallback:action-bar-ancestor-depth-${bestDepth}`,
          raw_length: raw.length,
          dedup,
          diagnostic,
          extractionMeta: meta,
        };
      }
    }
  }

  // 戦略4: 最後の user-message の次の兄弟要素を辿る（最終手段）
  const users = document.querySelectorAll('[data-testid="user-message"]');
  if (users.length > 0) {
    const lastUser = users[users.length - 1];
    const userContainer = lastUser.closest("div");
    const startNode = userContainer
      ? userContainer.parentElement &&
        userContainer.parentElement.nextElementSibling
      : null;
    let node = startNode;
    while (node) {
      if (!node.querySelector('[data-testid="user-message"]')) {
        const raw = node.innerText || "";
        const { text, dedup, diagnostic } = cleanAssistantText(raw);
        if (text.length >= 1) {
          return {
            text,
            selector: "fallback:after-last-user-message",
            raw_length: raw.length,
            dedup,
            diagnostic,
            extractionMeta: meta,
          };
        }
      }
      node = node.nextElementSibling;
    }
  }

  return {
    text: null,
    selector: null,
    raw_length: 0,
    dedup: null,
    diagnostic: null,
    extractionMeta: meta,
  };
}

// ============================================================
// 応答候補スナップショット (Step 1B fix#2)
//   - MutationObserver では Claude 応答コンテナの mount を捕捉できなかったため、
//     応答完了後に querySelectorAll で網羅的にダンプする方式に切替
//   - 4 戦略 (A〜D) の候補を返す。Kazuya とチャット側で本物のセレクタを確定する
// ============================================================

function dumpAttrs(el) {
  const out = {};
  for (const attr of el.attributes) {
    if (
      attr.name.startsWith("data-") ||
      attr.name === "id" ||
      attr.name === "role" ||
      attr.name === "aria-label"
    ) {
      out[attr.name] = (attr.value || "").slice(0, 80);
    }
  }
  return out;
}

function describeCandidate(el, extra = {}) {
  const text = (el.innerText || "").trim();
  return {
    tag: el.tagName.toLowerCase(),
    classes: ((el.className && el.className.toString()) || "").slice(0, 120),
    attrs: dumpAttrs(el),
    text_head: text.slice(0, 60),
    text_length: text.length,
    ...extra,
  };
}

const RETRY_ARIA_LABELS = ["Retry", "再試行", "再生成", "Regenerate"];
const RETRY_SELECTOR = RETRY_ARIA_LABELS.map(
  (l) => `button[aria-label="${l}"]`,
).join(", ");

const TESTID_PATTERNS_FOR_SNAPSHOT = [
  "assistant-message",
  "message-content",
  "chat-message",
  "response-message",
  "ai-message",
];

function snapshotAssistantCandidates() {
  const candidates = [];

  // 戦略A: 既知の data-testid パターン
  for (const pat of TESTID_PATTERNS_FOR_SNAPSHOT) {
    document.querySelectorAll(`[data-testid="${pat}"]`).forEach((el, idx) => {
      candidates.push({
        strategy: `testid:${pat}`,
        index: idx,
        ...describeCandidate(el),
      });
    });
  }

  // 戦略B: data-message-author-role 属性を持つ要素
  document.querySelectorAll("[data-message-author-role]").forEach((el, idx) => {
    candidates.push({
      strategy: "author-role-attr",
      index: idx,
      author_role: el.getAttribute("data-message-author-role"),
      ...describeCandidate(el),
    });
  });

  // 戦略C: user-message から親階層を遡って同階層の div 兄弟を見る
  const userMsgs = document.querySelectorAll('[data-testid="user-message"]');
  if (userMsgs.length > 0) {
    const lastUser = userMsgs[userMsgs.length - 1];
    let cursor = lastUser;
    for (let depth = 0; depth < 6 && cursor; depth++) {
      cursor = cursor.parentElement;
      if (!cursor) break;
      Array.from(cursor.children).forEach((sib, sidx) => {
        if (sib.tagName !== "DIV") return;
        if (sib.querySelector('[data-testid="user-message"]')) return;
        const text = (sib.innerText || "").trim();
        if (text.length < 5) return;
        candidates.push({
          strategy: `sibling-at-depth-${depth}`,
          index: sidx,
          ...describeCandidate(sib),
        });
      });
    }
  }

  // 戦略D: Retry / 再試行 / 再生成 ボタンの祖先をたどる
  // Retry はユーザー発言にはなく Claude 応答に付くので、応答コンテナを特定しやすい
  document.querySelectorAll(RETRY_SELECTOR).forEach((btn, idx) => {
    let cur = btn.parentElement;
    for (let d = 0; d < 10 && cur; d++) {
      const text = (cur.innerText || "").trim();
      if (text.length >= 10) {
        candidates.push({
          strategy: `retry-ancestor-depth-${d}`,
          index: idx,
          retry_aria_label: btn.getAttribute("aria-label"),
          ...describeCandidate(cur),
        });
        break;
      }
      cur = cur.parentElement;
    }
  });

  return {
    captured_at: new Date().toISOString(),
    url: location.href,
    user_message_count: document.querySelectorAll(
      '[data-testid="user-message"]',
    ).length,
    retry_button_count: document.querySelectorAll(RETRY_SELECTOR).length,
    candidate_count: candidates.length,
    candidates,
  };
}

async function performSend(text, settings = {}) {
  if (!text || !text.trim()) {
    return { ok: false, error: "本文が空です。" };
  }

  // Phase 2 A4: 応答セッション中の AutoDomLogger を起動。
  // try-finally で確実に停止。エラー時は trigger 付きで save する。
  autoDomLogger.start();
  let autoLogSaved = false;
  try {

  // 0. 事前 Cloudflare チェック
  const preCf = detectCloudflare();
  if (preCf.detected) {
    const m = `[CF] Cloudflare検知（送信前）: ${preCf.by}。操作を中止します。`;
    logPanel("error", m);
    return { ok: false, error: m, cloudflare: true };
  }

  // 0.5 応答中チェック (busy state preflight) - Phase 2 A4 fix
  // 停止ボタンが存在 = claude.ai が応答中 = 送信不可。
  // この preflight を入れないと findSubmitFallback が停止ボタンを SVG button
  // として誤クリックし、Claude の応答を途中で止めてしまうデッドロックが発生する。
  // 直前の応答が「無音タイムアウト失敗」だが claude.ai 側ではまだ応答中
  // というケースで顕在化した（2026-05-16 検証）。
  const stopBtnExists = findStopButton();
  if (stopBtnExists) {
    const m = `claude.ai が応答中のため送信できません。応答完了を待つか、claude.ai タブで「応答を停止」を押してください。(detected: ${stopBtnExists.selector})`;
    logPanel("warn", `[Send] ${m}`);
    return { ok: false, error: m, busy: true };
  }

  // 1. 入力欄
  const inputResult = findFirst(INPUT_SELECTORS);
  if (!inputResult) {
    const m =
      "[Send] 入力欄が見つかりません（セレクタチェーン全滅）。claude.ai の画面が完全にロードされているか確認してください。";
    logPanel("error", m);
    return { ok: false, error: m };
  }
  logPanel("info", `[Send] 入力欄ヒット: ${inputResult.selector}`);

  // 2. 注入（3手段フォールバック）
  let usedInjectMethod = null;
  for (const method of INJECT_METHODS) {
    try {
      const ok = await method.fn(inputResult.element, text);
      if (ok) {
        usedInjectMethod = method.name;
        logPanel("ok", `[Inject] 注入成功: ${method.name}`);
        break;
      }
      logPanel("warn", `[Inject] 注入失敗（本文未反映）: ${method.name}`);
    } catch (e) {
      logPanel(
        "warn",
        `[Inject] 注入エラー (${method.name}): ${e && e.message ? e.message : e}`,
      );
    }
  }
  if (!usedInjectMethod) {
    const m = "[Inject] TipTap注入の3手段すべてに失敗しました。Kazuya に報告してください。";
    logPanel("error", m);
    return {
      ok: false,
      error: m,
      usedInputSelector: inputResult.selector,
    };
  }

  // 3. 送信前ランダム待機
  const preDelay = rand(200, 600);
  logPanel("info", `[Submit] 送信ボタン押下前の待機: ${Math.round(preDelay)}ms`);
  await sleep(preDelay);

  // 4. 送信ボタン
  let submitResult = findFirst(SUBMIT_SELECTORS);
  if (!submitResult) {
    const fb = findSubmitFallback();
    if (fb) {
      submitResult = fb;
      logPanel("info", `[Submit] 送信ボタン: フォールバック取得 (${fb.selector})`);
    }
  }
  if (!submitResult) {
    const m = "[Submit] 送信ボタンが見つかりません。";
    logPanel("error", m);
    return {
      ok: false,
      error: m,
      usedInputSelector: inputResult.selector,
      usedInjectMethod,
    };
  }
  if (submitResult.element.disabled) {
    logPanel(
      "warn",
      "[Submit] 送信ボタンが disabled。本文がエディタの内部状態に届いていない可能性。",
    );
  } else {
    logPanel("info", `[Submit] 送信ボタンヒット: ${submitResult.selector}`);
  }

  // 5. クリック (pointerdown -> pointerup -> click)
  await clickSubmit(submitResult.element);
  logPanel("info", "[Submit] 送信ボタン dispatch 完了 (pointerdown→pointerup→click)");

  // 6. 事後 Cloudflare チェック
  await sleep(800);
  const postCf = detectCloudflare();
  if (postCf.detected) {
    const m = `[CF] Cloudflare検知（送信後）: ${postCf.by}。Step 1A は中止して Kazuya に報告してください。`;
    logPanel("error", m);
    return {
      ok: false,
      error: m,
      cloudflare: true,
      usedInputSelector: inputResult.selector,
      usedInjectMethod,
      usedSubmitSelector: submitResult.selector,
    };
  }

  const baseResult = {
    ok: true,
    usedInputSelector: inputResult.selector,
    usedInjectMethod,
    usedSubmitSelector: submitResult.selector,
  };

  // 7. 応答完了待機
  logPanel("info", "[Wait] 応答完了を待機中...");
  const waitResult = await waitForResponseComplete(settings);
  if (!waitResult.ok) {
    // Phase 2 A4: 待機系エラーの trigger 分類
    let trigger = "wait_failed";
    if (waitResult.silenceTimeout) trigger = "silence_timeout";
    else if (waitResult.backstop) trigger = "backstop_timeout";
    else if (waitResult.error && waitResult.error.includes("停止ボタンが10秒")) {
      trigger = "stop_button_no_appear";
    }
    await autoDomLogger.save(trigger);
    autoLogSaved = true;
    logPanel("warn", waitResult.error);
    return { ...baseResult, responseError: waitResult.error };
  }

  // 7.5 安定化のために少し待ってからスナップショット採取
  // (応答完了直後は DOM が再レンダ中のことがあるため)
  await sleep(300);
  const snapshot = snapshotAssistantCandidates();

  // 8. 応答テキスト抽出
  const extracted = extractLatestAssistantMessage();
  if (!extracted.text) {
    const m =
      "[Extract] 応答テキストの抽出に失敗。セレクタ候補（assistant-message / data-message-author-role / fallback）全滅。スナップショットを採取して返します。";
    logPanel("warn", m);

    const snapshotKey = `assistant_snapshot_${Date.now()}`;
    try {
      await chrome.storage.local.set({ [snapshotKey]: snapshot });
      logPanel("info", `[Extract] スナップショット保存: ${snapshotKey}（候補 ${snapshot.candidate_count} 件）`);
    } catch (e) {
      logPanel(
        "warn",
        `[Extract] スナップショットの storage 保存に失敗: ${e && e.message ? e.message : e}`,
      );
    }

    // Phase 2 A4: T3 抽出失敗トリガー
    await autoDomLogger.save("extract_failed");
    autoLogSaved = true;

    return {
      ...baseResult,
      responseError: "応答テキスト抽出失敗",
      assistantSnapshot: snapshot,
      assistantSnapshotKey: snapshotKey,
      extractionMeta: extracted.extractionMeta,
    };
  }
  logPanel(
    "ok",
    `[Extract] 応答抽出成功 (selector=${extracted.selector}, ${extracted.text.length}字 / raw ${extracted.raw_length}字、スナップショット候補 ${snapshot.candidate_count} 件）`,
  );

  // Phase 2 C1: 重複検出 (Y) の発火状況をログ出力。
  // 2026-05-14 実機検証で「Y が主役、X は補助」が判明（aria-live と画面表示の二重 render は claude.ai の常時的な仕様）。
  // Y の発火頻度は将来 chatgpt.js / gemini.js の挙動比較や、X のチューニング判断材料になる。
  if (extracted.dedup) {
    if (extracted.dedup.kind === "prefix") {
      const prefixPara = extracted.dedup.prefix_idx + 1;
      const otherPara = prefixPara === 1 ? 2 : 1;
      logPanel(
        "warn",
        `[C1] ⚠ prefix 重複検出: 段落 ${prefixPara} が段落 ${otherPara} の prefix → 長い方 (${extracted.dedup.kept_length}字) を採用、短い方 (${extracted.dedup.dropped_length}字) を破棄`,
      );
    } else if (extracted.dedup.kind === "exact") {
      logPanel(
        "warn",
        `[C1] ⚠ 完全一致重複検出: 段落 1 と段落 2 が同一 → 統合 (${extracted.dedup.kept_length}字)`,
      );
    }
  } else {
    logPanel("info", "[C1] prefix 重複検出: 発火せず");
    // Phase 2 A2+C3 fix: 診断ログ。Y 不発だが長い段落が複数あった場合は
    // raw text の頭を出して、取り損ねパターンの解析材料にする。
    if (extracted.diagnostic) {
      const diag = extracted.diagnostic;
      logPanel(
        "info",
        `[C1:診断] 段落 ${diag.num_parts} 個、長さ [${diag.part_lengths.join(", ")}]字`,
      );
      logPanel(
        "info",
        `[C1:診断] 段落1 head: "${diag.part_heads[0]}..."`,
      );
      logPanel(
        "info",
        `[C1:診断] 段落2 head: "${diag.part_heads[1]}..."`,
      );
    }
  }

  // Phase 2 C3: 脆弱性検知の警告判定 (W1〜W4)。
  // 「自動修復より観測性」の方針に従い、警告ログのみ。深刻度でレベルを分ける。
  const meta = extracted.extractionMeta || {};
  const sel = extracted.selector || "";
  const firedWarnings = [];

  // W1: 戦略 1 または 2 が成功 → claude.ai に新属性が追加された可能性 (歓迎すべき変化, info)
  if (sel === '[data-testid="assistant-message"]') {
    firedWarnings.push("W1");
    logPanel(
      "info",
      "[C3:W1] ✨ claude.ai に [data-testid=\"assistant-message\"] 属性検出。戦略 1 が機能（DOM 改善）",
    );
  } else if (sel === '[data-message-author-role="assistant"]') {
    firedWarnings.push("W1");
    logPanel(
      "info",
      "[C3:W1] ✨ claude.ai に [data-message-author-role] 属性検出。戦略 2 が機能（DOM 改善）",
    );
  }

  // W2: 新戦略3（action-bar 祖先）使用時の観測ログ。2026-05-27 の DOM 変更で
  // 旧 depth 基準（depth=5 が常態）は無効化。新方式の常態 depth が固まるまでは
  // anchor と depth を info で可視化し、cap 近く（深すぎ）のときだけ warn。
  if (sel.startsWith("fallback:action-bar-ancestor-depth-")) {
    logPanel(
      "info",
      `[C3] 新戦略3 採用: anchor=${meta.action_bar_anchor}, depth=${meta.assistant_turn_depth}`,
    );
    if (meta.assistant_turn_depth !== null && meta.assistant_turn_depth >= 10) {
      firedWarnings.push("W2");
      logPanel(
        "warn",
        `[C3:W2] ⚠ 応答ターン祖先が深い (depth=${meta.assistant_turn_depth})。DOM 階層変化の兆候、要観察`,
      );
    }
  }

  // W3: 戦略 4 (最終手段) 到達 → DOM 構造変化の可能性大 (error)
  if (sel === "fallback:after-last-user-message") {
    firedWarnings.push("W3");
    logPanel(
      "error",
      "[C3:W3] 🚨 抽出が戦略 4 (最終手段) に到達。claude.ai DOM 構造変化の可能性大。要調査。",
    );
  }

  // W4: 抽出アンカー全滅（aria-label 再試行 も action-bar testid も 0）→ claude.ai が
  // 両方を改名した可能性 (error)。2026-05-27 以降は action-bar testid が主アンカーの
  // ため、aria-label だけ 0 でも testid があれば誤警報しないよう両者で判定する。
  if (meta.retry_hit_count === 0 && (meta.action_bar_hit_count || 0) === 0) {
    firedWarnings.push("W4");
    logPanel(
      "error",
      "[C3:W4] 🚨 抽出アンカー全滅（aria-label 再試行 / action-bar testid とも 0）。改名の可能性。DOM ロガーで再採取して ASSISTANT_RETRY_LABELS / action-bar セレクタを更新してください。",
    );
  }

  meta.warnings = firedWarnings;

  // Phase 2 A4: T4 W3/W4 警告トリガー（独立キーで保存して因果関係を保つ）
  if (firedWarnings.includes("W3")) {
    await autoDomLogger.save("warn_w3");
    autoLogSaved = true;
  }
  if (firedWarnings.includes("W4")) {
    await autoDomLogger.save("warn_w4");
    autoLogSaved = true;
  }

  return {
    ...baseResult,
    responseText: extracted.text,
    responseSelector: extracted.selector,
    responseRawLength: extracted.raw_length,
    responseDedup: extracted.dedup,
    extractionMeta: meta,
    snapshotCandidateCount: snapshot.candidate_count,
  };
  } finally {
    autoDomLogger.stop(autoLogSaved);
  }
}

// ============================================================
// DOM Logger (Step 1B 前半)
//   - MutationObserver で document.body subtree を 60 秒監視
//   - button / [role=button] と応答ブロック候補の added / removed を記録
//   - 結果は chrome.storage.local に dom_log_<timestamp> として保存
//   - 同時に runtime メッセージで「サイドパネル」にも送る
//   - サイドパネルが閉じていても採取は継続（content_script 内で完結）
// ============================================================

const DOM_LOG_DURATION_MS = 60000;
const DOM_LOG_MAX_EVENTS = 2000;
const DOM_LOG_COUNTDOWN_STEP_MS = 10000;
const DOM_LOG_TEXT_LIMIT = 40;

const DOM_LOG_CANDIDATE_SELECTOR = [
  "button",
  "[role='button']",
  "article",
  "[data-testid*='message']",
  "[data-message-author-role]",
  "div[class*='message']",
  "div[class*='Message']",
].join(",");

function classifyDomNode(node) {
  if (!(node instanceof Element)) return null;
  const tag = node.tagName.toLowerCase();
  if (tag === "button" || node.getAttribute("role") === "button") {
    return "button";
  }
  if (tag === "article") return "response:article";
  const dataTestid = node.getAttribute("data-testid");
  if (dataTestid && /message/i.test(dataTestid))
    return "response:data-testid-message";
  if (node.hasAttribute("data-message-author-role"))
    return "response:data-message-author-role";
  if (tag === "div") {
    const cls = node.getAttribute("class") || "";
    if (/message/i.test(cls)) return "response:class-message";
  }
  return null;
}

function snapshotDomNode(node, category, type, startTime) {
  const parent = node.parentElement;
  const text = (node.textContent || "").replace(/\s+/g, " ").trim();
  return {
    t_ms: Math.round(performance.now() - startTime),
    type, // "added" | "removed"
    category,
    tag: node.tagName.toLowerCase(),
    id: node.id || null,
    aria_label: node.getAttribute("aria-label") || null,
    data_testid: node.getAttribute("data-testid") || null,
    button_type: node.getAttribute("type") || null,
    role: node.getAttribute("role") || null,
    author_role: node.getAttribute("data-message-author-role") || null,
    class: (node.getAttribute("class") || "").slice(0, 120),
    text: text.slice(0, DOM_LOG_TEXT_LIMIT),
    text_truncated: text.length > DOM_LOG_TEXT_LIMIT,
    parent_tag: parent ? parent.tagName.toLowerCase() : null,
    parent_class: parent
      ? (parent.getAttribute("class") || "").slice(0, DOM_LOG_TEXT_LIMIT)
      : null,
  };
}

const domLogger = {
  running: false,
  startTime: 0,
  events: [],
  truncated: false,
  observer: null,
  countdownTimer: null,
  endTimer: null,

  _recordOne(node, type) {
    const cat = classifyDomNode(node);
    if (!cat) return;
    if (this.events.length >= DOM_LOG_MAX_EVENTS) {
      if (!this.truncated) {
        this.truncated = true;
        logPanel(
          "warn",
          `[DOM] 手動DOMロガー: イベント上限 ${DOM_LOG_MAX_EVENTS} 件に到達。以降は記録を打ち切ります。`,
        );
      }
      return;
    }
    this.events.push(snapshotDomNode(node, cat, type, this.startTime));
  },

  _recordSubtree(node, type) {
    if (!(node instanceof Element)) return;
    this._recordOne(node, type);
    if (typeof node.querySelectorAll !== "function") return;
    const matches = node.querySelectorAll(DOM_LOG_CANDIDATE_SELECTOR);
    for (const el of matches) this._recordOne(el, type);
  },

  start() {
    if (this.running) {
      return { ok: false, error: "DOMロガーは既に実行中です。" };
    }
    this.running = true;
    this.startTime = performance.now();
    this.events = [];
    this.truncated = false;

    this.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) this._recordSubtree(n, "added");
        for (const n of m.removedNodes) this._recordSubtree(n, "removed");
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });

    logPanel(
      "ok",
      `[DOM] 手動DOMロガー開始 (${DOM_LOG_DURATION_MS / 1000} 秒)。claude.ai タブで送信→応答を1往復してください。`,
    );

    let remaining = Math.floor(DOM_LOG_DURATION_MS / 1000);
    this.countdownTimer = setInterval(() => {
      remaining -= DOM_LOG_COUNTDOWN_STEP_MS / 1000;
      if (remaining > 0) {
        logPanel(
          "info",
          `[DOM] 手動DOMロガー実行中... 残り ${remaining} 秒（採取 ${this.events.length} 件）`,
        );
      }
    }, DOM_LOG_COUNTDOWN_STEP_MS);

    this.endTimer = setTimeout(() => {
      this.stop().catch((e) =>
        logPanel("error", `[DOM] 手動DOMロガー停止時エラー: ${e && e.message ? e.message : e}`),
      );
    }, DOM_LOG_DURATION_MS);

    return { ok: true, durationMs: DOM_LOG_DURATION_MS };
  },

  async stop() {
    if (!this.running) return null;
    this.running = false;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }

    const result = {
      captured_at: new Date().toISOString(),
      url: window.location.href,
      duration_ms: DOM_LOG_DURATION_MS,
      event_count: this.events.length,
      truncated: this.truncated,
      events: this.events,
    };
    const key = `dom_log_${Date.now()}`;
    try {
      await chrome.storage.local.set({ [key]: result });
      logPanel(
        "ok",
        `[DOM] 手動DOMロガー終了。chrome.storage.local["${key}"] に保存（${result.event_count} 件、truncated=${result.truncated}）`,
      );
    } catch (e) {
      logPanel(
        "error",
        `[DOM] 手動DOMロガー結果の storage 保存に失敗: ${e && e.message ? e.message : e}`,
      );
    }

    chrome.runtime
      .sendMessage({
        type: "dom_log_result",
        storage_key: key,
        result,
      })
      .catch(() => {});

    this.events = [];
    return { storage_key: key, result };
  },
};

// ============================================================
// Phase 2 A4: AutoDomLogger（応答セッション中のリングバッファ + エラー時自動保存）
// ------------------------------------------------------------
//   - performSend の入口で start、出口で stop
//   - 送信直後 1 秒は観察開始を遅延（送信時 DOM 変化のノイズ回避）
//   - 過去 60 秒分のイベントだけ保持（イベント数 2000 件で古い 10% を drop）
//   - エラートリガー検知時に save(trigger) で直近 60 秒を独立キーで保存
//   - 保存時に古い auto_dom_log_* キーを最大 10 件まで自動削除
//   - ストレージキー prefix は手動ロガー (dom_log_*) と分離
// ============================================================

const AUTO_LOG_WINDOW_MS = 60000;
const AUTO_LOG_MAX_EVENTS = 2000;
const AUTO_LOG_START_DELAY_MS = 1000;
const AUTO_LOG_MAX_STORED = 10;
const AUTO_LOG_KEY_PREFIX = "auto_dom_log_";

const autoDomLogger = {
  running: false,
  startTime: 0,
  startWallTime: 0,
  events: [],
  observer: null,
  delayedStartTimer: null,

  _recordOne(node, type) {
    if (!this.observer) return; // 遅延起動の前
    const cat = classifyDomNode(node);
    if (!cat) return;
    if (this.events.length >= AUTO_LOG_MAX_EVENTS) {
      // リング動作: 古い 10% を drop
      this.events.splice(0, Math.floor(AUTO_LOG_MAX_EVENTS * 0.1));
    }
    this.events.push(snapshotDomNode(node, cat, type, this.startTime));
  },

  _recordSubtree(node, type) {
    if (!(node instanceof Element)) return;
    this._recordOne(node, type);
    if (typeof node.querySelectorAll !== "function") return;
    const matches = node.querySelectorAll(DOM_LOG_CANDIDATE_SELECTOR);
    for (const el of matches) this._recordOne(el, type);
  },

  start() {
    if (this.running) return;
    this.running = true;
    this.startWallTime = Date.now();
    this.events = [];
    this.observer = null;
    logPanel(
      "info",
      `[AutoLog] 自動採取準備（${AUTO_LOG_START_DELAY_MS}ms 後に観察開始、ノイズ回避）`,
    );
    this.delayedStartTimer = setTimeout(() => {
      if (!this.running) return; // すでに stop された
      this.startTime = performance.now();
      this.observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const n of m.addedNodes) this._recordSubtree(n, "added");
          for (const n of m.removedNodes) this._recordSubtree(n, "removed");
        }
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
      logPanel("info", "[AutoLog] 自動採取開始（リングバッファ 60秒）");
    }, AUTO_LOG_START_DELAY_MS);
  },

  async save(trigger) {
    if (!this.running) return null;
    if (!this.observer) {
      logPanel(
        "info",
        `[AutoLog] 自動採取保存スキップ trigger=${trigger}（観察開始前）`,
      );
      return null;
    }
    const nowMs = performance.now() - this.startTime;
    const windowStart = nowMs - AUTO_LOG_WINDOW_MS;
    const recentEvents = this.events.filter((e) => e.t_ms >= windowStart);
    const result = {
      captured_at: new Date().toISOString(),
      trigger,
      url: window.location.href,
      window_ms: AUTO_LOG_WINDOW_MS,
      session_started_at: new Date(this.startWallTime).toISOString(),
      observer_started_after_delay_ms: AUTO_LOG_START_DELAY_MS,
      event_count: recentEvents.length,
      events: recentEvents,
    };
    const key = `${AUTO_LOG_KEY_PREFIX}${Date.now()}_${trigger}`;
    try {
      await chrome.storage.local.set({ [key]: result });
      logPanel(
        "info",
        `[AutoLog] 自動採取保存 trigger=${trigger}, key=${key}, events=${result.event_count}`,
      );
      await this._cleanupOldKeys();
    } catch (e) {
      logPanel(
        "warn",
        `[AutoLog] 自動採取保存失敗: ${e && e.message ? e.message : e}`,
      );
    }
    return { storage_key: key, result };
  },

  async _cleanupOldKeys() {
    try {
      const all = await chrome.storage.local.get(null);
      const autoKeys = Object.keys(all).filter((k) =>
        k.startsWith(AUTO_LOG_KEY_PREFIX),
      );
      if (autoKeys.length <= AUTO_LOG_MAX_STORED) return;
      // キー名にタイムスタンプを含むので文字列ソートで時系列順になる
      autoKeys.sort();
      const toRemove = autoKeys.slice(0, autoKeys.length - AUTO_LOG_MAX_STORED);
      await chrome.storage.local.remove(toRemove);
      logPanel(
        "info",
        `[AutoLog] 古いキー ${toRemove.length} 件削除（保持上限 ${AUTO_LOG_MAX_STORED}）`,
      );
    } catch (e) {
      logPanel(
        "warn",
        `[AutoLog] 古いキー削除失敗: ${e && e.message ? e.message : e}`,
      );
    }
  },

  stop(saved) {
    if (!this.running) return;
    this.running = false;
    if (this.delayedStartTimer) {
      clearTimeout(this.delayedStartTimer);
      this.delayedStartTimer = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.events = [];
    if (saved) {
      logPanel("info", "[AutoLog] 自動採取終了（エラー時保存済み）");
    } else {
      logPanel("info", "[AutoLog] 自動採取終了（保存なし）");
    }
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "ping") {
    sendResponse({ ok: true, url: window.location.href });
    return false;
  }
  if (msg.type === "send_to_claude") {
    performSend(msg.text || "", msg.settings || {})
      .then(sendResponse)
      .catch((e) => {
        const m = `想定外エラー: ${e && e.stack ? e.stack : e}`;
        logPanel("error", m);
        sendResponse({ ok: false, error: m });
      });
    return true; // async
  }
  if (msg.type === "start_dom_logger") {
    const r = domLogger.start();
    sendResponse(r);
    return false;
  }
  if (msg.type === "dom_logger_status") {
    sendResponse({
      ok: true,
      running: domLogger.running,
      event_count: domLogger.events.length,
    });
    return false;
  }
  return false;
});

} // initClaudeContentScript end
