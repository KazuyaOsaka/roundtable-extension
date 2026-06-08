// lib/roundtable_panel.js — Roundtable サイドパネルの Phase 4 制御
// ============================================================
// Phase 4（このファイルの現在範囲）:
//   - セッション管理（新規作成 / アクティブ表示 / ターン数）
//   - 3 社タブ束縛 UI（Claude / ChatGPT / Gemini の送信先タブを各 1 つ）
//   - 3 タブ ping（到達性確認）
//   - 議論スレッドの最小表示（時系列・発言者ラベル・本文）
//   - Kazuya 発言を履歴に記録 + 3 社へ §5 配信（Step2b）
//   - Step3a: 指名ターン制御。指名された 1 社のタブにだけ §5 応答指示
//     （全履歴付き）を注入・送信し、応答を kind="response" で記録する。
//     他 2 社のタブには一切触れない＝物理的に沈黙が保証される
//     （AI は入力欄に貼って送信されない限り新発言を出さないため）。
//     履歴フォーマッタは Kazuya 発言 + kind="response" のみ Markdown 化し、
//     init_ack / standby_ack（各社の「了解」）は除外する。
//
// 設計:
//   - window.RTSession（lib/session_store.js）にのみ依存。side_panel.js の
//     既存送信パイプラインには一切触れない（side_panel.js はバイト無変更）。
//   - ログは既存 #log エリアに [RT] タグ付きで流す（イベント列を一本化）。
//   - タブ束縛は runtime 状態（永続化しない。tabId は再起動で変わるため）。
//
// ロード順（side_panel.html 末尾、classic script）:
//   session_store.js → side_panel.js → roundtable_panel.js
// ============================================================

(function () {
  // 仕様書§6 のアバター色（🟧 Claude / 🟩 ChatGPT / 🟨 Gemini / ⬜ Kazuya）
  const SPEAKER_META = {
    kazuya: { label: "Kazuya", emoji: "⬜", role: "議長" },
    claude: { label: "Claude", emoji: "🟧" },
    chatgpt: { label: "ChatGPT", emoji: "🟩" },
    gemini: { label: "Gemini", emoji: "🟨" },
  };
  // タブ束縛 UI の対象（仕様書§8 デフォルト順に合わせて Gemini→ChatGPT→Claude）
  const TAB_TARGETS = [
    { key: "gemini", label: "Gemini", site: "gemini.google.com" },
    { key: "chatgpt", label: "ChatGPT", site: "chatgpt.com" },
    { key: "claude", label: "Claude", site: "claude.ai" },
  ];

  // ---- DOM 参照 ----------------------------------------------
  const $log = document.getElementById("log");
  const $title = document.getElementById("rt-session-title");
  const $newSession = document.getElementById("rt-new-session");
  const $sessionInfo = document.getElementById("rt-session-info");
  const $reloadTabs = document.getElementById("rt-reload-tabs");
  const $pingTabs = document.getElementById("rt-ping-tabs");
  const $thread = document.getElementById("rt-thread");
  const $message = document.getElementById("rt-message");
  const $record = document.getElementById("rt-record");
  const $step2aInit = document.getElementById("rt-step2a-init");
  const $tabSelects = {
    gemini: document.getElementById("rt-tab-gemini"),
    chatgpt: document.getElementById("rt-tab-chatgpt"),
    claude: document.getElementById("rt-tab-claude"),
  };
  // Step3a: 指名ボタン（1 社にだけ応答指示を送る）
  const $nominate = {
    gemini: document.getElementById("rt-nominate-gemini"),
    chatgpt: document.getElementById("rt-nominate-chatgpt"),
    claude: document.getElementById("rt-nominate-claude"),
  };

  const NO_TAB_VALUE = "__none__";

  // ---- runtime 状態 ------------------------------------------
  let activeSession = null;
  // Step2a: §5 初回投入の済み判定。key = `${sessionId}:${tabId}`。
  // 永続化しない（runtime のみ）。パネル再オープン or タブ再束縛でリセット。
  // Step2b 本実装で必要なら永続化を検討（仕様書§5「各タブのセッション最初に1回」）。
  const initInjected = new Set();
  // tabBindings は getSelectedTabId() で都度ドロップダウンから読むので保持不要だが、
  // ping 等のために key→tabId を引けるようにする。
  function getBoundTabId(targetKey) {
    const sel = $tabSelects[targetKey];
    if (!sel) return null;
    const v = sel.value;
    if (!v || v === NO_TAB_VALUE) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  function targetOf(targetKey) {
    return TAB_TARGETS.find((x) => x.key === targetKey) || null;
  }
  function labelOf(targetKey) {
    const t = targetOf(targetKey);
    return (t && t.label) || targetKey;
  }

  // 多重実行ガード: ターン進行系の操作（発言記録 / §5 初回投入 / 指名）が
  // 走っている間は、これらのボタンをまとめて無効化して同時注入を防ぐ。
  // Step3 ステートマシンの最小版（IDLE↔処理中）。AUTO/STOPPING は Step3b。
  function setTurnControlsDisabled(disabled) {
    if ($record) $record.disabled = disabled;
    if ($step2aInit) $step2aInit.disabled = disabled;
    for (const k of Object.keys($nominate)) {
      if ($nominate[k]) $nominate[k].disabled = disabled;
    }
  }

  // ---- ログ（既存 #log を流用、[RT] タグ付き） ----------------
  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function nowHms() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function rtLog(level, message) {
    if (!$log) return;
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `[${nowHms()}]`;
    const prefix = { info: "•", ok: "✓", warn: "⚠", error: "✗" }[level] || "•";
    line.appendChild(ts);
    line.appendChild(document.createTextNode(`${prefix} [RT] ${message}`));
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  }

  // ---- タブラベル（最小。Phase 6 で整える） -------------------
  function tabLabel(tab) {
    const marker = tab.isCurrentWindowActive ? "★ " : "  ";
    let path = "/";
    try {
      path = new URL(tab.url).pathname || "/";
    } catch (_) {}
    let title = (tab.title || "").trim();
    if (title.length > 40) title = title.slice(0, 37) + "…";
    if (path.length > 22) path = path.slice(0, 20) + "…";
    return `${marker}${title || "(無題)"}  · ${path}`;
  }

  // ---- 3 社タブ束縛ドロップダウンの再取得 ---------------------
  async function refreshTabs() {
    $reloadTabs.disabled = true;
    try {
      for (const t of TAB_TARGETS) {
        const sel = $tabSelects[t.key];
        const prev = getBoundTabId(t.key);
        let response = null;
        try {
          response = await chrome.runtime.sendMessage({
            type: "list_ai_tabs",
            target: t.key,
          });
        } catch (e) {
          rtLog("error", `${t.label} タブ取得通信エラー: ${e && e.message ? e.message : e}`);
        }
        sel.innerHTML = "";
        const tabs = (response && response.ok && response.tabs) || [];
        const sameWindowCount = (response && response.sameWindowCount) || 0;
        if (tabs.length === 0) {
          const opt = document.createElement("option");
          opt.value = NO_TAB_VALUE;
          opt.textContent = `(${t.site} タブなし)`;
          opt.disabled = true;
          opt.selected = true;
          sel.appendChild(opt);
          continue;
        }
        // Step1.6: 同 window に対象タブが無ければプレースホルダを先頭に挿入し
        // 自動選択しない。Step3 自動進行で別 window の古いタブを掴む事故を防ぐ。
        if (sameWindowCount === 0) {
          const ph = document.createElement("option");
          ph.value = NO_TAB_VALUE;
          ph.textContent = `(同 window に ${t.site} タブ無し — 手動選択 or 該当 window で開く)`;
          ph.disabled = false;
          ph.selected = true;
          sel.appendChild(ph);
        }
        for (const tab of tabs) {
          const opt = document.createElement("option");
          opt.value = String(tab.id);
          opt.textContent = tabLabel(tab);
          opt.title = tab.url;
          sel.appendChild(opt);
        }
        if (sameWindowCount === 0) {
          rtLog(
            "warn",
            `${t.label}: 現在の Chrome ウィンドウに ${t.site} タブが無く、別 window に ${tabs.length} 件あり。誤選択防止のため自動選択をスキップ（手動 or 該当 window で開いて再読込）。`,
          );
          continue; // 自動選択しない（プレースホルダ選択のまま）
        }
        // 選択優先: 直前の選択を維持 → currentTabId（同window のとき）→ 同window 先頭
        let chosen = null;
        if (prev != null && tabs.some((x) => x.id === prev)) chosen = prev;
        else if (response.currentTabId != null) chosen = response.currentTabId;
        let selected = false;
        for (const opt of sel.options) {
          if (parseInt(opt.value, 10) === chosen) {
            opt.selected = true;
            selected = true;
            break;
          }
        }
        if (!selected) {
          // 同 window 候補ありの sort 先頭（= 同 window 最近タブ）を選択
          for (const opt of sel.options) {
            if (opt.value !== NO_TAB_VALUE) {
              opt.selected = true;
              break;
            }
          }
        }
      }
      rtLog("ok", "3 社のタブ一覧を再取得しました。各ドロップダウンで送信先を確認してください。");
    } finally {
      $reloadTabs.disabled = false;
    }
  }

  // ---- 3 タブ ping（到達性確認） -----------------------------
  async function pingTabs() {
    $pingTabs.disabled = true;
    try {
      for (const t of TAB_TARGETS) {
        const tabId = getBoundTabId(t.key);
        if (tabId == null) {
          rtLog("warn", `${t.label}: 送信先タブが未選択（${t.site} を開いて「3タブ再読込」）。`);
          continue;
        }
        try {
          const r = await chrome.runtime.sendMessage({
            type: "ping_ai",
            tabId,
            target: t.key,
          });
          if (r && r.ok) rtLog("ok", `${t.label} ping 到達 (tabId=${tabId}, url=${r.url})`);
          else rtLog("error", `${t.label} ping 失敗: ${r && r.error ? r.error : "(原因不明)"}`);
        } catch (e) {
          rtLog("error", `${t.label} ping 通信エラー: ${e && e.message ? e.message : e}`);
        }
      }
    } finally {
      $pingTabs.disabled = false;
    }
  }

  // ---- 議論スレッド描画 --------------------------------------
  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function renderThread() {
    $thread.innerHTML = "";
    if (!activeSession || !activeSession.turns.length) {
      const empty = document.createElement("div");
      empty.className = "rt-thread-empty";
      empty.textContent = activeSession
        ? "まだ発言がありません。下の入力欄から最初の発言を記録してください。"
        : "セッションがありません。「🆕 新規セッション」を押してください。";
      $thread.appendChild(empty);
      return;
    }
    for (const turn of activeSession.turns) {
      const meta = SPEAKER_META[turn.speaker] || { label: turn.speaker, emoji: "▫" };
      const row = document.createElement("div");
      row.className = `rt-turn rt-turn-${turn.speaker}`;

      const header = document.createElement("div");
      header.className = "rt-turn-header";
      const who = document.createElement("span");
      who.className = "rt-turn-who";
      who.textContent = `${meta.emoji} ${meta.label}`;
      const sub = document.createElement("span");
      sub.className = "rt-turn-sub";
      const parts = [fmtTime(turn.timestamp)];
      if (turn.metadata && turn.metadata.durationMs)
        parts.push(`${(turn.metadata.durationMs / 1000).toFixed(1)}秒`);
      if (turn.metadata && turn.metadata.model) parts.push(turn.metadata.model);
      sub.textContent = parts.join(" · ");
      header.appendChild(who);
      header.appendChild(sub);

      const body = document.createElement("div");
      body.className = "rt-turn-body";
      body.textContent = turn.content;

      row.appendChild(header);
      row.appendChild(body);
      $thread.appendChild(row);
    }
    $thread.scrollTop = $thread.scrollHeight;
  }

  function renderSessionInfo() {
    if (!activeSession) {
      $sessionInfo.textContent = "（セッションなし）";
      $title.value = "";
      return;
    }
    const n = activeSession.turns.length;
    let note = "";
    if (n > 50) note = " ⚠ 50ターン超: セッション分割を推奨";
    else if (n > 30) note = " ⚠ 30ターン超";
    $sessionInfo.textContent = `「${activeSession.title}」 · ${n} ターン${note}`;
    $title.value = activeSession.title;
  }

  function renderAll() {
    renderSessionInfo();
    renderThread();
  }

  // ---- イベント ----------------------------------------------
  async function onNewSession() {
    try {
      activeSession = await RTSession.createSession($title.value);
      rtLog("ok", `新規セッション開始: 「${activeSession.title}」 (id=${activeSession.id})`);
      renderAll();
    } catch (e) {
      rtLog("error", `セッション作成失敗: ${e && e.message ? e.message : e}`);
    }
  }

  // ---- Step2b: Kazuya 発言時の 3 社配信ヘルパ群 ---------------
  // 課題#7（裏タブスロットル）対処: 配信前に対象タブをアクティブ化して
  // visibilityState="visible" に。同 window 内で tab を切り替えるだけ
  // （windows.update は呼ばない）＝別 Chrome ウィンドウや別アプリへの
  // フォーカス奪取は無し。配信完了後は元のアクティブタブを復元する。
  async function activateTab(tabId) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      return true;
    } catch (_e) {
      return false;
    }
  }

  async function getCurrentlyActiveTabId() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0] ? tabs[0].id : null;
    } catch (_e) {
      return null;
    }
  }

  // 1 タブへ §5 待機指示（会議メタファ型）を送り、応答を Turn 化する。
  async function sendStandbyToTab(target, tabId, sessionId, kazuyaContent) {
    const text = RTPrompts.standbyPrompt(kazuyaContent);
    const settings = await loadRtSettings();
    const t0 = Date.now();
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: "send_to_ai",
        tabId,
        target,
        text,
        settings,
      });
    } catch (e) {
      return { ok: false, elapsed: Date.now() - t0, error: e && e.message ? e.message : String(e) };
    }
    const elapsed = Date.now() - t0;
    if (response && response.ok && response.responseText) {
      await RTSession.addTurn(sessionId, {
        speaker: target,
        content: response.responseText,
        metadata: {
          kind: "standby_ack",
          durationMs: elapsed,
          selector: response.responseSelector || null,
        },
      });
      return { ok: true, response, elapsed };
    }
    const err =
      (response && (response.responseError || response.error)) ||
      (response && response.busy ? "busy" : "no response");
    return { ok: false, elapsed, error: err };
  }

  // 対象社が §5 未投入なら初回投入を実行する。投入済み or 投入成功なら true、
  // 失敗なら false。Step2b の配信と Step3a の指名で共有する on-demand 初回投入。
  async function ensureInit(targetKey, tabId, sessionId, logTag) {
    const initKey = `${sessionId}:${tabId}`;
    if (initInjected.has(initKey)) return true;
    rtLog("info", `${logTag} ${labelOf(targetKey)}: §5 未投入 → 初回投入を送信…`);
    const ri = await sendInitToTab(targetKey, tabId, sessionId);
    if (ri.ok) {
      initInjected.add(initKey);
      const len = (ri.response.responseText || "").length;
      rtLog(
        "ok",
        `${logTag} ${labelOf(targetKey)}: 初回投入応答 ${len}字 / ${(ri.elapsed / 1000).toFixed(1)}秒`,
      );
      activeSession = await RTSession.getSession(sessionId);
      renderAll();
      return true;
    }
    rtLog("error", `${logTag} ${labelOf(targetKey)}: 初回投入失敗 — ${ri.error}`);
    return false;
  }

  // 3 社へ「Kazuya 発言＋§5 待機指示」を逐次配信。
  // 各社で未投入なら §5 初回投入を先に行い、その後 standby を送る。
  // 失敗社は自動スキップ（自動進行をハングさせない方針＝Step3 のスキップ予行演習）。
  async function broadcastStandbyToAll(kazuyaContent) {
    const sessionId = activeSession.id;
    const origTabId = await getCurrentlyActiveTabId();
    rtLog(
      "info",
      `[Step2b] 3 社へ §5 配信開始（タブを順にアクティブ化＝課題#7 回避、別 window/アプリへのフォーカス奪取なし）`,
    );
    let success = 0;
    let failed = 0;
    let skipped = 0;
    try {
      for (const t of TAB_TARGETS) {
        const tabId = getBoundTabId(t.key);
        if (tabId == null) {
          rtLog("warn", `[Step2b] ${t.label}: 送信先タブ未選択 → スキップ`);
          skipped++;
          continue;
        }
        // 課題#7 対処: 対象タブを active 化（同 window 内、windows.update は呼ばない）
        await activateTab(tabId);
        // 未投入なら §5 初回投入を先に
        const okInit = await ensureInit(t.key, tabId, sessionId, "[Step2b]");
        if (!okInit) {
          rtLog("error", `[Step2b] ${t.label}: 初回投入失敗のため待機指示もスキップして次の社へ`);
          failed++;
          continue;
        }
        // 待機指示を送る
        rtLog("info", `[Step2b] ${t.label}: 待機指示送信中…`);
        const rs = await sendStandbyToTab(t.key, tabId, sessionId, kazuyaContent);
        if (rs.ok) {
          const len = (rs.response.responseText || "").length;
          rtLog(
            "ok",
            `[Step2b] ${t.label}: 「了解」応答 ${len}字 / ${(rs.elapsed / 1000).toFixed(1)}秒`,
          );
          activeSession = await RTSession.getSession(sessionId);
          renderAll();
          success++;
        } else {
          rtLog(
            "error",
            `[Step2b] ${t.label}: 待機指示失敗 — ${rs.error}（自動スキップ）`,
          );
          failed++;
        }
      }
      rtLog(
        "ok",
        `[Step2b] 3 社配信完了: 成功 ${success} / 失敗 ${failed} / スキップ ${skipped}`,
      );
    } finally {
      // 配信後に元のタブを復元（Kazuya が見ていた場所へ戻す）
      if (origTabId != null) {
        const restored = await activateTab(origTabId);
        if (restored) {
          rtLog("info", `[Step2b] 元のタブ (tabId=${origTabId}) を再アクティブ化（パネル＋元タブの状態に復帰）`);
        }
      }
    }
  }

  async function onRecord() {
    const text = ($message.value || "").trim();
    if (!text) {
      rtLog("warn", "メッセージが空です。");
      return;
    }
    if (!activeSession) {
      // セッションが無ければ自動で 1 つ作る
      activeSession = await RTSession.createSession($title.value);
      rtLog("info", `セッションが無かったため自動作成: 「${activeSession.title}」`);
    }
    setTurnControlsDisabled(true);
    try {
      // ① Kazuya 発言を履歴に積む
      await RTSession.addTurn(activeSession.id, { speaker: "kazuya", content: text });
      activeSession = await RTSession.getSession(activeSession.id);
      $message.value = "";
      rtLog("ok", `Kazuya 発言を履歴に記録（計 ${activeSession.turns.length} ターン）`);
      renderAll();
      // ②③④ 3 社へ §5 配信（未投入なら初回投入を含む）
      await broadcastStandbyToAll(text);
    } catch (e) {
      rtLog("error", `発言/配信失敗: ${e && e.message ? e.message : e}`);
    } finally {
      setTurnControlsDisabled(false);
    }
  }

  async function onRenameTitle() {
    if (!activeSession) return;
    const t = ($title.value || "").trim();
    if (!t || t === activeSession.title) return;
    try {
      activeSession = await RTSession.renameSession(activeSession.id, t);
      rtLog("info", `セッション名を変更: 「${activeSession.title}」`);
      renderSessionInfo();
    } catch (e) {
      rtLog("error", `セッション名変更失敗: ${e && e.message ? e.message : e}`);
    }
  }

  // ---- Step2a: §5 初回投入の調査スパイク -----------------------
  // 既存 settings_key (side_panel.js が書く "roundtable_settings") を読んで
  // 無音/バックストップ TO を借用。新規 UI は足さない（最小スパイク）。
  async function loadRtSettings() {
    try {
      const r = await chrome.storage.local.get("roundtable_settings");
      const s = r["roundtable_settings"] || {};
      const sil =
        typeof s.silence_timeout_sec === "number" && s.silence_timeout_sec >= 1
          ? s.silence_timeout_sec
          : 30;
      const back =
        typeof s.backstop_timeout_sec === "number" && s.backstop_timeout_sec >= 1
          ? s.backstop_timeout_sec
          : 600;
      return {
        silence_timeout_sec: sil,
        backstop_timeout_ms: back * 1000,
      };
    } catch (_e) {
      return { silence_timeout_sec: 30, backstop_timeout_ms: 600000 };
    }
  }

  // 1 タブへ §5 初回投入を送り、応答を Turn として記録する。
  async function sendInitToTab(target, tabId, sessionId) {
    const text = RTPrompts.initialPrompt(target);
    const settings = await loadRtSettings();
    const t0 = Date.now();
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: "send_to_ai",
        tabId,
        target,
        text,
        settings,
      });
    } catch (e) {
      return { ok: false, elapsed: Date.now() - t0, error: e && e.message ? e.message : String(e) };
    }
    const elapsed = Date.now() - t0;
    if (response && response.ok && response.responseText) {
      await RTSession.addTurn(sessionId, {
        speaker: target,
        content: response.responseText,
        metadata: {
          kind: "init_ack",
          durationMs: elapsed,
          selector: response.responseSelector || null,
        },
      });
      return { ok: true, response, elapsed };
    }
    const err =
      (response && (response.responseError || response.error)) ||
      (response && response.busy ? "busy" : "no response");
    return { ok: false, elapsed, error: err };
  }

  // 3社へ §5 初回投入を逐次配信。投入済み(initInjected) は飛ばす。
  // Step2a の目的: 各社が初回投入を受け取って暴走しないか（長文応答に
  // 流れず、短い理解応答に留まるか）を Kazuya 目視で確認するためのスパイク。
  async function onStep2aInit() {
    if (!activeSession) {
      activeSession = await RTSession.createSession($title.value);
      rtLog("info", `セッションが無かったため自動作成: 「${activeSession.title}」`);
      renderAll();
    }
    setTurnControlsDisabled(true);
    rtLog("ok", "[Step2a] §5 初回投入を 3 社へ逐次配信開始（暴走しないか観察）");
    try {
      for (const t of TAB_TARGETS) {
        const tabId = getBoundTabId(t.key);
        if (tabId == null) {
          rtLog("warn", `[Step2a] ${t.label}: 送信先タブ未選択 → スキップ`);
          continue;
        }
        const key = `${activeSession.id}:${tabId}`;
        if (initInjected.has(key)) {
          rtLog("info", `[Step2a] ${t.label}: 投入済み (tabId=${tabId}) → スキップ`);
          continue;
        }
        rtLog("info", `[Step2a] ${t.label}: 初回投入送信中 (tabId=${tabId})…`);
        const r = await sendInitToTab(t.key, tabId, activeSession.id);
        if (r.ok) {
          initInjected.add(key);
          const len = (r.response.responseText || "").length;
          const sec = (r.elapsed / 1000).toFixed(1);
          rtLog(
            "ok",
            `[Step2a] ${t.label}: 応答 ${len}字 / ${sec}秒（selector=${r.response.responseSelector || "?"}）`,
          );
          activeSession = await RTSession.getSession(activeSession.id);
          renderAll();
        } else {
          rtLog(
            "error",
            `[Step2a] ${t.label}: 失敗 — ${r.error}（次の社へ続行）`,
          );
        }
      }
      rtLog(
        "ok",
        "[Step2a] 3 社配信完了。スレッドで各社の応答を確認し、暴走（長文/勝手な議論開始）が無いか目視判定してください。",
      );
    } finally {
      setTurnControlsDisabled(false);
    }
  }

  // ---- Step3a: 指名ターン制御 --------------------------------
  // 応答指示プロンプトに渡す議論履歴を Markdown 化する。
  //   含める: Kazuya 発言 + AI の本応答（metadata.kind==="response"）。
  //   除外  : init_ack / standby_ack（各社の「了解」相当＝議論の中身でない）。
  // 形式は既存 standbyPrompt と統一した `[話者]:` ブロック形式
  //   （§9 の絵文字見出しは人間向けエクスポート用なので使わない）。
  function buildHistoryMarkdown(session) {
    const turns = (session && session.turns) || [];
    const blocks = [];
    for (const turn of turns) {
      const kind = turn.metadata && turn.metadata.kind;
      const isKazuya = turn.speaker === "kazuya";
      const isResponse = kind === "response";
      if (!isKazuya && !isResponse) continue; // init_ack / standby_ack を除外
      const meta = SPEAKER_META[turn.speaker] || { label: turn.speaker };
      const label = isKazuya ? `${meta.label}（議長）` : meta.label;
      blocks.push(`[${label}]: ${turn.content}`);
    }
    return blocks.join("\n\n");
  }

  // 1 タブへ §5 応答指示（全履歴付き）を送り、応答を Turn(kind="response") 化する。
  // 履歴は送信直前の最新セッションから組み立てる（自動進行で直前の社の応答を
  // 反映できるように。Step3a の指名では単発だが、Step3b の自動進行で効く）。
  async function sendResponseToTab(target, tabId, sessionId) {
    const session = await RTSession.getSession(sessionId);
    const historyMarkdown = buildHistoryMarkdown(session);
    const text = RTPrompts.responsePrompt(historyMarkdown);
    const settings = await loadRtSettings();
    const t0 = Date.now();
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: "send_to_ai",
        tabId,
        target,
        text,
        settings,
      });
    } catch (e) {
      return { ok: false, elapsed: Date.now() - t0, error: e && e.message ? e.message : String(e) };
    }
    const elapsed = Date.now() - t0;
    if (response && response.ok && response.responseText) {
      await RTSession.addTurn(sessionId, {
        speaker: target,
        content: response.responseText,
        metadata: {
          kind: "response",
          durationMs: elapsed,
          selector: response.responseSelector || null,
        },
      });
      return { ok: true, response, elapsed };
    }
    const err =
      (response && (response.responseError || response.error)) ||
      (response && response.busy ? "busy" : "no response");
    return { ok: false, elapsed, error: err };
  }

  // 指名: 指定 1 社のタブにだけ応答指示を送る。
  //   他 2 社のタブには一切触れない（注入ゼロ・送信ゼロ）＝物理的に沈黙が保証。
  //   未投入なら §5 初回投入を先に行う（堅牢性優先・broadcast と共有）。
  //   課題#7 対処: 対象タブを一時アクティブ化し、完了後に元タブへ復帰。
  async function onNominate(targetKey) {
    if (!activeSession) {
      rtLog("warn", "セッションがありません。先に発言を記録してください。");
      return;
    }
    const target = targetOf(targetKey);
    const label = labelOf(targetKey);
    const site = (target && target.site) || targetKey;
    const tabId = getBoundTabId(targetKey);
    if (tabId == null) {
      rtLog("warn", `${label}: 送信先タブが未選択（${site} を開いて「3タブ再読込」）。指名できません。`);
      return;
    }
    setTurnControlsDisabled(true);
    const sessionId = activeSession.id;
    const origTabId = await getCurrentlyActiveTabId();
    rtLog(
      "info",
      `[Step3a] ${label} を指名 → 応答指示（全履歴付き）を送信。${label} のタブにのみ注入し、他 2 社には一切触れません。`,
    );
    try {
      // 課題#7 対処: 対象タブを active 化（同 window 内、windows.update は呼ばない）
      await activateTab(tabId);
      // 未投入なら §5 初回投入を先に
      const okInit = await ensureInit(targetKey, tabId, sessionId, "[Step3a]");
      if (!okInit) {
        rtLog("error", `[Step3a] ${label}: 初回投入失敗のため指名を中断`);
        return;
      }
      rtLog("info", `[Step3a] ${label}: 応答指示送信中…`);
      const rr = await sendResponseToTab(targetKey, tabId, sessionId);
      if (rr.ok) {
        const len = (rr.response.responseText || "").length;
        rtLog(
          "ok",
          `[Step3a] ${label}: 応答 ${len}字 / ${(rr.elapsed / 1000).toFixed(1)}秒（selector=${rr.response.responseSelector || "?"}）`,
        );
        activeSession = await RTSession.getSession(sessionId);
        renderAll();
      } else {
        rtLog("error", `[Step3a] ${label}: 応答取得失敗 — ${rr.error}`);
      }
    } catch (e) {
      rtLog("error", `[Step3a] ${label}: 指名処理失敗 — ${e && e.message ? e.message : e}`);
    } finally {
      // 配信後に元のタブを復元（Kazuya が見ていた場所へ戻す）
      if (origTabId != null) {
        const restored = await activateTab(origTabId);
        if (restored) {
          rtLog("info", `[Step3a] 元のタブ (tabId=${origTabId}) を再アクティブ化`);
        }
      }
      setTurnControlsDisabled(false);
    }
  }

  // ---- 初期化 ------------------------------------------------
  async function init() {
    $newSession.addEventListener("click", onNewSession);
    $record.addEventListener("click", onRecord);
    $reloadTabs.addEventListener("click", refreshTabs);
    $pingTabs.addEventListener("click", pingTabs);
    if ($step2aInit) $step2aInit.addEventListener("click", onStep2aInit);
    for (const key of Object.keys($nominate)) {
      if ($nominate[key]) $nominate[key].addEventListener("click", () => onNominate(key));
    }
    $title.addEventListener("change", onRenameTitle);
    // Enter=記録 / Shift+Enter=改行（IME 確定の Enter は除外。側 #message と同方針）
    $message.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      onRecord();
    });

    try {
      activeSession = await RTSession.getActiveSession();
    } catch (e) {
      rtLog("error", `アクティブセッション読込失敗: ${e && e.message ? e.message : e}`);
    }
    renderAll();
    if (activeSession) {
      rtLog(
        "info",
        `アクティブセッション復元: 「${activeSession.title}」（${activeSession.turns.length} ターン）。`,
      );
    }
    await refreshTabs();
  }

  init();
})();
