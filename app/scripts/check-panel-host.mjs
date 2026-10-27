#!/usr/bin/env node
// Runs the real Roundtable panel (the MCP App HTML served by resources/read)
// inside Chromium, hosted by the OFFICIAL MCP Apps host SDK (AppBridge from
// @modelcontextprotocol/ext-apps). Checks the panel's protocol behaviour:
// handshake, app-only tool calls through the host, and exactly one
// `ui/message` wake-up per request.
//
// This verifies Roundtable's side only. Whether claude.ai / ChatGPT accept a
// `ui/message` without a user click is decided by those hosts, not by this.
//
//   npm run check:panel   (needs Playwright + Chromium: `npx playwright install chromium`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { startApp } from "../src/app.js";
import { mcpClient, answerOnce, sleep } from "../test/mocks.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));

const hostBundle = await build({
  stdin: {
    contents: `import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"; window.AppBridge = AppBridge; window.PostMessageTransport = PostMessageTransport;`,
    resolveDir: path.join(here, ".."),
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  logLevel: "silent",
});
const hostJs = hostBundle.outputFiles[0].text;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-panel-"));
const app = await startApp({ dataDir, chairPort: 0, participantPort: 0, log: () => {}, tickMs: 100 });
const rt = app.rt;
rt.createMeeting({ topic: "パネル試験", settings: { triggerGraceSec: 1, wake: { claude: { wait: false, panel: true, events: false } } } });
const mcpUrl = `http://127.0.0.1:${app.participantPort}/mcp/${app.config.tokens.claude}`;
const toolsClient = await mcpClient(mcpUrl); // the host's connection to the server
const modelClient = await mcpClient(mcpUrl); // stands in for the model's own tool calls

const html = (await toolsClient.readResource({ uri: "ui://roundtable/panel-v1.html" })).contents[0].text;
const opened = await toolsClient.callTool({ name: "open_roundtable_panel", arguments: {} });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const messages = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.exposeFunction("hostCallTool", async (params) => toolsClient.callTool(params));
await page.exposeFunction("hostOnMessage", async (params) => {
  const text = params.content?.map((c) => c.text).join("") || "";
  messages.push(text);
  // A model receiving this message would start a turn and use the tools:
  const id = (text.match(/request_id="([^"]+)"/) || [])[1];
  setTimeout(() => answerOnce(modelClient, "Claude(模擬)", id).catch((e) => errors.push(e.message)), 50);
  return {};
});
await page.setContent(`<!doctype html><body><iframe id="f" sandbox="allow-scripts" style="width:600px;height:300px"></iframe><script>${hostJs}</script></body>`);
await page.evaluate(async ({ html, opened }) => {
  const iframe = document.getElementById("f");
  const bridge = new window.AppBridge(null, { name: "check-host", version: "1" }, { serverTools: {}, message: { text: {} }, logging: {} });
  bridge.oncalltool = (params) => window.hostCallTool(params);
  bridge.onmessage = (params) => window.hostOnMessage(params);
  bridge.oninitialized = () => bridge.sendToolResult(opened);
  const ready = bridge.connect(new window.PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  iframe.srcdoc = html;
  await ready;
}, { html, opened });

const results = {};
try {
  await sleep(1500);
  rt.chairPost({ text: "パネル経由で答えてください", ask: "claude" });
  for (let i = 0; i < 100 && !rt.active.messages.some((x) => x.speaker === "claude"); i++) await sleep(100);
  results.firstAnswered = rt.active.messages.some((x) => x.speaker === "claude" && x.status === "accepted");
  // second turn after the first task "ended"
  rt.chairPost({ text: "もう一度お願いします", ask: "claude" });
  for (let i = 0; i < 100 && rt.active.messages.filter((x) => x.speaker === "claude").length < 2; i++) await sleep(100);
  results.secondAnswered = rt.active.messages.filter((x) => x.speaker === "claude" && x.status === "accepted").length === 2;
  await sleep(1500); // would a duplicate wake-up be sent?
  results.wakeMessages = messages.length;
  const reqs = rt.active.requestOrder.map((id) => rt.active.requests[id]);
  results.panelTriggersPerRequest = reqs.map((r) => r.triggers.filter((t) => t.channel === "panel").length);
  results.triggerResults = reqs.map((r) => r.triggers.map((t) => t.result));
  results.panelText = await page.frameLocator("#f").locator("body").innerText();
} finally {
  results.errors = errors;
  await browser.close();
  await toolsClient.close();
  await modelClient.close();
  await app.close();
}
const ok = results.firstAnswered && results.secondAnswered && results.wakeMessages === 2 && results.panelTriggersPerRequest.every((n) => n === 1) && results.triggerResults.flat().every((r) => r === "sent") && !results.errors.length;
console.log(JSON.stringify(results, null, 2));
console.log(ok ? "PANEL CHECK: OK" : "PANEL CHECK: FAILED");
process.exit(ok ? 0 : 1);
