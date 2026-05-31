// lib/session_store.js — Roundtable のセッション/ターン永続化レイヤ（Phase 4 Step1）
// ============================================================
// 役割:
//   - 仕様書§7 のデータモデル（Session / Turn）を chrome.storage.local に永続化
//   - 議論履歴の CRUD（作成 / 取得 / ターン追加 / 一覧 / 削除 / アクティブ切替）
//
// 設計（Phase 4 アーキ判断、status doc 参照）:
//   - ターン制御オーケストレーションはサイドパネル駆動だが、議論「内容」は
//     ここで storage に永続化する。よってパネルを閉じても履歴は残る。
//   - タブ束縛（どの tabId がどの社か）と §5 初回投入済みフラグは「内容」では
//     なく runtime ルーティング状態なので Session には保存しない（tabId は
//     ブラウザ再起動で変わるため）。roundtable_panel.js が runtime で保持する。
//   - content_scripts / background.js / side_panel.js には一切依存しない
//     自己完結モジュール（古い送信パイプラインへのリグレッション源にならない）。
//
// グローバル公開: window.RTSession（side_panel.html で classic script として
// session_store.js → side_panel.js → roundtable_panel.js の順にロード）。
// ============================================================

window.RTSession = (function () {
  const SESSION_PREFIX = "rt_session_";
  const ACTIVE_KEY = "rt_active_session";

  // 仕様書§7 participants / §8 デフォルトターン順（Gemini → ChatGPT → Claude）
  const PARTICIPANTS = ["claude", "chatgpt", "gemini"];
  const DEFAULT_ORDER = ["gemini", "chatgpt", "claude"];
  const SPEAKERS = ["kazuya", "claude", "chatgpt", "gemini"];

  function uid(prefix) {
    return (
      prefix +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function defaultTitle(ts) {
    const d = new Date(ts);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return `議論 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ------------------------------------------------------------
  // Session CRUD
  // ------------------------------------------------------------
  async function createSession(title, origin) {
    const id = uid("s");
    const now = Date.now();
    const session = {
      id,
      title: (title && title.trim()) || defaultTitle(now),
      participants: [...PARTICIPANTS],
      turns: [],
      defaultOrder: [...DEFAULT_ORDER],
      createdAt: now,
      updatedAt: now,
      origin: origin || { type: "new" },
    };
    await chrome.storage.local.set({
      [SESSION_PREFIX + id]: session,
      [ACTIVE_KEY]: id,
    });
    return session;
  }

  async function getSession(id) {
    if (!id) return null;
    const r = await chrome.storage.local.get(SESSION_PREFIX + id);
    return r[SESSION_PREFIX + id] || null;
  }

  async function getActiveId() {
    const r = await chrome.storage.local.get(ACTIVE_KEY);
    return r[ACTIVE_KEY] || null;
  }

  async function getActiveSession() {
    const id = await getActiveId();
    return id ? await getSession(id) : null;
  }

  async function setActive(id) {
    await chrome.storage.local.set({ [ACTIVE_KEY]: id });
  }

  async function listSessions() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(SESSION_PREFIX))
      .map((k) => all[k])
      .filter((s) => s && s.id)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function renameSession(id, title) {
    const session = await getSession(id);
    if (!session) throw new Error("session not found: " + id);
    session.title = (title && title.trim()) || session.title;
    session.updatedAt = Date.now();
    await chrome.storage.local.set({ [SESSION_PREFIX + id]: session });
    return session;
  }

  async function deleteSession(id) {
    await chrome.storage.local.remove(SESSION_PREFIX + id);
    const active = await getActiveId();
    if (active === id) await chrome.storage.local.remove(ACTIVE_KEY);
  }

  // ------------------------------------------------------------
  // Turn 追加（仕様書§7 Turn）。speaker は SPEAKERS のいずれか。
  // metadata は { model?, durationMs?, error? }（best-effort、未指定可）。
  // ------------------------------------------------------------
  async function addTurn(sessionId, { speaker, content, metadata }) {
    if (!SPEAKERS.includes(speaker)) {
      throw new Error("invalid speaker: " + speaker);
    }
    const session = await getSession(sessionId);
    if (!session) throw new Error("session not found: " + sessionId);
    const turn = {
      id: uid("t"),
      sessionId,
      speaker,
      content: content || "",
      timestamp: Date.now(),
      metadata: metadata || {},
    };
    session.turns.push(turn);
    session.updatedAt = turn.timestamp;
    await chrome.storage.local.set({ [SESSION_PREFIX + sessionId]: session });
    return turn;
  }

  return {
    PARTICIPANTS,
    DEFAULT_ORDER,
    SPEAKERS,
    createSession,
    getSession,
    getActiveId,
    getActiveSession,
    setActive,
    listSessions,
    renameSession,
    deleteSession,
    addTurn,
  };
})();
