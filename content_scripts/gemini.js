// content_scripts/gemini.js — gemini.google.com 用 Content Script
// ============================================================
// Phase 3b Step1: 調査専用（DOM 構造の採取に特化）。
//
//   ルーティングは Phase 3a Step1 で target 化済みのため、Gemini 追加は
//   AI_TARGETS への 1 エントリ + 対象 AI セレクタの選択肢追加だけで済む。
//   この gemini.js は ChatGPT の Step2（調査専用）と同型:
//     - 二重ロードガード + ping（疎通確認）
//     - 手動 DOM ロガー（60 秒 MutationObserver）
//     - Gemini 構造スナップショット（ロガー停止時に自動採取して
//       assistant_snapshot_* に保存。Kazuya は claude/chatgpt と同手順）
//
//   含まないもの（意図的、Step3 送り）:
//     - 送信パイプライン（注入 / 送信 / 応答抽出）
//     send_to_gemini は notImplemented を明示返却する。
//
//   調査の主目的:
//     1. "Show thinking" / 思考中表示の確実なセレクタ採取
//        （Gemini 2.5 系の思考表示。仕様書 §12.1 の thinking 検知方針を
//         Gemini にも適用するため。ChatGPT で実証済みの戦略を踏襲）
//     2. 入力欄 / 送信・停止ボタン / 応答ブロック / モデル選択 UI /
//        aria-live 二重 render の有無（claude=あり / chatgpt=なし、
//        Gemini はどちらか）/ bot 検知（Google は reCAPTCHA の可能性）
//
//   ダウンスコープ判断: 採取で Gemini DOM が不安定そうなら、2 社
//   （Claude+ChatGPT）で Phase 4 へ（ロードマップ §ピボット判断）。
//
//   ログは最初からタグ付き（[Gemini][Init/DOM/Snapshot/Ping]）。
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

  // ============================================================
  // 手動 DOM ロガー（chatgpt.js Step2 と同型。挙動同一）
  // ============================================================

  const DOM_LOG_DURATION_MS = 60000;
  const DOM_LOG_MAX_EVENTS = 2000;
  const DOM_LOG_COUNTDOWN_STEP_MS = 10000;
  const DOM_LOG_TEXT_LIMIT = 40;

  const DOM_LOG_CANDIDATE_SELECTOR = [
    "button",
    "[role='button']",
    "message-content",
    "model-response",
    "user-query",
    "[data-message-id]",
    "[data-test-id]",
    "[aria-live]",
    "rich-textarea",
    ".ql-editor",
    "div[class*='response']",
    "div[class*='message']",
  ].join(",");

  function classifyDomNode(node) {
    if (!(node instanceof Element)) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === "button" || node.getAttribute("role") === "button")
      return "button";
    // Gemini は Web Components（message-content / model-response / user-query）
    if (tag === "model-response") return "response:model-response";
    if (tag === "message-content") return "response:message-content";
    if (tag === "user-query") return "response:user-query";
    if (node.hasAttribute("data-message-id")) return "response:data-message-id";
    if (node.hasAttribute("aria-live")) return "aria-live";
    if (tag === "rich-textarea") return "composer:rich-textarea";
    const cls = node.getAttribute("class") || "";
    if (/ql-editor/.test(cls)) return "composer:ql-editor";
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
      const result = {
        captured_at: new Date().toISOString(),
        url: window.location.href,
        target: "gemini",
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
    /思考|考えています|Show thinking|Thinking|Reasoning|推論|処理中/i;
  const THINKING_ATTR_RE = /thinking|reasoning|reason|thought/i;
  const MODEL_TEXT_RE =
    /\b(gemini|2\.5|2\.0|1\.5|flash|pro|advanced|nano|ultra|thinking)\b/i;
  const STOP_ATTR_RE = /stop|cancel|停止|中止|生成を停止|応答を停止/i;

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
    document
      .querySelectorAll("[aria-label],[data-test-id],button,div,span")
      .forEach((el) => {
        const al = el.getAttribute("aria-label") || "";
        const dt = el.getAttribute("data-test-id") || "";
        const tx = (el.innerText || el.textContent || "").trim();
        const attrHit = THINKING_ATTR_RE.test(al) || THINKING_ATTR_RE.test(dt);
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
  //   ping / start_dom_logger / dom_logger_status : 対応
  //   send_to_gemini : Step3 で実装。今は notImplemented を明示返却
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "ping") {
      sendResponse({ ok: true, url: window.location.href });
      return false;
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

    if (msg.type === "send_to_gemini") {
      sendResponse({
        ok: false,
        error:
          "gemini.js は Phase 3b Step1（調査専用）です。送信パイプライン（注入/送信/応答抽出）は Step3 で実装予定。現状は ping と手動 DOM ロガーのみ対応。",
        notImplemented: true,
      });
      return false;
    }

    return false;
  });

  logPanel(
    "ok",
    "[Init] gemini.js Step1（調査専用）初期化完了。ping / 手動DOMロガー 対応。送信は Step3。",
  );
}
