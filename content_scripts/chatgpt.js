// content_scripts/chatgpt.js — chatgpt.com 用 Content Script
// ============================================================
// Phase 3a Step4: 送信パイプライン実装（Thinking-aware）。
//
//   含むもの:
//     - 二重ロードガード + ping（Step1 から維持）
//     - 手動 DOM ロガー / 構造スナップショット（Step2 の調査ツールを維持）
//     - 送信パイプライン（入力欄注入 → 送信 → 応答完了検知 → 抽出）
//       claude.js のアーキテクチャを移植し、ChatGPT 用セレクタに差替え
//       （既定方針「コピー＋差し替え」。共通化は 3 社揃った Phase 3 完了後）
//     - Thinking 検知（仕様書 v0.5 §12.1.1/§12.1.2）:
//       「思考中」+ loading-shimmer / 完了マーカー「思考時間: XXX」。
//       思考中は無音タイムアウトをリセット（Pro 5〜15 分対応の生命線）
//
//   設計上の前提（仕様書 v0.5 §12.1.2）:
//     - Kazuya は ChatGPT を Thinking/Pro のみで使う。普通モード（即答）
//       の最適化はしない。完了検知の一次信号は全モード共通の
//       stop-button(testid) 消滅、Thinking は活動可視化＋完了確証。
//     - Roundtable はモデルを切り替えない。Thinking は Kazuya が
//       ChatGPT 側 UI で事前選択しておく前提。
//
//   Step4 で検証する持ち越し事項（Step2 で未確認）:
//     1. aria-live 二重 render の有無（dedup=Y 発火を observable に）
//     2. 長文ストリーミングの安定化閾値（claude 実測 2500ms が妥当か）
//     3. bot 検知（Step2 で痕跡なし。汎用ガードのみ、検知時停止）
//     + クォータ枯渇等のエラー文言を best-effort 検知（DOM 未知のため
//       実機で観察。ハングさせず error 返却する）
//
//   claude.js は無変更（リグレッション源なし）。
//   ログは最初からタグ付き（[ChatGPT][Send/Inject/Submit/Wait/A1/A3/
//   Extract/C1/CF/DOM/Snapshot/AutoLog]）。
// ============================================================

if (window.__roundtableChatgptLoaded__) {
  console.log(
    "[Roundtable] chatgpt.js は既にロード済み。再初期化をスキップ。",
  );
} else {
  window.__roundtableChatgptLoaded__ = true;
  initChatgptContentScript();
}

function initChatgptContentScript() {
  console.log(
    "[Roundtable][ChatGPT][Init] chatgpt.js (Step4 送信パイプライン) loaded on",
    window.location.href,
  );

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
    fn(`[Roundtable][ChatGPT][${level}]`, message);
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ============================================================
  // セレクタ（Step2 採取で確定。ChatGPT は id + data-testid + aria-label
  // の三重で claude.ai より堅牢。優先順位は claude.js A2 原則に準拠:
  // aria-label / data-* / role / tag+属性 / class）
  // ============================================================

  const INPUT_SELECTORS = [
    "#prompt-textarea",
    'div[contenteditable="true"]#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    '[data-testid="composer"] [contenteditable="true"]',
    'textarea[data-testid="prompt-textarea"]',
  ];

  // 送信ボタン。送信⇔停止は同一 button#composer-submit-button で
  // data-testid だけ send-button / stop-button に切替わる（Step2 確定）。
  const SUBMIT_SELECTORS = [
    'button#composer-submit-button[data-testid="send-button"]',
    'button[data-testid="send-button"]',
    'button[aria-label="プロンプトを送信する"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
  ];

  const STOP_BUTTON_ARIA_LABELS = [
    "回答を停止",
    "Stop streaming",
    "Stop generating",
    "ストリーミングの停止",
  ];
  const STOP_BUTTON_SELECTORS = [
    'button#composer-submit-button[data-testid="stop-button"]',
    'button[data-testid="stop-button"]',
    ...STOP_BUTTON_ARIA_LABELS.map((l) => `button[aria-label="${l}"]`),
  ];

  // bot 検知。Step2 採取では chatgpt.com に Cloudflare/reCAPTCHA の
  // 痕跡なし。claude.ai のような常時ガードは無い公算だが、保守的に残す。
  const BOT_CHALLENGE_SELECTORS = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="cloudflare"]',
    'iframe[src*="recaptcha"]',
    'iframe[title*="recaptcha" i]',
    'iframe[src*="hcaptcha"]',
    "div.cf-turnstile",
    "div#challenge-form",
  ];
  const BOT_CHALLENGE_TITLE_PATTERNS = [
    "Just a moment",
    "Cloudflare",
    "確認中",
  ];

  // クォータ枯渇 / 一時エラーの文言（best-effort。Step2 では未採取の
  // ため実機で観察して精緻化する。検知してもハングさせず error 返却）。
  const ERROR_TEXT_PATTERNS = [
    /制限に達し/, // 「制限に達しました」
    /上限に達し/,
    /利用上限/,
    /reached your .{0,40}limit/i,
    /usage (?:cap|limit)/i,
    /too many requests/i,
    /you('| a)?re sending messages too quickly/i,
    /something went wrong/i,
    /エラーが発生しました/,
    /問題が発生しました/,
  ];

  function findFirst(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return { element: el, selector: sel };
    }
    return null;
  }

  function findStopButton() {
    for (const sel of STOP_BUTTON_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return { element: el, selector: sel };
    }
    return null;
  }

  function findSubmitFallback() {
    // 入力欄近傍の SVG ボタンを辿る。停止ボタン（送信中に同 ID で出現）は
    // testid / aria-label で除外（claude.js A4 fix と同じ安全装置）。
    const inputResult = findFirst(INPUT_SELECTORS);
    if (!inputResult) return null;
    let container = inputResult.element;
    for (let depth = 0; depth < 8 && container; depth++) {
      const buttons = container.querySelectorAll("button");
      for (const btn of buttons) {
        const testid = btn.getAttribute("data-testid") || "";
        const ariaLabel = btn.getAttribute("aria-label") || "";
        if (testid === "stop-button") continue;
        if (STOP_BUTTON_ARIA_LABELS.some((l) => ariaLabel.includes(l)))
          continue;
        if (testid === "send-button" || /送信|Send/i.test(ariaLabel)) {
          return { element: btn, selector: "fallback:composer-send-button" };
        }
      }
      container = container.parentElement;
    }
    return null;
  }

  function detectBotChallenge() {
    for (const sel of BOT_CHALLENGE_SELECTORS) {
      if (document.querySelector(sel))
        return { detected: true, by: `selector:${sel}` };
    }
    const title = document.title || "";
    for (const pat of BOT_CHALLENGE_TITLE_PATTERNS) {
      if (title.includes(pat))
        return { detected: true, by: `title:"${pat}"` };
    }
    return { detected: false };
  }

  function detectErrorText() {
    // 直近の assistant ターン or 会話末尾付近のテキストでエラー文言を探す。
    // best-effort: 取りこぼしは無音タイムアウト/バックストップが救う。
    const scopes = [];
    const turns = document.querySelectorAll(
      '[data-message-author-role="assistant"]',
    );
    if (turns.length > 0) scopes.push(turns[turns.length - 1]);
    const main = document.querySelector("main") || document.body;
    if (main) scopes.push(main);
    for (const scope of scopes) {
      const text = (scope.innerText || "").slice(-600);
      for (const re of ERROR_TEXT_PATTERNS) {
        if (re.test(text)) return { detected: true, pattern: String(re) };
      }
    }
    return { detected: false };
  }

  // ============================================================
  // Thinking 検知（Step2 確定パターン / 仕様書 v0.5 §12.1.1）
  //   - 思考中: text「思考中」を持つ要素 + class*="loading-shimmer"
  //   - 完了確証: text「思考時間: XXX」を含む button（クリックで思考過程
  //     を展開できる UI）。これが出れば応答完了が確実
  //   無音タイムアウトの一次防衛はテキスト変化。Thinking は「テキストが
  //   増えない長考」を救う補助だが、ChatGPT/Pro ではこれが生命線。
  // ============================================================

  const THINKING_INDICATOR_SELECTORS = [
    '[class*="loading-shimmer"]',
    '[aria-label*="思考"]',
    '[aria-label*="Thinking"]',
    '[aria-label*="Reasoning"]',
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
  ];
  const THINKING_TEXT_RE = /思考中|考えています|Thinking|Reasoning|推論中/i;
  const DONE_MARKER_RE = /思考時間|Thought for|Reasoned for/i;

  function findThinkingIndicator() {
    // 1) loading-shimmer / 既知 aria-label / testid
    for (const sel of THINKING_INDICATOR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.innerText || el.textContent || "").trim();
        // loading-shimmer は他用途でも使われうるので、思考中テキストを
        // 伴うか、shimmer 自体が短い活動要素である場合に採用
        if (
          /loading-shimmer/.test(sel) ? txt.length <= 40 || THINKING_TEXT_RE.test(txt) : true
        ) {
          return { element: el, selector: sel };
        }
      }
    }
    // 2) 短い要素のテキストスキャン（誤検出回避のため長さ制限）
    const nodes = document.querySelectorAll("button,div,span");
    for (const el of nodes) {
      const txt = (el.innerText || el.textContent || "").trim();
      if (txt.length > 0 && txt.length <= 30 && THINKING_TEXT_RE.test(txt)) {
        return { element: el, selector: "text:思考中-scan" };
      }
    }
    return null;
  }

  function hasDoneMarker() {
    const turns = document.querySelectorAll(
      '[data-message-author-role="assistant"]',
    );
    const scope =
      turns.length > 0 ? turns[turns.length - 1] : document.body;
    const buttons = scope.querySelectorAll("button,[role='button']");
    for (const b of buttons) {
      const t = (b.innerText || b.textContent || "").trim();
      if (t && t.length <= 40 && DONE_MARKER_RE.test(t)) return true;
    }
    return false;
  }

  // ============================================================
  // テキスト注入（claude.js から移植。挙動同一。ChatGPT も ProseMirror
  // 系のため clipboard-paste 優位の見込み。3 手段フォールバック）
  // ============================================================

  function getInputText(input) {
    return (input.innerText || input.textContent || input.value || "").replace(
      /[​-‍﻿]/g,
      "",
    );
  }

  // Phase 3a fix5: 注入成否の検証専用の正規化（claude.js と同型）。
  //   ProseMirror が改行 \n を段落化し innerText が "一行目\n\n二行目" に
  //   なると素の `.includes(text)` が改行数差で false になり「注入失敗」と
  //   誤判定する。改行ランを 1 つに畳んで比較。単行には影響しない no-op。
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
      input.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: ch,
          bubbles: true,
          cancelable: true,
        }),
      );
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
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
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
  // 応答テキスト抽出
  //   ChatGPT は [data-message-author-role="assistant"] を持つ（Step2
  //   確定）。claude.js の戦略2がここでは第一候補（Retry 祖先探索不要）。
  //   dedup パイプライン（Y）は claude.js から移植し observable に保つ
  //   → aria-live 二重 render の有無（持ち越し#1）を 10 連続で観測判定。
  // ============================================================

  // ChatGPT のスクリーンリーダー用プレフィックス候補（実機で精緻化）
  const ASSISTANT_TEXT_PREFIXES = [
    /^ChatGPTが応答しました[:：]\s*/,
    /^ChatGPT said:\s*/,
    /^Assistant said:\s*/,
  ];
  // 思考トレース・アクションラベル等の末尾/混入除去（best-effort）。
  // 「思考時間: 数秒」は完了マーカー兼トグル。本文ではないので除去。
  const ASSISTANT_TEXT_SUFFIX_PATTERNS = [
    /\n\s*\d{1,2}:\d{2}\s*$/,
    /\n\s*(コピー|Copy|共有|Share|編集|Edit|再生成|Regenerate|続ける|Continue generating|Good response|Bad response|高評価|低評価|フィードバック|この回答にする|モデルを変更)\s*$/,
    /\n\s*思考時間[:：][^\n]*$/,
    /\n\s*(Thought for|Reasoned for)[^\n]*$/,
  ];
  // 先頭に思考トグルが来るケースを best-effort で剥がす（展開済みで
  // reasoning 本文が混入する場合は既知の課題として観測・後続改善）。
  const LEADING_THINKING_RE =
    /^(思考時間[:：][^\n]*|思考中|Thought for[^\n]*|Reasoned for[^\n]*)\n+/;

  function normalizeForCompare(s) {
    return s
      .replace(/[​-‍﻿]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const TRAILING_DEDUP_TRIM_RE = /[…。．、！？\.\s」』）)"']+$/u;
  function trimTrailingDedupMarkers(s) {
    return s.replace(TRAILING_DEDUP_TRIM_RE, "");
  }

  function cleanAssistantText(raw) {
    if (!raw) return { text: "", dedup: null, diagnostic: null };
    let text = raw.trim();
    for (const pat of ASSISTANT_TEXT_PREFIXES) text = text.replace(pat, "");
    text = text.replace(LEADING_THINKING_RE, "");

    let dedup = null;
    let diagnostic = null;
    const parts = text
      .split(/\n\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const norm0 = normalizeForCompare(parts[0]);
      const norm1 = normalizeForCompare(parts[1]);
      let keepIdx = null;
      let dedupKind = null;
      let prefixIdx = null;
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
        const trim0 = trimTrailingDedupMarkers(norm0);
        const trim1 = trimTrailingDedupMarkers(norm1);
        if (trim0.length > 0 && trim1.length > 0) {
          if (trim0 === trim1) {
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
        diagnostic = {
          num_parts: parts.length,
          part_lengths: parts.slice(0, 4).map((p) => p.length),
          part_heads: parts.slice(0, 2).map((p) => p.slice(0, 60)),
        };
      }
    }

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

  function extractLatestAssistantMessage() {
    const meta = { strategy_hit: null };
    // 戦略1: data-message-author-role="assistant"（Step2 確定の第一候補）
    const byRole = document.querySelectorAll(
      '[data-message-author-role="assistant"]',
    );
    if (byRole.length > 0) {
      const last = byRole[byRole.length - 1];
      const raw = last.innerText || "";
      const { text, dedup, diagnostic } = cleanAssistantText(raw);
      if (text) {
        meta.strategy_hit = "author-role-assistant";
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
    // 戦略2: conversation-turn の最後（assistant を含むもの）
    const turns = document.querySelectorAll(
      '[data-testid^="conversation-turn"]',
    );
    if (turns.length > 0) {
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t.querySelector('[data-message-author-role="user"]')) continue;
        const raw = t.innerText || "";
        const { text, dedup, diagnostic } = cleanAssistantText(raw);
        if (text) {
          meta.strategy_hit = "conversation-turn-fallback";
          return {
            text,
            selector: `fallback:conversation-turn[${i}]`,
            raw_length: raw.length,
            dedup,
            diagnostic,
            extractionMeta: meta,
          };
        }
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
  // 応答完了検知（claude.js A1+A3 を移植し ChatGPT 用に調整）
  //   一次: stop-button(testid) 出現 → 消滅（全モード共通の堅牢信号）
  //   活動: 抽出テキスト変化 / 思考中表示 / 完了マーカー出現
  //   無音タイムアウト + バックストップ + 消滅後の安定化判定
  // ============================================================

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
      if (Date.now() - appearStart > 15000) {
        const err = detectErrorText();
        return {
          ok: false,
          error: err.detected
            ? `応答が開始されませんでした。エラー/制限の可能性 (${err.pattern})。`
            : "停止ボタンが15秒以内に出現しませんでした。応答開始失敗の可能性。",
          limit: err.detected || undefined,
        };
      }
      await sleep(150);
    }
    logPanel(
      "info",
      `[Wait] 停止ボタン出現 → 応答中 (selector=${firstHit.selector})`,
    );
    logPanel(
      "info",
      `[A3] 無音タイムアウト=${silenceTimeoutSec}秒、バックストップ=${Math.round(BACKSTOP_TIMEOUT_MS / 1000)}秒`,
    );

    // 2) 停止ボタン消滅を待つ + 無音タイムアウト判定
    const startWait = Date.now();
    let lastHeartbeat = startWait;
    let lastActivityAt = startWait;
    let lastObservedText = extractLatestAssistantMessage().text || "";
    let lastThinkingLogAt = 0;
    let thinkingHitCount = 0;
    let doneMarkerSeen = false;
    while (findStopButton()) {
      const now = Date.now();
      const elapsed = now - startWait;

      if (elapsed > BACKSTOP_TIMEOUT_MS) {
        return {
          ok: false,
          error: `応答完了タイムアウト（バックストップ ${Math.round(BACKSTOP_TIMEOUT_MS / 1000)}秒 経過）`,
          backstop: true,
        };
      }

      const curText = extractLatestAssistantMessage().text || "";
      if (curText !== lastObservedText) {
        lastObservedText = curText;
        lastActivityAt = now;
      }

      // Thinking 検知（テキストが増えない長考を救う = ChatGPT 生命線）
      const thinking = findThinkingIndicator();
      if (thinking) {
        lastActivityAt = now;
        thinkingHitCount++;
        if (now - lastThinkingLogAt >= 10000) {
          lastThinkingLogAt = now;
          logPanel(
            "info",
            `[A3] Thinking 検出 (selector=${thinking.selector})、無音タイムアウトをリセット`,
          );
        }
      }
      // 完了マーカー（思考時間: XXX）は「応答が出た」強い活動シグナル
      if (hasDoneMarker()) {
        lastActivityAt = now;
        if (!doneMarkerSeen) {
          doneMarkerSeen = true;
          logPanel("info", "[A3] 完了マーカー『思考時間: …』検出");
        }
      }

      const silenceMs = now - lastActivityAt;
      if (silenceMs > SILENCE_TIMEOUT_MS) {
        return {
          ok: false,
          error: `無音タイムアウト (${silenceTimeoutSec}秒 活動なし)。再試行 / スキップ / 中断を選んでください。`,
          silenceTimeout: true,
          thinkingHitCount,
        };
      }

      if (now - lastHeartbeat >= 10000) {
        lastHeartbeat = now;
        logPanel(
          "info",
          `[Wait] 応答中... ${Math.round(elapsed / 1000)}秒経過 (無音 ${Math.round(silenceMs / 1000)}秒, Thinking ${thinkingHitCount}回)`,
        );
      }
      await sleep(300);
    }

    // 3) 消滅の安定化（瞬間的再出現の保険）
    await sleep(500);
    if (findStopButton()) {
      logPanel("warn", "[Wait] 停止ボタンが再出現。応答継続として待機を再開。");
      return await waitForResponseComplete(settings);
    }
    logPanel("info", "[A1] 停止ボタン消滅 → テキスト安定化を確認中...");

    // 4) テキスト安定化判定（持ち越し#2: 閾値の妥当性を 10 連続で観測）
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
      `[A1] 応答完了（安定化確認 OK、安定化所要 ${Date.now() - stableStartedAt}ms、Thinking ${thinkingHitCount}回、完了マーカー=${doneMarkerSeen}）`,
    );
    return { ok: true };
  }

  // ============================================================
  // AutoDomLogger（claude.js A4 を移植。応答セッション中リングバッファ、
  // エラートリガー時に直近 60 秒を auto_dom_log_* に保存。背景の
  // get_latest_auto_dom_log は prefix 一致で対象 AI 非依存）
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
      if (!this.observer) return;
      const cat = classifyDomNode(node);
      if (!cat) return;
      if (this.events.length >= AUTO_LOG_MAX_EVENTS) {
        this.events.splice(0, Math.floor(AUTO_LOG_MAX_EVENTS * 0.1));
      }
      this.events.push(snapshotDomNode(node, cat, type, this.startTime));
    },
    _recordSubtree(node, type) {
      if (!(node instanceof Element)) return;
      this._recordOne(node, type);
      if (typeof node.querySelectorAll !== "function") return;
      for (const el of node.querySelectorAll(DOM_LOG_CANDIDATE_SELECTOR))
        this._recordOne(el, type);
    },
    start() {
      if (this.running) return;
      this.running = true;
      this.startWallTime = Date.now();
      this.events = [];
      this.observer = null;
      logPanel(
        "info",
        `[AutoLog] 自動採取準備（${AUTO_LOG_START_DELAY_MS}ms 後に観察開始）`,
      );
      this.delayedStartTimer = setTimeout(() => {
        if (!this.running) return;
        this.startTime = performance.now();
        this.observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const n of m.addedNodes) this._recordSubtree(n, "added");
            for (const n of m.removedNodes) this._recordSubtree(n, "removed");
          }
        });
        this.observer.observe(document.body, {
          childList: true,
          subtree: true,
        });
        logPanel("info", "[AutoLog] 自動採取開始（リングバッファ 60秒）");
      }, AUTO_LOG_START_DELAY_MS);
    },
    async save(trigger) {
      if (!this.running || !this.observer) {
        logPanel(
          "info",
          `[AutoLog] 保存スキップ trigger=${trigger}（観察開始前/未起動）`,
        );
        return null;
      }
      const nowMs = performance.now() - this.startTime;
      const windowStart = nowMs - AUTO_LOG_WINDOW_MS;
      const recentEvents = this.events.filter((e) => e.t_ms >= windowStart);
      const result = {
        captured_at: new Date().toISOString(),
        trigger,
        target: "chatgpt",
        url: window.location.href,
        window_ms: AUTO_LOG_WINDOW_MS,
        session_started_at: new Date(this.startWallTime).toISOString(),
        event_count: recentEvents.length,
        events: recentEvents,
      };
      const key = `${AUTO_LOG_KEY_PREFIX}${Date.now()}_${trigger}`;
      try {
        await chrome.storage.local.set({ [key]: result });
        logPanel(
          "info",
          `[AutoLog] 保存 trigger=${trigger}, key=${key}, events=${result.event_count}`,
        );
        await this._cleanupOldKeys();
      } catch (e) {
        logPanel(
          "warn",
          `[AutoLog] 保存失敗: ${e && e.message ? e.message : e}`,
        );
      }
      return { storage_key: key, result };
    },
    async _cleanupOldKeys() {
      try {
        const all = await chrome.storage.local.get(null);
        const autoKeys = Object.keys(all)
          .filter((k) => k.startsWith(AUTO_LOG_KEY_PREFIX))
          .sort();
        if (autoKeys.length <= AUTO_LOG_MAX_STORED) return;
        const toRemove = autoKeys.slice(
          0,
          autoKeys.length - AUTO_LOG_MAX_STORED,
        );
        await chrome.storage.local.remove(toRemove);
        logPanel(
          "info",
          `[AutoLog] 古いキー ${toRemove.length} 件削除（上限 ${AUTO_LOG_MAX_STORED}）`,
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
      logPanel(
        "info",
        saved
          ? "[AutoLog] 自動採取終了（エラー時保存済み）"
          : "[AutoLog] 自動採取終了（保存なし）",
      );
    },
  };

  // ============================================================
  // 送信パイプライン本体
  // ============================================================

  async function performSend(text, settings = {}) {
    if (!text || !text.trim()) {
      return { ok: false, error: "本文が空です。" };
    }

    autoDomLogger.start();
    let autoLogSaved = false;
    try {
      // 0. 事前 bot チェック
      const preBot = detectBotChallenge();
      if (preBot.detected) {
        const m = `[CF] bot 検知（送信前）: ${preBot.by}。操作を中止します。`;
        logPanel("error", m);
        return { ok: false, error: m, cloudflare: true };
      }

      // 0.5 応答中チェック（busy preflight。停止ボタン存在 = 応答中）
      const stopBtn = findStopButton();
      if (stopBtn) {
        const m = `ChatGPT が応答中のため送信できません。完了を待つか chatgpt.com で「回答を停止」を押してください。(detected: ${stopBtn.selector})`;
        logPanel("warn", `[Send] ${m}`);
        return { ok: false, error: m, busy: true };
      }

      // 1. 入力欄
      const inputResult = findFirst(INPUT_SELECTORS);
      if (!inputResult) {
        const m =
          "[Send] 入力欄が見つかりません（セレクタ全滅）。chatgpt.com が完全にロードされ、Thinking モードが選択済みか確認してください。";
        logPanel("error", m);
        return { ok: false, error: m };
      }
      logPanel("info", `[Send] 入力欄ヒット: ${inputResult.selector}`);

      // 2. 注入（3 手段フォールバック）
      let usedInjectMethod = null;
      for (const method of INJECT_METHODS) {
        try {
          if (await method.fn(inputResult.element, text)) {
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
        const m = "[Inject] 注入の3手段すべてに失敗しました。Kazuya に報告してください。";
        logPanel("error", m);
        return { ok: false, error: m, usedInputSelector: inputResult.selector };
      }

      // 3. 送信前ランダム待機
      const preDelay = rand(200, 600);
      logPanel(
        "info",
        `[Submit] 送信ボタン押下前の待機: ${Math.round(preDelay)}ms`,
      );
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
          "[Submit] 送信ボタンが disabled。本文がエディタ内部状態に届いていない可能性。",
        );
      } else {
        logPanel("info", `[Submit] 送信ボタンヒット: ${submitResult.selector}`);
      }

      // 5. クリック
      await clickSubmit(submitResult.element);
      logPanel(
        "info",
        "[Submit] 送信ボタン dispatch 完了 (pointerdown→pointerup→click)",
      );

      // 6. 事後 bot チェック
      await sleep(800);
      const postBot = detectBotChallenge();
      if (postBot.detected) {
        const m = `[CF] bot 検知（送信後）: ${postBot.by}。Kazuya に報告してください。`;
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
        let trigger = "wait_failed";
        if (waitResult.silenceTimeout) trigger = "silence_timeout";
        else if (waitResult.backstop) trigger = "backstop_timeout";
        else if (waitResult.limit) trigger = "limit_or_error";
        else if (waitResult.error && waitResult.error.includes("15秒"))
          trigger = "stop_button_no_appear";
        await autoDomLogger.save(trigger);
        autoLogSaved = true;
        logPanel("warn", waitResult.error);
        return {
          ...baseResult,
          responseError: waitResult.error,
          limit: waitResult.limit,
        };
      }

      // 8. 抽出
      await sleep(300);
      const extracted = extractLatestAssistantMessage();
      if (!extracted.text) {
        const m =
          "[Extract] 応答テキスト抽出失敗（author-role / conversation-turn 全滅）。";
        logPanel("warn", m);
        await autoDomLogger.save("extract_failed");
        autoLogSaved = true;
        return {
          ...baseResult,
          responseError: "応答テキスト抽出失敗",
          extractionMeta: extracted.extractionMeta,
        };
      }
      logPanel(
        "ok",
        `[Extract] 応答抽出成功 (selector=${extracted.selector}, ${extracted.text.length}字 / raw ${extracted.raw_length}字)`,
      );

      // dedup(Y) の発火状況をログ（持ち越し#1: aria-live 二重 render の
      // 有無を 10 連続で観測判定するための観測点）
      if (extracted.dedup) {
        if (extracted.dedup.kind === "prefix") {
          logPanel(
            "warn",
            `[C1] ⚠ prefix 重複検出 → 長い方 (${extracted.dedup.kept_length}字) 採用、短い方 (${extracted.dedup.dropped_length}字) 破棄`,
          );
        } else {
          logPanel(
            "warn",
            `[C1] ⚠ 完全一致重複検出 → 統合 (${extracted.dedup.kept_length}字)`,
          );
        }
      } else {
        logPanel("info", "[C1] 重複検出: 発火せず（ChatGPT は aria-live 二重 render 無しの可能性。10連続で確定）");
        if (extracted.diagnostic) {
          const d = extracted.diagnostic;
          logPanel(
            "info",
            `[C1:診断] 段落 ${d.num_parts} 個、長さ [${d.part_lengths.join(", ")}]字`,
          );
        }
      }

      return {
        ...baseResult,
        responseText: extracted.text,
        responseSelector: extracted.selector,
        responseRawLength: extracted.raw_length,
        responseDedup: extracted.dedup,
        extractionMeta: extracted.extractionMeta,
      };
    } finally {
      autoDomLogger.stop(autoLogSaved);
    }
  }

  // ============================================================
  // 手動 DOM ロガー（Step2 から維持）
  // ============================================================

  const DOM_LOG_DURATION_MS = 60000;
  const DOM_LOG_MAX_EVENTS = 2000;
  const DOM_LOG_COUNTDOWN_STEP_MS = 10000;
  const DOM_LOG_TEXT_LIMIT = 40;

  const DOM_LOG_CANDIDATE_SELECTOR = [
    "button",
    "[role='button']",
    "article",
    "[data-testid*='conversation-turn']",
    "[data-testid*='message']",
    "[data-message-author-role]",
    "[data-message-id]",
    "[aria-live]",
    '[class*="loading-shimmer"]',
    "div[class*='message']",
  ].join(",");

  function classifyDomNode(node) {
    if (!(node instanceof Element)) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === "button" || node.getAttribute("role") === "button")
      return "button";
    if (tag === "article") return "response:article";
    const dt = node.getAttribute("data-testid") || "";
    if (/conversation-turn/i.test(dt)) return "response:conversation-turn";
    if (/message/i.test(dt)) return "response:data-testid-message";
    if (node.hasAttribute("data-message-author-role"))
      return "response:data-message-author-role";
    if (node.hasAttribute("data-message-id")) return "response:data-message-id";
    if (node.hasAttribute("aria-live")) return "aria-live";
    const cls = node.getAttribute("class") || "";
    if (/loading-shimmer/.test(cls)) return "thinking:loading-shimmer";
    if (tag === "div" && /message/i.test(cls)) return "response:class-message";
    return null;
  }

  function snapshotDomNode(node, category, type, startTime) {
    const parent = node.parentElement;
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    return {
      t_ms: Math.round(performance.now() - startTime),
      type,
      category,
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      aria_label: node.getAttribute("aria-label") || null,
      aria_live: node.getAttribute("aria-live") || null,
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
            `[DOM] 手動DOMロガー: イベント上限 ${DOM_LOG_MAX_EVENTS} 件到達。打ち切り。`,
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
      for (const el of node.querySelectorAll(DOM_LOG_CANDIDATE_SELECTOR))
        this._recordOne(el, type);
    },
    start() {
      if (this.running)
        return { ok: false, error: "DOMロガーは既に実行中です。" };
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
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      logPanel(
        "ok",
        `[DOM] 手動DOMロガー開始 (${DOM_LOG_DURATION_MS / 1000} 秒)。chatgpt.com で送信→応答を1往復してください。`,
      );
      let remaining = Math.floor(DOM_LOG_DURATION_MS / 1000);
      this.countdownTimer = setInterval(() => {
        remaining -= DOM_LOG_COUNTDOWN_STEP_MS / 1000;
        if (remaining > 0)
          logPanel(
            "info",
            `[DOM] 実行中... 残り ${remaining} 秒（採取 ${this.events.length} 件）`,
          );
      }, DOM_LOG_COUNTDOWN_STEP_MS);
      this.endTimer = setTimeout(() => {
        this.stop().catch((e) =>
          logPanel(
            "error",
            `[DOM] 停止時エラー: ${e && e.message ? e.message : e}`,
          ),
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
        target: "chatgpt",
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
          `[DOM] 終了。storage["${key}"] に保存（${result.event_count} 件、truncated=${result.truncated}）`,
        );
      } catch (e) {
        logPanel(
          "error",
          `[DOM] storage 保存失敗: ${e && e.message ? e.message : e}`,
        );
      }
      chrome.runtime
        .sendMessage({ type: "dom_log_result", storage_key: key, result })
        .catch(() => {});
      this.events = [];
      try {
        const snap = snapshotChatgptStructure();
        const snapKey = `assistant_snapshot_${Date.now()}`;
        await chrome.storage.local.set({ [snapKey]: snap });
        logPanel(
          "ok",
          `[Snapshot] 構造スナップショット保存: ${snapKey}（候補 ${snap.candidate_count} 件）`,
        );
        chrome.runtime
          .sendMessage({
            type: "dom_log_result",
            storage_key: snapKey,
            result: { note: "snapshot は 📂 最新スナップショット で参照", snapshot_key: snapKey },
          })
          .catch(() => {});
      } catch (e) {
        logPanel(
          "warn",
          `[Snapshot] 採取/保存失敗: ${e && e.message ? e.message : e}`,
        );
      }
      return { storage_key: key, result };
    },
  };

  function dumpAttrs(el) {
    const out = {};
    for (const attr of el.attributes) {
      if (
        attr.name.startsWith("data-") ||
        attr.name.startsWith("aria-") ||
        attr.name === "id" ||
        attr.name === "role" ||
        attr.name === "type"
      )
        out[attr.name] = (attr.value || "").slice(0, 80);
    }
    return out;
  }
  function describeEl(el, extra = {}) {
    const text = (el.innerText || el.textContent || "").trim();
    return {
      tag: el.tagName.toLowerCase(),
      classes: ((el.className && el.className.toString()) || "").slice(0, 120),
      attrs: dumpAttrs(el),
      text_head: text.slice(0, 80),
      text_length: text.length,
      ...extra,
    };
  }
  const THINKING_ATTR_RE = /thinking|reasoning|reason|thought|shimmer/i;
  const MODEL_TEXT_RE =
    /\b(gpt-?[45o]|gpt-4o|o[134]|o1|o3|chatgpt|turbo|thinking|pro|mini|auto)\b/i;
  const STOP_ATTR_RE = /stop|cancel|停止|中止/i;

  function snapshotChatgptStructure() {
    const candidates = [];
    document
      .querySelectorAll("[data-message-author-role]")
      .forEach((el, idx) =>
        candidates.push({
          strategy: "author-role-attr",
          index: idx,
          author_role: el.getAttribute("data-message-author-role"),
          ...describeEl(el),
        }),
      );
    document
      .querySelectorAll(
        "[data-testid*='conversation-turn'],[data-testid*='message']",
      )
      .forEach((el, idx) =>
        candidates.push({
          strategy: "testid-turn-or-message",
          index: idx,
          data_testid: el.getAttribute("data-testid"),
          ...describeEl(el),
        }),
      );
    document
      .querySelectorAll("article")
      .forEach((el, idx) =>
        candidates.push({ strategy: "article", index: idx, ...describeEl(el) }),
      );
    const allButtons = Array.from(document.querySelectorAll("button"));
    const all_button_aria_labels = allButtons
      .map((b) => ({
        aria_label: b.getAttribute("aria-label") || null,
        data_testid: b.getAttribute("data-testid") || null,
        text_head: (b.innerText || b.textContent || "").trim().slice(0, 24),
        disabled: !!b.disabled,
      }))
      .filter((b) => b.aria_label || b.data_testid || b.text_head);
    const stop_button_candidates = allButtons
      .filter((b) => {
        const al = b.getAttribute("aria-label") || "";
        const dt = b.getAttribute("data-testid") || "";
        const tx = (b.innerText || b.textContent || "").trim();
        return (
          STOP_ATTR_RE.test(al) || STOP_ATTR_RE.test(dt) || STOP_ATTR_RE.test(tx)
        );
      })
      .map((b) => describeEl(b));
    const thinking_candidates = [];
    document
      .querySelectorAll(
        '[class*="loading-shimmer"],[aria-label],[data-testid],button,div,span',
      )
      .forEach((el) => {
        const al = el.getAttribute("aria-label") || "";
        const dt = el.getAttribute("data-testid") || "";
        const cls = el.getAttribute("class") || "";
        const tx = (el.innerText || el.textContent || "").trim();
        const attrHit =
          THINKING_ATTR_RE.test(al) ||
          THINKING_ATTR_RE.test(dt) ||
          THINKING_ATTR_RE.test(cls);
        const textHit =
          tx.length > 0 && tx.length <= 40 && THINKING_TEXT_RE.test(tx);
        if (attrHit || textHit)
          thinking_candidates.push(
            describeEl(el, { match: attrHit ? "attr" : "text" }),
          );
      });
    const model_ui_candidates = [];
    document
      .querySelectorAll(
        "button,[role='button'],[aria-haspopup],[data-testid*='model']",
      )
      .forEach((el) => {
        const tx = (el.innerText || el.textContent || "").trim();
        const dt = el.getAttribute("data-testid") || "";
        if (
          /model/i.test(dt) ||
          (tx.length > 0 && tx.length <= 30 && MODEL_TEXT_RE.test(tx))
        )
          model_ui_candidates.push(describeEl(el));
      });
    const composer_candidates = [];
    document
      .querySelectorAll(
        "#prompt-textarea,textarea,[contenteditable='true'],[data-testid*='composer'],div.ProseMirror",
      )
      .forEach((el) => composer_candidates.push(describeEl(el)));
    const aria_live_elements = [];
    document
      .querySelectorAll("[aria-live]")
      .forEach((el) =>
        aria_live_elements.push(
          describeEl(el, { aria_live: el.getAttribute("aria-live") }),
        ),
      );
    return {
      captured_at: new Date().toISOString(),
      url: location.href,
      target: "chatgpt",
      candidate_count: candidates.length,
      candidates,
      probes: {
        all_button_aria_labels,
        stop_button_candidates,
        thinking_candidates,
        model_ui_candidates,
        composer_candidates,
        aria_live_elements,
        bot_challenge: detectBotChallenge(),
      },
    };
  }

  // ============================================================
  // メッセージリスナ
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "ping") {
      sendResponse({ ok: true, url: window.location.href });
      return false;
    }

    if (msg.type === "send_to_chatgpt") {
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
      logPanel(
        r.ok ? "ok" : "warn",
        r.ok
          ? "[DOM] start_dom_logger 受信 → 採取開始"
          : `[DOM] start_dom_logger 拒否: ${r.error}`,
      );
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

  logPanel(
    "ok",
    "[Init] chatgpt.js Step4 初期化完了。送信パイプライン + Thinking 検知 + 調査ツール 稼働。",
  );
}
