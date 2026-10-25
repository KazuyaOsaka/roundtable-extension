// Wires the core, the MCP endpoint, MCP Events, and the two HTTP listeners.
//
//   chair listener        127.0.0.1:<chairPort>        human UI + API (local only)
//   participant listener  127.0.0.1:<participantPort>  /mcp/<token>, /p/<token> (expose via tunnel)

import http from "node:http";
import crypto from "node:crypto";
import { EventStore } from "./core/store.js";
import { Roundtable } from "./core/engine.js";
import { AI_IDS } from "./core/presets.js";
import { EventHub } from "./mcp/events.js";
import { createMcpEndpoint } from "./mcp/server.js";
import { participantRoutes } from "./web/participant.js";
import { chairRoutes } from "./web/chair.js";

const newToken = () => crypto.randomBytes(18).toString("base64url");

export function loadConfig(store, env = process.env) {
  const cfg = store.readJson("config.json", null) || {};
  let changed = false;
  cfg.tokens = cfg.tokens || {};
  for (const id of AI_IDS) {
    if (!cfg.tokens[id]) {
      cfg.tokens[id] = newToken();
      changed = true;
    }
  }
  if (!cfg.chairToken) {
    cfg.chairToken = newToken();
    changed = true;
  }
  if (env.RT_PUBLIC_URL) cfg.publicUrl = env.RT_PUBLIC_URL.replace(/\/+$/, "");
  if (changed) store.writeJson("config.json", cfg, { mode: 0o600 });
  return cfg;
}

export async function startApp({
  dataDir,
  chairPort = 8787,
  participantPort = 8788,
  host = "127.0.0.1",
  now = () => Date.now(),
  poster,
  log = (m) => console.log(m),
  tickMs = 1000,
  env = process.env,
} = {}) {
  const store = new EventStore(dataDir);
  const config = loadConfig(store, env);
  const saveConfig = () => store.writeJson("config.json", config, { mode: 0o600 });
  const rt = new Roundtable({ store, now }).boot();
  for (const w of rt.warnings) log(`[store] ${w}`);

  const participantForToken = (token) => {
    if (typeof token !== "string") return null;
    for (const id of AI_IDS) {
      const t = config.tokens[id];
      if (t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) return id;
    }
    return null;
  };

  const hub = new EventHub({
    rt,
    store,
    now,
    poster,
    log,
    graceMs: () => (rt.active?.settings.triggerGraceSec ?? 8) * 1000,
  });
  const mcp = createMcpEndpoint({
    rt,
    hub,
    participantForToken,
    log,
    waitMaxSec: () => Number(env.RT_WAIT_MAX_SEC || 50),
  });

  const pHandler = participantRoutes({ rt, mcp, participantForToken });
  const participantServer = http.createServer((req, res) => {
    pHandler(req, res).catch((e) => {
      log(`[participant] ${e.stack || e.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // Long-polls must outlive the default Node request timeout.
  participantServer.requestTimeout = 0;
  participantServer.headersTimeout = 60_000;

  let chairServer;
  const rotateToken = (id) => {
    config.tokens[id] = newToken();
    saveConfig();
  };
  const cHandler = chairRoutes({ rt, hub, store, config, saveConfig, port: () => chairServer.address().port, rotateToken });
  chairServer = http.createServer((req, res) => {
    cHandler(req, res).catch((e) => {
      log(`[chair] ${e.stack || e.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise((r) => participantServer.listen(participantPort, host, r));
  await new Promise((r) => chairServer.listen(chairPort, "127.0.0.1", r));

  const ticker = setInterval(() => {
    try {
      rt.tick();
    } catch (e) {
      log(`[tick] ${e.stack || e.message}`);
    }
  }, tickMs);
  ticker.unref?.();

  return {
    rt,
    hub,
    store,
    config,
    chairPort: chairServer.address().port,
    participantPort: participantServer.address().port,
    async close() {
      clearInterval(ticker);
      hub.close();
      chairServer.closeAllConnections?.();
      participantServer.closeAllConnections?.();
      await new Promise((r) => chairServer.close(r));
      await new Promise((r) => participantServer.close(r));
      store.close();
    },
  };
}
