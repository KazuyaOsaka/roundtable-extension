#!/usr/bin/env node
// Runs Roundtable with SIMULATED participants so the UI and the turn engine
// can be tried without any AI service. Nothing here talks to Claude, ChatGPT
// or Gemini; results from this mode are not evidence about the real services.
//
//   npm run demo:mock            (data in a temp dir, ports 8787 / 8788)
//
// Simulated routes: "Claude" long-polls over MCP (2025 protocol), "ChatGPT"
// is woken by MCP Events webhooks (2026-07-28 protocol), "Gemini" uses the
// participant web page.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp } from "../src/app.js";
import { mcpClient, waitLoopParticipant, eventsParticipant, webParticipant } from "../test/mocks.js";

const dataDir = process.env.RT_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "rt-demo-"));
const ev = eventsParticipant("ChatGPT(模擬)");
const app = await startApp({
  dataDir,
  chairPort: Number(process.env.RT_CHAIR_PORT || 8787),
  participantPort: Number(process.env.RT_PARTICIPANT_PORT || 8788),
  poster: async (url, headers, body) => (await ev.receiver(url, headers, body)) || { status: 404, body: "" },
  log: () => {},
  env: { RT_WAIT_MAX_SEC: "5" },
});
const base = `http://127.0.0.1:${app.participantPort}`;
const url = (id) => `${base}/mcp/${app.config.tokens[id]}`;
const genMs = Number(process.env.DEMO_GEN_MS || 1500);

if (!app.rt.active || app.rt.active.status !== "open") {
  app.rt.createMeeting({
    title: "模擬デモ会議",
    topic: "（模擬）都市の夜間照明を半分にすると何が起きるか",
    settings: { triggerGraceSec: 1, wake: { claude: { wait: true, panel: false, events: false }, chatgpt: { wait: false, panel: false, events: true }, gemini: { wait: true } } },
  });
}
const claude = await mcpClient(url("claude"));
const chatgpt = await mcpClient(url("chatgpt"), { modern: true });
await ev.subscribe(chatgpt);
waitLoopParticipant(claude, "Claude(模擬)", { genMs, timeoutSec: 5 });
webParticipant(`${base}/p/${app.config.tokens.gemini}`, "Gemini(模擬)", { pollMs: genMs });

console.log(`模擬デモを起動しました（実サービスには接続していません）。
  議長画面: http://127.0.0.1:${app.chairPort}/
  データ: ${dataDir}
Ctrl+C で終了`);
process.on("SIGINT", async () => {
  await app.close();
  process.exit(0);
});
