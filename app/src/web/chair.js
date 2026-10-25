// Chair (human) routes. Served only on 127.0.0.1 and never through the
// tunnel. Every state-changing request needs the per-install chair token in
// a header (blocks cross-site requests from other pages in the browser), and
// the Host header must be localhost (blocks DNS rebinding).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CommandError } from "../core/engine.js";
import { exportMarkdown } from "../core/render.js";
import { setupInfo } from "../core/setup.js";
import { ROLE_PRESETS, PHASE_PRESETS, AI_IDS } from "../core/presets.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new CommandError("bad_input", "リクエストが大きすぎます"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new CommandError("bad_input", "JSON が不正です"));
      }
    });
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function chairRoutes({ rt, hub, store, config, saveConfig, port, rotateToken }) {
  const allowedHost = (h) => {
    const p = typeof port === "function" ? port() : port;
    return [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`].includes(h);
  };
  const clients = new Set();
  let pending = null;
  rt.on("event", () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast();
    }, 50);
  });
  const heartbeat = setInterval(broadcast, 5000);
  heartbeat.unref?.();

  function state() {
    const snap = rt.snapshot();
    return {
      ...snap,
      setup: setupInfo({ publicUrl: config.publicUrl, tokens: config.tokens, meeting: rt.active }),
      publicUrl: config.publicUrl || "",
      subscriptions: hub.summary(),
      presets: { roles: ROLE_PRESETS, phases: Object.fromEntries(Object.entries(PHASE_PRESETS).map(([k, v]) => [k, { name: v.name }])) },
      presence: Object.fromEntries(AI_IDS.map((id) => [id, { lastClient: rt.presence[id].lastClient || null }])),
    };
  }

  function broadcast() {
    if (!clients.size) return;
    const data = `data: ${JSON.stringify(state())}\n\n`;
    for (const res of clients) res.write(data);
  }

  const actions = {
    meeting: (b) => rt.createMeeting(b),
    premise: (b) => rt.updatePremise(b),
    role: (b) => rt.updateRole(b.participant, b.preset ? b.preset : { name: b.name, text: b.text, preset: "custom" }),
    order: (b) => rt.updateOrder(b.order),
    members: (b) => rt.updateMembers(b.members),
    settings: (b) => rt.updateSettings(b),
    post: (b) => rt.chairPost(b),
    auto: (b) => rt.startAuto(b),
    probe: (b) => rt.startProbe(b),
    pause: () => rt.pause(),
    resume: () => rt.resume(),
    stop: () => rt.stop(),
    end: () => rt.endMeeting(),
    skip: (b) => rt.skip(b.requestId),
    retrigger: (b) => rt.authorizeRetrigger(b.requestId),
    summary: (b) => rt.addSummary(b.messageId, b.text),
    adopt: (b) => rt.adopt(b.messageId),
    hypothesis: (b) => rt.saveHypothesis(b),
    observation: (b) => rt.recordObservation(b.participant, b.fields || {}),
    config: (b) => {
      const u = String(b.publicUrl || "").trim();
      if (u) {
        let parsed;
        try {
          parsed = new URL(u);
        } catch {
          throw new CommandError("bad_input", "URL の形式が正しくありません");
        }
        if (parsed.protocol !== "https:") throw new CommandError("bad_input", "公開URLは https:// で始まる必要があります（各社の接続要件）");
      }
      config.publicUrl = u.replace(/\/+$/, "");
      saveConfig();
    },
    "rotate-token": (b) => {
      if (!AI_IDS.includes(b.participant)) throw new CommandError("bad_input", "不明な参加者");
      rotateToken(b.participant);
    },
  };

  return async function handle(req, res) {
    if (!allowedHost(req.headers.host || "")) {
      res.writeHead(421, { "content-type": "text/plain" });
      return res.end("This server only answers on localhost.");
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state());
      if (req.method === "GET" && url.pathname === "/api/stream") {
        if (!safeEqual(url.searchParams.get("k"), config.chairToken)) return json(res, 403, { error: "forbidden" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/export.md") {
        const m = rt.requireActive();
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${m.id}.md"` });
        return res.end(exportMarkdown(m));
      }
      if (req.method === "GET" && url.pathname === "/api/export.json") {
        const m = rt.requireActive();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${m.id}.json"` });
        return res.end(JSON.stringify(rt.exportJson(), null, 2));
      }
      if (req.method === "GET" && url.pathname === "/api/probe-report") return json(res, 200, { reports: rt.probeReport() });
      if (req.method === "GET" && url.pathname === "/api/log") {
        const m = rt.active;
        if (!m) return json(res, 200, { events: [] });
        const limit = Math.min(Number(url.searchParams.get("limit") || 300), 2000);
        // Raw text of rejected posts stays in the file; the log view shows lengths only.
        const events = store.load(m.id).events.slice(-limit).map((e) => (e.type === "post_rejected" ? { ...e, data: { ...e.data, text: e.data.text == null ? null : `（${e.data.text.length}字）` } } : e));
        return json(res, 200, { events });
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        if (!safeEqual(req.headers["x-roundtable-chair"], config.chairToken)) return json(res, 403, { error: "forbidden", message: "議長トークンがありません" });
        const name = url.pathname.slice("/api/".length);
        const fn = actions[name];
        if (!fn) return json(res, 404, { error: "not_found" });
        const body = await readJsonBody(req);
        const out = fn(body);
        broadcast();
        return json(res, 200, { ok: true, result: out && out.id && out.title ? { id: out.id } : out ?? null });
      }

      if (req.method === "GET") {
        let rel = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = path.normalize(path.join(PUBLIC_DIR, rel));
        if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "not_found" });
        let content = fs.readFileSync(file);
        if (rel === "/index.html") content = Buffer.from(content.toString("utf8").replace("__CHAIR_TOKEN__", config.chairToken));
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        return res.end(content);
      }
      return json(res, 405, { error: "method_not_allowed" });
    } catch (e) {
      if (e instanceof CommandError) return json(res, e.code === "forbidden" ? 403 : 400, { error: e.code, message: e.message });
      console.error(e);
      return json(res, 500, { error: "internal", message: e.message });
    }
  };
}
