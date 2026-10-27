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

import { startMockDemo } from "./mock-lib.mjs";

const demo = await startMockDemo({
  dataDir: process.env.RT_DATA_DIR,
  chairPort: Number(process.env.RT_CHAIR_PORT || 8787),
  participantPort: Number(process.env.RT_PARTICIPANT_PORT || 8788),
  genMs: Number(process.env.DEMO_GEN_MS || 1500),
});
console.log(`模擬デモを起動しました（実サービスには接続していません）。
  議長画面: http://127.0.0.1:${demo.app.chairPort}/
  データ: ${demo.dataDir}
Ctrl+C で終了`);
process.on("SIGINT", async () => {
  await demo.close();
  process.exit(0);
});
