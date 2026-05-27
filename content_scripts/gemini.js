// content_scripts/gemini.js — gemini.google.com 用 Content Script
// ============================================================
// Phase 3b Step3: 送信パイプライン実装（Thinking-aware）。
//
//   含むもの:
//     - 二重ロードガード + ping（Step1 から維持）
//     - 送信パイプライン（入力欄注入 → 送信 → 応答完了検知 → 抽出）
//       claude/chatgpt のアーキを移植し、Step2 確定の Gemini セレクタに差替え
//     - Thinking 検知（仕様書 v0.5 §12.1.1 を Gemini に適用）:
//       ライブ思考表示 [data-test-id="thinking-overlay-content"] /
//       .thinking-dots-animation を検知し、無音タイムアウトをリセット
//     - 調査ツール（手動 DOM ロガー + ストリーミングSS + 構造スナップ）を維持
//
//   Step2 確定セレクタ:
//     - 入力 : rich-textarea .ql-editor[role="textbox"]（Quill エディタ）
//     - 送信 : [data-test-id="send-button-container"] button[aria-label="プロンプトを送信"]
//     - 停止 : 同コンテナ button[aria-label="回答を停止"]（送信⇔停止が aria 切替）
//     - 抽出 : 最後の model-response 内 .markdown-main-panel（プレフィックス無し）
//     - 思考 : [data-test-id="thinking-overlay-content"] / .thinking-dots-animation
//     - dedup: 保険（完了応答 aria-live=off で本文の二重 render 無し = chatgpt 同型）
//
//   Step3 動作確認の重点:
//     - Quill での改行注入（fix5 の改行二重化が再発しないか）
//     - 停止ボタン出現→消滅 + A1 安定化で完了検知
//     - Gemini 10連続 / Claude・ChatGPT リグレッション
//
//   claude.js / chatgpt.js は無変更（リグレッション源なし）。
//   ログは最初からタグ付き（[Gemini][Init/Send/Inject/Submit/Wait/A1/A3/
//   Extract/C1/CF/DOM/Snapshot/AutoLog]）。
// ============================================================

if (window.__roundtableGeminiLoaded__) {
  console.log(
    "[Roundtable] gemini.js は既にロード済み。再初期化をスキップ。",
  );
} else {
  window.__roundtableGeminiLoaded__ = true;
  initGeminiContentScript();
}

function initGeminiContentScript() {
  console.log(
    "[Roundtable][Gemini][Init] gemini.js (Step1 調査専用) loaded on",
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
    fn(`[Roundtable][Gemini][${level}]`, message);
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ============================================================
  // セレクタ（Phase 3b Step2 採取で確定。Gemini は data-test-id +
  // Web Component タグ + aria-label の三重で堅牢。優先順位は claude.js
  // A2 原則に準拠: aria-label / data-* / role / tag+属性 / class）
  // ============================================================

  // 入力欄 = Quill エディタ（.ql-editor）。Claude(TipTap)/ChatGPT(ProseMirror)
  // と別系統。clipboard-paste 主軸で注入（fix5 の改行二重化検証式を移植）。
  const INPUT_SELECTORS = [
    'rich-textarea .ql-editor[role="textbox"]',
    '.ql-editor[role="textbox"]',
    '[aria-label="Gemini へのプロンプトを入力"]',
    "rich-textarea .ql-editor",
    '.ql-editor[contenteditable="true"]',
    ".ql-editor",
  ];

  // 送信ボタン。送信⇔停止は send-button-container 内の同一ノードで
  // aria-label が「プロンプトを送信」⇔「回答を停止」に切替わる（Step2 確定、
  // ChatGPT の testid 切替と同型）。
  const SUBMIT_SELECTORS = [
    '[data-test-id="send-button-container"] button[aria-label="プロンプトを送信"]',
    'button[aria-label="プロンプトを送信"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Submit"]',
  ];

  const STOP_BUTTON_ARIA_LABELS = [
    "回答を停止",
    "応答を停止",
    "生成を停止",
    "Stop response",
    "Stop generating",
  ];
  const STOP_BUTTON_SELECTORS = [
    ...STOP_BUTTON_ARIA_LABELS.map((l) => `button[aria-label="${l}"]`),
    '[data-test-id="send-button-container"] button[aria-label*="停止"]',
  ];

  // bot 検知。Step2 採取では gemini.google.com に reCAPTCHA/Cloudflare の
  // 痕跡なし。Google は異常時に reCAPTCHA / sorry ページを出しうるので保守的に残す。
  const BOT_CHALLENGE_SELECTORS = [
    'iframe[src*="recaptcha"]',
    'iframe[title*="recaptcha" i]',
    'iframe[src*="challenges.cloudflare.com"]',
    "div.g-recaptcha",
    "form#captcha-form",
  ];
  const BOT_CHALLENGE_TITLE_PATTERNS = [
    "通常とは異なる",
    "unusual traffic",
    "Just a moment",
    "確認中",
  ];

  // クォータ枯渇 / 一時エラーの文言（best-effort。実機で精緻化。検知しても
  // ハングさせず error 返却）。
  const ERROR_TEXT_PATTERNS = [
    /制限に達し/,
    /上限に達し/,
    /利用上限/,
    /しばらくしてから/,
    /現在ご利用いただけません/,
    /reached your .{0,40}limit/i,
    /usage (?:cap|limit)/i,
    /too many requests/i,
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
    // 入力欄から祖先を辿り、send-button-container 内の送信ボタンを探す。
    // 停止ボタン（生成中に aria-label 切替で出現）は除外。
    const inputResult = findFirst(INPUT_SELECTORS);
    if (!inputResult) return null;
    let container = inputResult.element;
    for (let depth = 0; depth < 10 && container; depth++) {
      const scoped = container.querySelector(
        '[data-test-id="send-button-container"] button',
      );
      if (scoped) {
        const al = scoped.getAttribute("aria-label") || "";
        if (!STOP_BUTTON_ARIA_LABELS.some((l) => al.includes(l)))
          return {
            element: scoped,
            selector: "fallback:send-button-container",
          };
      }
      for (const btn of container.querySelectorAll("button,[role='button']")) {
        const al = btn.getAttribute("aria-label") || "";
        if (STOP_BUTTON_ARIA_LABELS.some((l) => al.includes(l))) continue;
        if (/送信|Send|Submit/i.test(al))
          return { element: btn, selector: "fallback:send-by-aria" };
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
      if (title.includes(pat)) return { detected: true, by: `title:"${pat}"` };
    }
    return { detected: false };
  }

  function detectErrorText() {
    const scopes = [];
    const responses = document.querySelectorAll("model-response");
    if (responses.length > 0) scopes.push(responses[responses.length - 1]);
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
  // Thinking 検知（Step2 確定 / 仕様書 v0.5 §12.1.1 を Gemini に適用）
  //   生成中（思考＋ストリーミング）に出現するライブ思考表示:
  //     [data-test-id="thinking-overlay-content"] / .thinking-dots-animation /
  //     .thinking-container（英語ヘッドライン "Analyzing…" 等）。
  //   思考中はテキストが増えないため、これを無音タイムアウトのリセット信号に
  //   使う（ChatGPT で実証した「Phase 2 回収点」の Gemini 版）。
  //   ※ Gemini の思考ヘッドラインは任意テキストなので固定正規表現は使わず、
  //     セレクタ主体で検知する。
  // ============================================================

  const THINKING_INDICATOR_SELECTORS = [
    '[data-test-id="thinking-overlay-content"]',
    ".thinking-dots-animation",
    ".thinking-container",
    '[class*="animated-thinking"]',
  ];

  function findThinkingIndicator() {
    for (const sel of THINKING_INDICATOR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return { element: el, selector: sel };
    }
    return null;
  }

  // ============================================================
  // テキスト注入（claude.js/chatgpt.js から移植。挙動同一。Quill も
  // clipboard-paste 優位の見込み。3 手段フォールバック）
  // ============================================================

  function getInputText(input) {
    return (input.innerText || input.textContent || input.value || "").replace(
      /[​-‍﻿]/g,
      "",
    );
  }

  // Phase 3a fix5 移植: 注入成否の検証専用の正規化。ProseMirror/Quill が
  // 改行 \n を段落化し innerText が "一行目\n\n二行目" になると素の
  // `.includes(text)` が改行数差で false になり「注入失敗」と誤判定する。
  // 改行ランを 1 つに畳んで比較。単行には影響しない no-op。
  // ※ Quill で再発するかは Step3 動作確認の重点項目。
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
  // 応答テキスト抽出（Step2 確定）
  //   最後の model-response 内の .markdown-main-panel が実本文
  //   （「Gemini の回答」プレフィックス無し）。dedup(Y) は保険として移植し
  //   observable に保つ（Gemini は完了応答 aria-live=off で本文の常時二重
  //   render 無し → chatgpt 同型で不発の見込み）。
  // ============================================================

  const ASSISTANT_TEXT_PREFIXES = [
    /^Gemini の回答\s*/,
    /^Gemini said:\s*/,
    /^Gemini\s*\n+/,
  ];
  const ASSISTANT_TEXT_SUFFIX_PATTERNS = [
    /\n\s*(コピー|Copy|共有とエクスポート|Share|編集|Edit|やり直す|Regenerate|良い回答|悪い回答|他のオプションを表示)\s*$/,
  ];

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
    // 戦略1: 最後の model-response 内の .markdown-main-panel（実本文・無プレフィックス）
    const responses = document.querySelectorAll("model-response");
    if (responses.length > 0) {
      const last = responses[responses.length - 1];
      const panel =
        last.querySelector(".markdown-main-panel") ||
        last.querySelector("message-content .markdown") ||
        last.querySelector("message-content");
      const rawEl = panel || last;
      const raw = rawEl.innerText || "";
      const { text, dedup, diagnostic } = cleanAssistantText(raw);
      if (text) {
        meta.strategy_hit = panel
          ? "model-response>markdown-main-panel"
          : "model-response";
        return {
          text,
          selector: panel
            ? "model-response .markdown-main-panel"
            : "model-response",
          raw_length: raw.length,
          dedup,
          diagnostic,
          extractionMeta: meta,
        };
      }
    }
    // 戦略2: 最後の message-content
    const mcs = document.querySelectorAll("message-content");
    if (mcs.length > 0) {
      const last = mcs[mcs.length - 1];
      const raw = last.innerText || "";
      const { text, dedup, diagnostic } = cleanAssistantText(raw);
      if (text) {
        meta.strategy_hit = "message-content-fallback";
        return {
          text,
          selector: "fallback:message-content",
          raw_length: raw.length,
          dedup,
          diagnostic,
          extractionMeta: meta,
        };
      }
    }
    // 戦略3: .markdown-main-panel の最後（model-response が取れない場合の保険）
    const panels = document.querySelectorAll(".markdown-main-panel");
    if (panels.length > 0) {
      const last = panels[panels.length - 1];
      const raw = last.innerText || "";
      const { text, dedup, diagnostic } = cleanAssistantText(raw);
      if (text) {
        meta.strategy_hit = "markdown-main-panel-fallback";
        return {
          text,
          selector: "fallback:.markdown-main-panel",
          raw_length: raw.length,
          dedup,
          diagnostic,
          extractionMeta: meta,
        };
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
  // 応答完了検知（claude/chatgpt A1+A3 を移植し Gemini 用に調整）
  //   一次: 停止ボタン「回答を停止」出現 → 消滅
  //   活動: 抽出テキスト変化 / ライブ思考表示（thinking-overlay-content 等）
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
            : "停止ボタン（回答を停止）が15秒以内に出現しませんでした。応答開始失敗の可能性。",
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

      // ライブ思考表示（テキストが増えない長考を救う）
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

    // 4) テキスト安定化判定（claude/chatgpt 実測 2500ms が妥当か Step3 で観測）
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
      `[A1] 応答完了（安定化確認 OK、安定化所要 ${Date.now() - stableStartedAt}ms、Thinking ${thinkingHitCount}回）`,
    );
    return { ok: true };
  }

  // ============================================================
  // AutoDomLogger（claude/chatgpt A4 を移植。応答セッション中リングバッファ、
  // エラートリガー時に直近 60 秒を auto_dom_log_* に保存。background の
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
        target: "gemini",
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
        const toRemove = autoKeys.slice(0, autoKeys.length - AUTO_LOG_MAX_STORED);
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
        const m = `Gemini が応答中のため送信できません。完了を待つか gemini.google.com で「回答を停止」を押してください。(detected: ${stopBtn.selector})`;
        logPanel("warn", `[Send] ${m}`);
        return { ok: false, error: m, busy: true };
      }

      // 1. 入力欄
      const inputResult = findFirst(INPUT_SELECTORS);
      if (!inputResult) {
        const m =
          "[Send] 入力欄が見つかりません（セレクタ全滅）。gemini.google.com が完全にロードされ、思考拡張モデルが選択済みか確認してください。";
        logPanel("error", m);
        return { ok: false, error: m };
      }
      logPanel("info", `[Send] 入力欄ヒット: ${inputResult.selector}`);

      // 2. 注入（3 手段フォールバック。Quill は clipboard-paste 優位の見込み）
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
        const m =
          "[Inject] 注入の3手段すべてに失敗しました。Kazuya に報告してください。";
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
          logPanel(
            "info",
            `[Submit] 送信ボタン: フォールバック取得 (${fb.selector})`,
          );
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
          "[Extract] 応答テキスト抽出失敗（model-response / markdown-main-panel 全滅）。";
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

      // dedup(Y) の発火状況をログ（Gemini は不発の見込み = chatgpt 同型）
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
        logPanel(
          "info",
          "[C1] 重複検出: 発火せず（Gemini は完了応答 aria-live=off で二重 render 無し）",
        );
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
  // 手動 DOM ロガー（chatgpt.js Step2 と同型。挙動同一）
  // ============================================================

  const DOM_LOG_DURATION_MS = 60000;
  const DOM_LOG_MAX_EVENTS = 2000;
  const DOM_LOG_COUNTDOWN_STEP_MS = 10000;
  const DOM_LOG_TEXT_LIMIT = 40;

  // Step1b: childList observer は Gemini の characterData ストリーム/属性切替を
  // 拾えない（停止ボタン・思考表示が見えない）ため、生成中の DOM 状態を
  // 一定間隔で「ストリーミングスナップショット」として採取する。
  const STREAM_SNAPSHOT_TIMES_MS = [
    2000, 4000, 6000, 8000, 10000, 13000, 16000, 20000, 25000, 30000,
  ];

  const DOM_LOG_CANDIDATE_SELECTOR = [
    "button",
    "[role='button']",
    "message-content",
    "model-response",
    "model-thoughts", // Step1b: Show thinking パネル（Web Component）
    "structured-content-container", // Step1b: processing-state-visible を持つ本文ラッパ
    "user-query",
    "[data-message-id]",
    "[data-test-id]",
    "[aria-live]",
    "rich-textarea",
    ".ql-editor",
    "[class*='thought']", // Step1b: 思考系クラス（has-thoughts 等）
    "div[class*='response']",
    "div[class*='message']",
  ].join(",");

  function classifyDomNode(node) {
    if (!(node instanceof Element)) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === "button" || node.getAttribute("role") === "button")
      return "button";
    // Gemini は Web Components（message-content / model-response / user-query）
    if (tag === "model-thoughts") return "thinking:model-thoughts"; // Step1b
    if (tag === "model-response") return "response:model-response";
    if (tag === "message-content") return "response:message-content";
    if (tag === "structured-content-container")
      return "response:structured-content"; // Step1b
    if (tag === "user-query") return "response:user-query";
    if (node.hasAttribute("data-message-id")) return "response:data-message-id";
    if (node.hasAttribute("aria-live")) return "aria-live";
    if (tag === "rich-textarea") return "composer:rich-textarea";
    const cls = node.getAttribute("class") || "";
    if (/ql-editor/.test(cls)) return "composer:ql-editor";
    if (/thought|thinking/i.test(cls)) return "thinking:class"; // Step1b
    if (/response/i.test(cls)) return "response:class-response";
    if (/message/i.test(cls)) return "response:class-message";
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
      data_test_id: node.getAttribute("data-test-id") || null,
      data_message_id: node.getAttribute("data-message-id") || null,
      button_type: node.getAttribute("type") || null,
      role: node.getAttribute("role") || null,
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
    streamSnapshots: [], // Step1b: 生成中の DOM 状態サンプル列
    streamTimers: [],
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
      this.streamSnapshots = [];
      // Step1b: 生成中の DOM 状態を一定間隔で採取（停止ボタン・思考表示が
      // 属性/characterData 変化のため childList observer では見えないので）。
      this.streamTimers = STREAM_SNAPSHOT_TIMES_MS.map((t) =>
        setTimeout(() => {
          if (!this.running) return;
          try {
            this.streamSnapshots.push(captureStreamingProbe(this.startTime));
          } catch (e) {
            /* probe 失敗は無視（採取継続） */
          }
        }, t),
      );
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
        `[DOM] 手動DOMロガー開始 (${DOM_LOG_DURATION_MS / 1000} 秒)。gemini.google.com で送信→応答を1往復してください。`,
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
      for (const t of this.streamTimers) clearTimeout(t);
      this.streamTimers = [];
      const result = {
        captured_at: new Date().toISOString(),
        url: window.location.href,
        target: "gemini",
        duration_ms: DOM_LOG_DURATION_MS,
        event_count: this.events.length,
        truncated: this.truncated,
        stream_snapshot_count: this.streamSnapshots.length, // Step1b
        stream_snapshots: this.streamSnapshots, // Step1b: 生成中の状態サンプル
        events: this.events,
      };
      const key = `dom_log_${Date.now()}`;
      try {
        await chrome.storage.local.set({ [key]: result });
        logPanel(
          "ok",
          `[DOM] 終了。storage["${key}"] に保存（${result.event_count} 件、ストリーミングSS ${result.stream_snapshot_count} 枚、truncated=${result.truncated}）`,
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
        const snap = snapshotGeminiStructure();
        const snapKey = `assistant_snapshot_${Date.now()}`;
        await chrome.storage.local.set({ [snapKey]: snap });
        logPanel(
          "ok",
          `[Snapshot] 構造スナップショット保存: ${snapKey}（候補 ${snap.candidate_count} 件、停止ボタン候補 ${snap.probes.stop_button_candidates.length} / Thinking 候補 ${snap.probes.thinking_candidates.length} / モデル UI 候補 ${snap.probes.model_ui_candidates.length}）`,
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

  // ============================================================
  // Gemini 構造スナップショット（広く網羅 + 狙い撃ちプローブ）
  // ============================================================

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

  const THINKING_TEXT_RE =
    /思考|考え|Show thinking|Hide thinking|Thinking|Reasoning|推論|処理中/i;
  const THINKING_ATTR_RE = /thinking|reasoning|reason|thought/i;
  const MODEL_TEXT_RE =
    /\b(gemini|2\.5|2\.0|1\.5|flash|pro|advanced|nano|ultra|thinking)\b/i;
  const STOP_ATTR_RE = /stop|cancel|停止|中止|生成を停止|応答を停止/i;

  // ============================================================
  // Step1b: ストリーミングスナップショット（生成中の DOM 状態を軽量採取）
  //   childList observer の死角（停止ボタンの属性切替・思考表示の
  //   characterData ストリーム）を、間隔ポーリングで可視化する。
  // ============================================================
  function captureStreamingProbe(startTime) {
    const t_ms = Math.round(performance.now() - startTime);

    // 生成中/完了を表すクラス系マーカー（snapshot で確定した手掛かり）
    const markers = {
      markdown_animate: !!document.querySelector(".markdown-main-panel.animate"),
      processing_state_visible: !!document.querySelector(
        "[class*='processing-state-visible']",
      ),
      response_footer_complete: !!document.querySelector(
        ".response-footer.complete",
      ),
      has_thoughts: !!document.querySelector("[class*='has-thoughts']"),
      model_thoughts_present: !!document.querySelector("model-thoughts"),
    };

    // 思考パネル（Web Component）
    const model_thoughts = [];
    document
      .querySelectorAll("model-thoughts")
      .forEach((el) => model_thoughts.push(describeEl(el)));

    // 思考系クラスを持つ要素（has-thoughts / *thinking* / *thought*）
    const thinking_by_class = [];
    document
      .querySelectorAll("[class*='thought'],[class*='thinking']")
      .forEach((el) => {
        if (thinking_by_class.length < 20)
          thinking_by_class.push(describeEl(el));
      });

    // Show thinking トグル等、思考を示すテキスト/aria のボタン
    const thinking_buttons = [];
    document.querySelectorAll("button,[role='button']").forEach((b) => {
      const al = b.getAttribute("aria-label") || "";
      const tx = (b.innerText || b.textContent || "").trim();
      if (
        THINKING_TEXT_RE.test(al) ||
        (tx.length > 0 && tx.length <= 40 && THINKING_TEXT_RE.test(tx))
      )
        thinking_buttons.push({
          aria_label: al || null,
          text_head: tx.slice(0, 40),
          data_test_id: b.getAttribute("data-test-id") || null,
        });
    });

    // 送信⇔停止が切り替わる composer 内のボタン（永続ノードの現在状態）
    const composer_buttons = [];
    document
      .querySelectorAll(
        "[data-test-id='send-button-container'] button,[data-test-id='send-button-container'] [role='button']",
      )
      .forEach((b) => {
        const ic = b.querySelector("mat-icon,[class*='icon']");
        composer_buttons.push({
          aria_label: b.getAttribute("aria-label") || null,
          data_test_id: b.getAttribute("data-test-id") || null,
          disabled: !!b.disabled,
          mat_icon: ic ? (ic.textContent || "").trim().slice(0, 24) : null,
          class: (b.getAttribute("class") || "").slice(0, 80),
        });
      });

    // 停止系の語にマッチするボタン（生成中のみ出る想定）
    const stop_like = [];
    document.querySelectorAll("button,[role='button']").forEach((b) => {
      const al = b.getAttribute("aria-label") || "";
      const dt = b.getAttribute("data-test-id") || "";
      const tx = (b.innerText || b.textContent || "").trim();
      if (STOP_ATTR_RE.test(al) || STOP_ATTR_RE.test(dt) || STOP_ATTR_RE.test(tx))
        stop_like.push({
          aria_label: al || null,
          data_test_id: dt || null,
          text_head: tx.slice(0, 30),
        });
    });

    return {
      t_ms,
      markers,
      composer_buttons,
      stop_like,
      model_thoughts,
      thinking_buttons,
      thinking_by_class,
    };
  }

  function snapshotGeminiStructure() {
    const candidates = [];

    // 戦略A: Gemini の応答系 Web Components
    document
      .querySelectorAll("model-response,message-content,user-query")
      .forEach((el, idx) =>
        candidates.push({
          strategy: `webcomponent:${el.tagName.toLowerCase()}`,
          index: idx,
          ...describeEl(el),
        }),
      );

    // 戦略B: data-message-id / data-test-id を持つ要素
    document
      .querySelectorAll("[data-message-id],[data-test-id]")
      .forEach((el, idx) =>
        candidates.push({
          strategy: "data-id-attr",
          index: idx,
          data_message_id: el.getAttribute("data-message-id"),
          data_test_id: el.getAttribute("data-test-id"),
          ...describeEl(el),
        }),
      );

    // 戦略C: response/message/model を含む class（先頭 40 件まで）
    document
      .querySelectorAll(
        "div[class*='response'],div[class*='message'],div[class*='model']",
      )
      .forEach((el, idx) => {
        if (idx < 40)
          candidates.push({
            strategy: "class-response-or-message",
            index: idx,
            ...describeEl(el),
          });
      });

    const allButtons = Array.from(document.querySelectorAll("button"));
    const all_button_aria_labels = allButtons
      .map((b) => ({
        aria_label: b.getAttribute("aria-label") || null,
        data_test_id: b.getAttribute("data-test-id") || null,
        text_head: (b.innerText || b.textContent || "").trim().slice(0, 24),
        mat_icon: (() => {
          const ic = b.querySelector("mat-icon,[class*='icon']");
          return ic ? (ic.textContent || "").trim().slice(0, 20) : null;
        })(),
        disabled: !!b.disabled,
      }))
      .filter(
        (b) => b.aria_label || b.data_test_id || b.text_head || b.mat_icon,
      );

    const stop_button_candidates = allButtons
      .filter((b) => {
        const al = b.getAttribute("aria-label") || "";
        const dt = b.getAttribute("data-test-id") || "";
        const tx = (b.innerText || b.textContent || "").trim();
        return (
          STOP_ATTR_RE.test(al) || STOP_ATTR_RE.test(dt) || STOP_ATTR_RE.test(tx)
        );
      })
      .map((b) => describeEl(b));

    const thinking_candidates = [];
    // Step1b: model-thoughts Web Component を最優先で採取
    document
      .querySelectorAll("model-thoughts")
      .forEach((el) =>
        thinking_candidates.push(describeEl(el, { match: "model-thoughts" })),
      );
    // Step1b: aria-label / data-test-id / class / 短文 のいずれかが思考系
    document
      .querySelectorAll("[aria-label],[data-test-id],[class],button,div,span")
      .forEach((el) => {
        const al = el.getAttribute("aria-label") || "";
        const dt = el.getAttribute("data-test-id") || "";
        const cls = el.getAttribute("class") || "";
        const tx = (el.innerText || el.textContent || "").trim();
        const attrHit =
          THINKING_ATTR_RE.test(al) ||
          THINKING_ATTR_RE.test(dt) ||
          THINKING_ATTR_RE.test(cls);
        const textHit =
          tx.length > 0 && tx.length <= 40 && THINKING_TEXT_RE.test(tx);
        if ((attrHit || textHit) && thinking_candidates.length < 40)
          thinking_candidates.push(
            describeEl(el, { match: attrHit ? "attr/class" : "text" }),
          );
      });

    const model_ui_candidates = [];
    document
      .querySelectorAll(
        "button,[role='button'],[aria-haspopup],[data-test-id*='model']",
      )
      .forEach((el) => {
        const tx = (el.innerText || el.textContent || "").trim();
        const dt = el.getAttribute("data-test-id") || "";
        if (
          /model/i.test(dt) ||
          (tx.length > 0 && tx.length <= 30 && MODEL_TEXT_RE.test(tx))
        )
          model_ui_candidates.push(describeEl(el));
      });

    const composer_candidates = [];
    document
      .querySelectorAll(
        "rich-textarea,.ql-editor,[contenteditable='true'],textarea,[data-test-id*='input']",
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

    const bot_challenge = {
      recaptcha_iframe: !!document.querySelector(
        "iframe[src*='recaptcha'],iframe[title*='recaptcha' i]",
      ),
      cloudflare_iframe: !!document.querySelector(
        "iframe[src*='challenges.cloudflare.com'],iframe[src*='cloudflare']",
      ),
      title: document.title || "",
    };

    return {
      captured_at: new Date().toISOString(),
      url: location.href,
      target: "gemini",
      candidate_count: candidates.length,
      candidates,
      probes: {
        all_button_aria_labels,
        stop_button_candidates,
        thinking_candidates,
        model_ui_candidates,
        composer_candidates,
        aria_live_elements,
        bot_challenge,
      },
    };
  }

  // ============================================================
  // メッセージリスナ
  //   ping / send_to_gemini / start_dom_logger / dom_logger_status
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "ping") {
      sendResponse({ ok: true, url: window.location.href });
      return false;
    }

    if (msg.type === "send_to_gemini") {
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
    "[Init] gemini.js Step3 初期化完了。送信パイプライン + Thinking 検知 + 調査ツール 稼働。",
  );
}
