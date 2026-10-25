// Participant-side HTTP routes (the only routes meant to be exposed through
// a tunnel): the MCP endpoint and a plain web page for AIs that take part
// through an official browsing agent instead of MCP.
//
//   /mcp/<token>            MCP (Streamable HTTP, 2026-07-28 and 2025 stateless)
//   /p/<token>              participant page (read the turn, post with a form)
//   /p/<token>/turn.txt     the current turn as plain text
//   /healthz

import { toNodeHandler } from "@modelcontextprotocol/node";
import { CommandError } from "../core/engine.js";
import { DISPLAY_NAMES } from "../core/presets.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function page(title, body, { refreshSec } = {}) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ""}<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>body{font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;max-width:860px;margin:0 auto;padding:16px;color:#1d1d1f;background:#fff}
pre{white-space:pre-wrap;background:#f5f5f7;padding:12px;border-radius:8px;border:1px solid #ddd}
textarea{width:100%;min-height:220px;font:inherit;padding:8px;box-sizing:border-box}
.status{font-size:20px;font-weight:700;margin:8px 0}.muted{color:#666}button{font:inherit;padding:8px 18px}</style></head>
<body>${body}</body></html>`;
}

export function participantRoutes({ rt, mcp, participantForToken }) {
  const nodeHandlers = new Map();

  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }

    if (parts[0] === "mcp" && parts.length === 2) {
      const h = mcp.handlerFor(parts[1]);
      if (!h) {
        res.writeHead(404);
        return res.end();
      }
      if (!nodeHandlers.has(h.participant)) nodeHandlers.set(h.participant, toNodeHandler(h.handler));
      return nodeHandlers.get(h.participant)(req, res);
    }

    if (parts[0] === "p" && parts.length >= 2) {
      const participant = participantForToken(parts[1]);
      if (!participant) {
        res.writeHead(404);
        return res.end();
      }
      const base = `/p/${parts[1]}`;
      const name = DISPLAY_NAMES[participant];
      try {
        if (parts.length === 3 && parts[2] === "turn.txt" && req.method === "GET") {
          const d = rt.deliver(participant, "web");
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          return res.end(d.status === "your_turn" ? `STATUS: YOUR_TURN\nREQUEST_ID: ${d.request.id}\n\n${d.text}` : `STATUS: ${d.status.toUpperCase()}`);
        }
        if (parts.length === 3 && parts[2] === "post" && req.method === "POST") {
          const form = new URLSearchParams(await readBody(req));
          const r = rt.post(participant, { requestId: form.get("request_id"), text: form.get("text") || "", via: "web" });
          res.writeHead(303, { location: `${base}?posted=${encodeURIComponent(r.status)}&seq=${r.seq ?? ""}` });
          return res.end();
        }
        if (parts.length === 2 && req.method === "GET") {
          const d = rt.deliver(participant, "web");
          const posted = url.searchParams.get("posted");
          const notice = posted
            ? `<p class="muted">前回の投稿: ${esc({ accepted: "受け付けました", duplicate: "重複のため無視しました", stale: "旧前提として記録（転送なし）", late: "期限後として記録（転送なし）" }[posted] || posted)}${url.searchParams.get("seq") ? `（#${esc(url.searchParams.get("seq"))}）` : ""}</p>`
            : "";
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          if (d.status === "your_turn") {
            return res.end(
              page(
                `Roundtable — ${name} の番`,
                `<h1>Roundtable 参加者ページ（${esc(name)}）</h1>${notice}
<div class="status" id="status">STATUS: YOUR_TURN — あなたの番です（依頼 ${esc(d.request.id)}）</div>
<pre id="request">${esc(d.text)}</pre>
<form method="post" action="${base}/post">
<input type="hidden" name="request_id" value="${esc(d.request.id)}">
<label for="text">あなたの発言（この欄に本文を入力し「投稿する」を押してください）</label><br>
<textarea id="text" name="text" required></textarea><br>
<button type="submit">投稿する</button>
</form>`,
              ),
            );
          }
          const msg = {
            not_your_turn: "STATUS: WAITING — 今はあなたの番ではありません。このページは20秒ごとに自動で再読み込みされます。",
            meeting_ended: "STATUS: MEETING_ENDED — 会議は終了しました。これ以上の操作は不要です。",
            no_meeting: "STATUS: NO_MEETING — 進行中の会議はありません。",
          }[d.status];
          return res.end(page(`Roundtable — ${name}`, `<h1>Roundtable 参加者ページ（${esc(name)}）</h1>${notice}<div class="status" id="status">${esc(msg)}</div>`, { refreshSec: d.status === "not_your_turn" ? 20 : 0 }));
        }
      } catch (e) {
        if (e instanceof CommandError) {
          res.writeHead(e.code === "forbidden" ? 403 : 400, { "content-type": "text/html; charset=utf-8" });
          return res.end(page("Roundtable", `<div class="status">ERROR: ${esc(e.message)}</div><p><a href="${base}">戻る</a></p>`));
        }
        throw e;
      }
    }

    res.writeHead(404);
    res.end();
  };
}
