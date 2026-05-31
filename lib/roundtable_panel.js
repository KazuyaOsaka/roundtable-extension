// lib/roundtable_panel.js — Roundtable サイドパネルの Phase 4 制御
// ============================================================
// Phase 4 Step1（このファイルの現在範囲）:
//   - セッション管理（新規作成 / アクティブ表示 / ターン数）
//   - 3 社タブ束縛 UI（Claude / ChatGPT / Gemini の送信先タブを各 1 つ）
//   - 3 タブ ping（到達性確認）
//   - 議論スレッドの最小表示（時系列・発言者ラベル・本文）
//   - Kazuya 発言を履歴に記録（Step1 検証用。Step2 で 3 タブ配信、
//     Step3 でターン制御の応答トリガを足す）
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
  const $tabSelects = {
    gemini: document.getElementById("rt-tab-gemini"),
    chatgpt: document.getElementById("rt-tab-chatgpt"),
    claude: document.getElementById("rt-tab-claude"),
  };

  const NO_TAB_VALUE = "__none__";

  // ---- runtime 状態 ------------------------------------------
  let activeSession = null;
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
        if (tabs.length === 0) {
          const opt = document.createElement("option");
          opt.value = NO_TAB_VALUE;
          opt.textContent = `(${t.site} タブなし)`;
          opt.disabled = true;
          opt.selected = true;
          sel.appendChild(opt);
          continue;
        }
        for (const tab of tabs) {
          const opt = document.createElement("option");
          opt.value = String(tab.id);
          opt.textContent = tabLabel(tab);
          opt.title = tab.url;
          sel.appendChild(opt);
        }
        // 選択優先: 直前の選択を維持 → currentTabId → 先頭
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
        if (!selected && sel.options.length) sel.options[0].selected = true;
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

  async function onRecord() {
    const text = ($message.value || "").trim();
    if (!text) {
      rtLog("warn", "メッセージが空です。");
      return;
    }
    if (!activeSession) {
      // セッションが無ければ自動で 1 つ作る（Step1 の利便性）
      activeSession = await RTSession.createSession($title.value);
      rtLog("info", `セッションが無かったため自動作成: 「${activeSession.title}」`);
    }
    try {
      await RTSession.addTurn(activeSession.id, { speaker: "kazuya", content: text });
      activeSession = await RTSession.getSession(activeSession.id);
      $message.value = "";
      rtLog("ok", `Kazuya 発言を履歴に記録（計 ${activeSession.turns.length} ターン）。`);
      renderAll();
    } catch (e) {
      rtLog("error", `発言記録失敗: ${e && e.message ? e.message : e}`);
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

  // ---- 初期化 ------------------------------------------------
  async function init() {
    $newSession.addEventListener("click", onNewSession);
    $record.addEventListener("click", onRecord);
    $reloadTabs.addEventListener("click", refreshTabs);
    $pingTabs.addEventListener("click", pingTabs);
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
