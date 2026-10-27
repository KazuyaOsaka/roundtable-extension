// The Roundtable panel: an MCP App (interactive UI) shown inside the AI's
// chat. It polls the server through the host (app-only tools) and, when this
// participant's turn is waiting undelivered, sends one `ui/message` into the
// chat so the AI starts its next turn. Whether a host lets an app start a
// turn this way without a click is exactly what the connection probe tests.

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedBundle = null;

// The official MCP Apps SDK ships a self-contained ESM bundle. The panel runs
// in a sandboxed iframe that may not load external scripts, so the bundle is
// inlined; its trailing `export {...}` is turned into a global.
function appBundle() {
  if (cachedBundle) return cachedBundle;
  let src = fs.readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const i = src.lastIndexOf("export{");
  if (i < 0) throw new Error("unexpected ext-apps bundle format");
  const exportList = src.slice(i + "export{".length, src.indexOf("}", i));
  const pairs = exportList.split(",").map((p) => {
    const [local, , exported] = p.trim().split(/\s+/);
    return `${exported || local}:${local}`;
  });
  src = src.slice(0, i) + `window.McpApps={${pairs.join(",")}};` + src.slice(src.indexOf("}", i) + 1);
  if (src.includes("</script")) src = src.replaceAll("</script", "<\\/script");
  cachedBundle = src;
  return src;
}

export const PANEL_URI = "ui://roundtable/panel-v1.html";

export function panelHtml() {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roundtable</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6b6b70; --line: #d9d9de; --accent: #2f6fde; --warn: #b3261e; --ok: #1b7f3b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #a0a0a8; --line: #3a3a40; --accent: #7aa7ff; --warn: #ff8a80; --ok: #6fd08c; } }
  body { margin: 0; font: 13px/1.5 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; color: var(--fg); background: transparent; }
  .wrap { padding: 10px 12px; }
  h1 { font-size: 13px; margin: 0 0 4px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  .muted { color: var(--muted); }
  .pill { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
  .turn { color: var(--accent); font-weight: 600; }
  .err { color: var(--warn); }
  .ok { color: var(--ok); }
  button { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  #log { max-height: 90px; overflow: auto; font-size: 11px; border-top: 1px solid var(--line); margin-top: 6px; padding-top: 4px; }
</style></head>
<body><div class="wrap">
  <h1>Roundtable 会議パネル</h1>
  <div class="row"><span id="title" class="muted">接続中…</span></div>
  <div class="row"><span id="state" class="pill">—</span><span id="req" class="muted"></span></div>
  <div class="row">
    <label><input type="checkbox" id="auto" checked> 番が来たら自動で通知</label>
    <button id="manual" disabled>今すぐ通知（手動）</button>
  </div>
  <div id="note" class="muted">このパネルが表示されている間だけ、次の番を通知できます。タブを閉じたり長時間非表示にすると通知が遅れるか止まります。</div>
  <div id="log"></div>
</div>
<script>${appBundle()}</script>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const log = (t, cls) => { const d = document.createElement("div"); d.textContent = new Date().toLocaleTimeString() + " " + t; if (cls) d.className = cls; $("log").prepend(d); };
  const instanceId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
  const { App } = window.McpApps;
  const app = new App({ name: "Roundtable Panel", version: "0.1.0" }, {});
  let current = null, busy = false, failures = 0;

  const call = async (name, args) => {
    const r = await app.callServerTool({ name, arguments: args });
    if (r.isError) throw new Error((r.content && r.content[0] && r.content[0].text) || "tool error");
    return r.structuredContent || {};
  };

  function render(s) {
    current = s;
    $("title").textContent = s.title ? "会議: " + s.title : "会議はありません";
    const st = s.status === "ended" ? "会議終了" : s.request ? (s.request.delivered ? "あなたの依頼を処理中" : "あなたの番（未受信）") : "待機中";
    $("state").textContent = st;
    $("state").className = "pill" + (s.request && !s.request.delivered ? " turn" : "");
    $("req").textContent = s.request ? "依頼 " + s.request.id + (s.request.phase ? "・" + s.request.phase : "") : "";
    $("manual").disabled = !(s.request && !s.request.delivered) || busy;
  }

  async function wake(manual) {
    if (busy || !current || !current.request) return;
    busy = true;
    const requestId = current.request.id;
    try {
      const c = await call("panel_claim_wake", { request_id: requestId, instance_id: instanceId, manual });
      if (!c.granted) { log("通知しません（" + c.reason + "）"); return; }
      let result = "unknown", detail = "";
      try {
        const res = await Promise.race([
          app.sendMessage({ role: "user", content: [{ type: "text", text: c.message }] }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15000)),
        ]);
        result = res && res.isError ? "rejected" : "sent";
      } catch (e) { result = "unknown"; detail = String(e && e.message || e); }
      log("通知 " + requestId + ": " + result + (detail ? " (" + detail + ")" : ""), result === "sent" ? "ok" : "err");
      await call("panel_report_wake", { request_id: requestId, instance_id: instanceId, result, detail }).catch(() => {});
    } catch (e) {
      log("通知エラー: " + e.message, "err");
    } finally { busy = false; }
  }

  async function poll() {
    try {
      const s = await call("panel_poll", { instance_id: instanceId });
      failures = 0;
      render(s);
      if ($("auto").checked && s.should_trigger) await wake(false);
      if (s.status === "ended") { log("会議は終了しました"); return; }
    } catch (e) {
      failures++;
      log("サーバーに接続できません: " + e.message, "err");
    }
    setTimeout(poll, Math.min(4000 * Math.max(1, failures), 60000));
  }

  $("manual").addEventListener("click", () => wake(true));
  app.ontoolresult = (r) => { if (r && r.structuredContent && r.structuredContent.title !== undefined) render(r.structuredContent); };
  document.addEventListener("visibilitychange", () => log("表示状態: " + document.visibilityState));
  try {
    await app.connect();
    log("パネル起動 " + instanceId);
    poll();
  } catch (e) {
    $("title").textContent = "ホストに接続できませんでした";
    log(String(e && e.message || e), "err");
  }
})();
</script></body></html>`;
}
