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
      if (btn.querySelector("svg")) {
        return { element: btn, selector: "fallback:nearest-button-with-svg" };
      }
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
  return getInputText(input).includes(text);
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
  return getInputText(input).includes(text);
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
  return ok && getInputText(input).includes(text);
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

const STOP_BUTTON_SELECTOR = 'button[aria-label="応答を停止"]';

function findStopButton() {
  return document.querySelector(STOP_BUTTON_SELECTOR);
}

async function waitForResponseComplete(timeoutMs = 120000) {
  // 1) 停止ボタン出現を待つ（送信→応答開始）
  const appearStart = Date.now();
  while (!findStopButton()) {
    if (Date.now() - appearStart > 10000) {
      return {
        ok: false,
        error:
          "停止ボタンが10秒以内に出現しませんでした。応答開始失敗の可能性。",
      };
    }
    await sleep(150);
  }
  logPanel("info", "停止ボタン出現 → 応答中");

  // 2) 停止ボタン消滅を待つ（応答完了）
  const startWait = Date.now();
  let lastHeartbeat = startWait;
  while (findStopButton()) {
    const elapsed = Date.now() - startWait;
    if (elapsed > timeoutMs) {
      return {
        ok: false,
        error: `応答完了タイムアウト (${timeoutMs}ms 経過)`,
      };
    }
    // 10秒ごとに進捗ログ
    if (Date.now() - lastHeartbeat >= 10000) {
      lastHeartbeat = Date.now();
      logPanel("info", `応答中... ${Math.round(elapsed / 1000)}秒経過`);
    }
    await sleep(300);
  }

  // 3) 消滅の安定化（瞬間的な再出現の保険）
  await sleep(500);
  if (findStopButton()) {
    const remaining = timeoutMs - (Date.now() - startWait);
    if (remaining <= 0) {
      return {
        ok: false,
        error: `応答完了タイムアウト（再出現後の残時間なし）`,
      };
    }
    logPanel("warn", "停止ボタンが再出現。応答継続として待機を再開。");
    return await waitForResponseComplete(remaining);
  }
  logPanel("ok", "停止ボタン消滅 → 応答完了");
  return { ok: true };
}

function extractLatestAssistantMessage() {
  // 候補1: data-testid="assistant-message"
  const byTestid = document.querySelectorAll(
    '[data-testid="assistant-message"]',
  );
  if (byTestid.length > 0) {
    const last = byTestid[byTestid.length - 1];
    const text = (last.innerText || "").trim();
    if (text) {
      return {
        text,
        selector: '[data-testid="assistant-message"]',
      };
    }
  }

  // 候補2: data-message-author-role="assistant"
  const byAuthor = document.querySelectorAll(
    '[data-message-author-role="assistant"]',
  );
  if (byAuthor.length > 0) {
    const last = byAuthor[byAuthor.length - 1];
    const text = (last.innerText || "").trim();
    if (text) {
      return {
        text,
        selector: '[data-message-author-role="assistant"]',
      };
    }
  }

  // 候補3: user-message の次にある assistant らしき要素を兄弟方向に辿る
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
      const containsUserMessage = node.querySelector(
        '[data-testid="user-message"]',
      );
      const text = (node.innerText || "").trim();
      if (text && !containsUserMessage) {
        return {
          text,
          selector: "fallback:after-last-user-message",
        };
      }
      node = node.nextElementSibling;
    }
  }

  return { text: null, selector: null };
}

async function performSend(text) {
  if (!text || !text.trim()) {
    return { ok: false, error: "本文が空です。" };
  }

  // 0. 事前 Cloudflare チェック
  const preCf = detectCloudflare();
  if (preCf.detected) {
    const m = `Cloudflare検知（送信前）: ${preCf.by}。操作を中止します。`;
    logPanel("error", m);
    return { ok: false, error: m, cloudflare: true };
  }

  // 1. 入力欄
  const inputResult = findFirst(INPUT_SELECTORS);
  if (!inputResult) {
    const m =
      "入力欄が見つかりません（セレクタチェーン全滅）。claude.ai の画面が完全にロードされているか確認してください。";
    logPanel("error", m);
    return { ok: false, error: m };
  }
  logPanel("info", `入力欄ヒット: ${inputResult.selector}`);

  // 2. 注入（3手段フォールバック）
  let usedInjectMethod = null;
  for (const method of INJECT_METHODS) {
    try {
      const ok = await method.fn(inputResult.element, text);
      if (ok) {
        usedInjectMethod = method.name;
        logPanel("ok", `注入成功: ${method.name}`);
        break;
      }
      logPanel("warn", `注入失敗（本文未反映）: ${method.name}`);
    } catch (e) {
      logPanel(
        "warn",
        `注入エラー (${method.name}): ${e && e.message ? e.message : e}`,
      );
    }
  }
  if (!usedInjectMethod) {
    const m = "TipTap注入の3手段すべてに失敗しました。Kazuya に報告してください。";
    logPanel("error", m);
    return {
      ok: false,
      error: m,
      usedInputSelector: inputResult.selector,
    };
  }

  // 3. 送信前ランダム待機
  const preDelay = rand(200, 600);
  logPanel("info", `送信ボタン押下前の待機: ${Math.round(preDelay)}ms`);
  await sleep(preDelay);

  // 4. 送信ボタン
  let submitResult = findFirst(SUBMIT_SELECTORS);
  if (!submitResult) {
    const fb = findSubmitFallback();
    if (fb) {
      submitResult = fb;
      logPanel("info", `送信ボタン: フォールバック取得 (${fb.selector})`);
    }
  }
  if (!submitResult) {
    const m = "送信ボタンが見つかりません。";
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
      "送信ボタンが disabled。本文がエディタの内部状態に届いていない可能性。",
    );
  } else {
    logPanel("info", `送信ボタンヒット: ${submitResult.selector}`);
  }

  // 5. クリック (pointerdown -> pointerup -> click)
  await clickSubmit(submitResult.element);
  logPanel("info", "送信ボタン dispatch 完了 (pointerdown→pointerup→click)");

  // 6. 事後 Cloudflare チェック
  await sleep(800);
  const postCf = detectCloudflare();
  if (postCf.detected) {
    const m = `Cloudflare検知（送信後）: ${postCf.by}。Step 1A は中止して Kazuya に報告してください。`;
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
  logPanel("info", "応答完了を待機中...");
  const waitResult = await waitForResponseComplete();
  if (!waitResult.ok) {
    logPanel("warn", waitResult.error);
    return { ...baseResult, responseError: waitResult.error };
  }

  // 8. 応答テキスト抽出
  const extracted = extractLatestAssistantMessage();
  if (!extracted.text) {
    const m =
      "応答テキストの抽出に失敗。セレクタ候補（assistant-message / data-message-author-role / fallback）全滅。";
    logPanel("warn", m);
    return { ...baseResult, responseError: m };
  }
  logPanel(
    "ok",
    `応答抽出成功 (selector=${extracted.selector}, ${extracted.text.length}字)`,
  );

  return {
    ...baseResult,
    responseText: extracted.text,
    responseSelector: extracted.selector,
  };
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
          `DOMロガー: イベント上限 ${DOM_LOG_MAX_EVENTS} 件に到達。以降は記録を打ち切ります。`,
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
      `DOMロガー開始 (${DOM_LOG_DURATION_MS / 1000} 秒)。claude.ai タブで送信→応答を1往復してください。`,
    );

    let remaining = Math.floor(DOM_LOG_DURATION_MS / 1000);
    this.countdownTimer = setInterval(() => {
      remaining -= DOM_LOG_COUNTDOWN_STEP_MS / 1000;
      if (remaining > 0) {
        logPanel(
          "info",
          `DOMロガー実行中... 残り ${remaining} 秒（採取 ${this.events.length} 件）`,
        );
      }
    }, DOM_LOG_COUNTDOWN_STEP_MS);

    this.endTimer = setTimeout(() => {
      this.stop().catch((e) =>
        logPanel("error", `DOMロガー停止時エラー: ${e && e.message ? e.message : e}`),
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
        `DOMロガー終了。chrome.storage.local["${key}"] に保存（${result.event_count} 件、truncated=${result.truncated}）`,
      );
    } catch (e) {
      logPanel(
        "error",
        `DOMロガー結果の storage 保存に失敗: ${e && e.message ? e.message : e}`,
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "ping") {
    sendResponse({ ok: true, url: window.location.href });
    return false;
  }
  if (msg.type === "send_to_claude") {
    performSend(msg.text || "")
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
