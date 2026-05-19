// content_scripts/chatgpt.js — chatgpt.com 用 Content Script
// ============================================================
// Phase 3a Step2: 調査専用（DOM 構造の採取に特化）。
//
//   含むもの:
//     - 二重ロードガード（静的注入 + プログラム注入の両方が走っても
//       listener 二重登録しない。claude.js と同方式）
//     - ping 応答（ルーティング疎通確認、Step1 から維持）
//     - 手動 DOM ロガー（60 秒 MutationObserver。claude.js から移植）
//     - ChatGPT 構造スナップショット（querySelectorAll 網羅 + 狙い撃ち
//       プローブ。ロガー停止時に自動採取して assistant_snapshot_* に保存）
//
//   含まないもの（意図的）:
//     - 送信パイプライン（入力欄注入 / 送信 / 応答抽出）→ Step4
//     - dedup / 無音タイムアウト等の応答処理 → Step4
//     send_to_chatgpt は引き続き notImplemented を明示返却する。
//
//   調査の主目的（仕様書 v0.5 §12.1.1）:
//     1. Thinking / Reasoning / Pro 思考中表示の確実なセレクタ採取
//        （claude.ai で空振りした Thinking 検知の知見回収。Pro 5〜15分
//         対応の生命線）
//     2. 停止ボタン / 応答ブロック / aria-live 二重 render / 入力欄 /
//        送信ボタン / 末尾マーカー / モデル選択 UI / bot 検知方式
//
//   ログは最初からタグ付き（コーディング規約準拠）:
//     [ChatGPT][Init] [ChatGPT][DOM] [ChatGPT][Snapshot] [ChatGPT][Ping]
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
    "[Roundtable][ChatGPT][Init] chatgpt.js (Step2 調査専用) loaded on",
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

  // ============================================================
  // 手動 DOM ロガー（claude.js domLogger から移植。挙動同一）
  //   - document.body subtree を 60 秒 MutationObserver で監視
  //   - button / 応答ブロック候補の added / removed を記録
  //   - 結果は chrome.storage.local["dom_log_<ts>"] に保存
  //     （background の get_latest_dom_log は prefix 一致で対象 AI 非依存）
  //   - 停止時に ChatGPT 構造スナップショットも自動採取して
  //     assistant_snapshot_<ts> に保存（Kazuya は採取手順を変えなくてよい）
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
    const dataTestid = node.getAttribute("data-testid") || "";
    if (/conversation-turn/i.test(dataTestid))
      return "response:conversation-turn";
    if (/message/i.test(dataTestid)) return "response:data-testid-message";
    if (node.hasAttribute("data-message-author-role"))
      return "response:data-message-author-role";
    if (node.hasAttribute("data-message-id")) return "response:data-message-id";
    if (node.hasAttribute("aria-live")) return "aria-live";
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
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      logPanel(
        "ok",
        `[DOM] 手動DOMロガー開始 (${DOM_LOG_DURATION_MS / 1000} 秒)。chatgpt.com タブで送信→応答を1往復してください。`,
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
          logPanel(
            "error",
            `[DOM] 手動DOMロガー停止時エラー: ${e && e.message ? e.message : e}`,
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
          `[DOM] 手動DOMロガー終了。chrome.storage.local["${key}"] に保存（${result.event_count} 件、truncated=${result.truncated}）`,
        );
      } catch (e) {
        logPanel(
          "error",
          `[DOM] 手動DOMロガー結果の storage 保存に失敗: ${e && e.message ? e.message : e}`,
        );
      }

      chrome.runtime
        .sendMessage({ type: "dom_log_result", storage_key: key, result })
        .catch(() => {});

      this.events = [];

      // ロガー停止 = 応答完了済みの公算が高いので、この時点で構造
      // スナップショットも採取する。Kazuya は claude.ai と同じ手順
      // （ロガー→最新ログ→最新スナップショット）で 2 種の JSON を得られる。
      try {
        const snap = snapshotChatgptStructure();
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
          `[Snapshot] 構造スナップショット採取/保存に失敗: ${e && e.message ? e.message : e}`,
        );
      }

      return { storage_key: key, result };
    },
  };

  // ============================================================
  // ChatGPT 構造スナップショット
  //   調査が目的なので「広く網羅」＋「狙い撃ちプローブ」の二段で採る。
  //   - candidates: 応答ブロック候補（claude.js の網羅戦略を ChatGPT 用に調整）
  //   - probes: Step4 で必須の要素を狙い撃ちで採取
  //       stop_button / thinking / model_ui / composer / aria_live /
  //       all_button_aria_labels（停止・送信ラベル特定用に全ボタン列挙）
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
      ) {
        out[attr.name] = (attr.value || "").slice(0, 80);
      }
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

  // Thinking / Reasoning / Pro 処理中らしさのテキスト・属性パターン
  const THINKING_TEXT_RE =
    /thinking|reasoning|reasoned|analyzing|思考|推論|考え|処理中|working|生成中/i;
  const THINKING_ATTR_RE = /thinking|reasoning|reason|thought/i;
  // モデル名らしさ（モデル選択 UI / 現在モデル表示の特定用）
  const MODEL_TEXT_RE =
    /\b(gpt-?[45o]|gpt-4o|o[134]|o1|o3|chatgpt|turbo|thinking|pro|mini|auto)\b/i;
  const STOP_ATTR_RE = /stop|cancel|停止|中止/i;

  function snapshotChatgptStructure() {
    const candidates = [];

    // 戦略A: data-message-author-role（claude.js 戦略2相当。ChatGPT は
    // これを持つ公算が高い＝Step4 抽出の第一候補になりうる）
    document
      .querySelectorAll("[data-message-author-role]")
      .forEach((el, idx) => {
        candidates.push({
          strategy: "author-role-attr",
          index: idx,
          author_role: el.getAttribute("data-message-author-role"),
          ...describeEl(el),
        });
      });

    // 戦略B: data-testid に conversation-turn / message を含む
    document
      .querySelectorAll(
        "[data-testid*='conversation-turn'],[data-testid*='message']",
      )
      .forEach((el, idx) => {
        candidates.push({
          strategy: "testid-turn-or-message",
          index: idx,
          data_testid: el.getAttribute("data-testid"),
          ...describeEl(el),
        });
      });

    // 戦略C: article（ChatGPT は会話ターンを article で包むことがある）
    document.querySelectorAll("article").forEach((el, idx) => {
      candidates.push({
        strategy: "article",
        index: idx,
        ...describeEl(el),
      });
    });

    // 戦略D: data-message-id を持つ要素
    document.querySelectorAll("[data-message-id]").forEach((el, idx) => {
      candidates.push({
        strategy: "data-message-id",
        index: idx,
        ...describeEl(el),
      });
    });

    // ---- 狙い撃ちプローブ ----
    const allButtons = Array.from(document.querySelectorAll("button"));

    // 全ボタンの aria-label / data-testid / テキスト先頭を列挙
    // → 送信ボタン・停止ボタンのラベルを Kazuya とチャットで確定する材料
    const all_button_aria_labels = allButtons
      .map((b) => ({
        aria_label: b.getAttribute("aria-label") || null,
        data_testid: b.getAttribute("data-testid") || null,
        text_head: (b.innerText || b.textContent || "").trim().slice(0, 24),
        disabled: !!b.disabled,
      }))
      .filter(
        (b) => b.aria_label || b.data_testid || b.text_head,
      );

    // 停止ボタン候補（送信中のみ出現するため、応答完了後の採取では
    // 出ない可能性あり。出ていれば貴重。aria-label/testid/テキストで判定）
    const stop_button_candidates = allButtons
      .filter((b) => {
        const al = b.getAttribute("aria-label") || "";
        const dt = b.getAttribute("data-testid") || "";
        const tx = (b.innerText || b.textContent || "").trim();
        return (
          STOP_ATTR_RE.test(al) ||
          STOP_ATTR_RE.test(dt) ||
          STOP_ATTR_RE.test(tx)
        );
      })
      .map((b) => describeEl(b));

    // Thinking / Reasoning / Pro 処理中候補（最重要）
    const thinking_candidates = [];
    document
      .querySelectorAll("[aria-label],[data-testid],button,div,span")
      .forEach((el) => {
        const al = el.getAttribute("aria-label") || "";
        const dt = el.getAttribute("data-testid") || "";
        const tx = (el.innerText || el.textContent || "").trim();
        const attrHit = THINKING_ATTR_RE.test(al) || THINKING_ATTR_RE.test(dt);
        // テキスト一致は短い要素に限定（本文全体の誤検出を避ける）
        const textHit = tx.length > 0 && tx.length <= 40 && THINKING_TEXT_RE.test(tx);
        if (attrHit || textHit) {
          thinking_candidates.push(
            describeEl(el, { match: attrHit ? "attr" : "text" }),
          );
        }
      });

    // モデル選択 UI / 現在モデル表示候補（仕様書 v0.5 §12.1）
    const model_ui_candidates = [];
    document
      .querySelectorAll(
        "button,[role='button'],[aria-haspopup],[data-testid*='model']",
      )
      .forEach((el) => {
        const tx = (el.innerText || el.textContent || "").trim();
        const dt = el.getAttribute("data-testid") || "";
        if (
          (/model/i.test(dt)) ||
          (tx.length > 0 && tx.length <= 30 && MODEL_TEXT_RE.test(tx))
        ) {
          model_ui_candidates.push(describeEl(el));
        }
      });

    // 入力欄（composer）候補
    const composer_candidates = [];
    document
      .querySelectorAll(
        "#prompt-textarea,textarea,[contenteditable='true'],[data-testid*='composer'],[data-testid*='prompt'],div.ProseMirror",
      )
      .forEach((el) => composer_candidates.push(describeEl(el)));

    // aria-live 要素（claude.ai は画面表示用 + SR 用の二重 render が
    // 常時存在＝Y が主役。ChatGPT で同じか確認するための採取）
    const aria_live_elements = [];
    document.querySelectorAll("[aria-live]").forEach((el) => {
      aria_live_elements.push(
        describeEl(el, { aria_live: el.getAttribute("aria-live") }),
      );
    });

    // bot 検知（Cloudflare / reCAPTCHA）の痕跡
    const bot_challenge = {
      cloudflare_iframe: !!document.querySelector(
        "iframe[src*='challenges.cloudflare.com'],iframe[src*='cloudflare']",
      ),
      recaptcha_iframe: !!document.querySelector(
        "iframe[src*='recaptcha'],iframe[title*='recaptcha' i]",
      ),
      hcaptcha_iframe: !!document.querySelector("iframe[src*='hcaptcha']"),
      title: document.title || "",
    };

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
        bot_challenge,
      },
    };
  }

  // ============================================================
  // メッセージリスナ
  //   ping               : 疎通確認（Step1 から維持）
  //   start_dom_logger   : 手動 DOM ロガー起動（Step2 で実装）
  //   dom_logger_status  : ロガー状態（claude.js と同形）
  //   send_to_chatgpt    : Step4 で実装。今は notImplemented を明示返却
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

    if (msg.type === "send_to_chatgpt") {
      sendResponse({
        ok: false,
        error:
          "chatgpt.js は Phase 3a Step2（調査専用）です。送信パイプライン（注入/送信/応答抽出）は Step4 で実装予定。現状は ping と手動 DOM ロガーのみ対応。",
        notImplemented: true,
      });
      return false;
    }

    return false;
  });

  logPanel(
    "ok",
    "[Init] chatgpt.js Step2（調査専用）初期化完了。ping / 手動DOMロガー 対応。送信は Step4。",
  );
}
