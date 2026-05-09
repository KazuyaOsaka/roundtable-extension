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

  return {
    ok: true,
    usedInputSelector: inputResult.selector,
    usedInjectMethod,
    usedSubmitSelector: submitResult.selector,
  };
}

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
  return false;
});

} // initClaudeContentScript end
