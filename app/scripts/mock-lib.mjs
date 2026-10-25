// Shared by demo-mock.mjs and check-ui.mjs: a Roundtable instance with
// SIMULATED participants (no AI service is contacted).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp } from "../src/app.js";
import { mcpClient, waitLoopParticipant, eventsParticipant, webParticipant } from "../test/mocks.js";

export async function startMockDemo({ dataDir, chairPort = 8787, participantPort = 8788, genMs = 1500 } = {}) {
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "rt-demo-"));
  const ev = eventsParticipant("ChatGPT(模擬)");
  const app = await startApp({
    dataDir,
    chairPort,
    participantPort,
    poster: async (url, headers, body) => (await ev.receiver(url, headers, body)) || { status: 404, body: "" },
    log: () => {},
    env: { RT_WAIT_MAX_SEC: "5" },
  });
  const base = `http://127.0.0.1:${app.participantPort}`;
  const url = (id) => `${base}/mcp/${app.config.tokens[id]}`;
  if (!app.rt.active || app.rt.active.status !== "open") {
    app.rt.createMeeting({
      title: "模擬デモ会議",
      topic: "（模擬）都市の夜間照明を半分にすると何が起きるか",
      settings: { triggerGraceSec: 1, wake: { claude: { wait: true, panel: false, events: false }, chatgpt: { wait: false, panel: false, events: true }, gemini: { wait: true, web: true } } },
    });
  }
  const claude = await mcpClient(url("claude"));
  const chatgpt = await mcpClient(url("chatgpt"), { modern: true });
  await ev.subscribe(chatgpt);
  const loops = [waitLoopParticipant(claude, "Claude(模擬)", { genMs, timeoutSec: 5 }), webParticipant(`${base}/p/${app.config.tokens.gemini}`, "Gemini(模擬)", { pollMs: genMs })];
  return {
    app,
    dataDir,
    async close() {
      for (const l of loops) l.stopped = true;
      await app.close();
      await claude.close().catch(() => {});
      await chatgpt.close().catch(() => {});
    },
  };
}
