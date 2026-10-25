#!/usr/bin/env node
// Drives the chair UI in Chromium against SIMULATED participants:
// ask all → auto run → interrupt → resume → completion, a connection probe,
// a chain test with a stop during generation, reload restore, phone width.
//
//   npm run check:ui   (needs Playwright + Chromium: `npx playwright install chromium`)
//   SHOTS_DIR=/some/dir npm run check:ui   to also save screenshots

import { createRequire } from "node:module";
import { startMockDemo } from "./mock-lib.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const shots = process.env.SHOTS_DIR;
const demo = await startMockDemo({ chairPort: 0, participantPort: 0, genMs: 600 });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shot = (name) => (shots ? page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }) : null);
const out = {};
try {
  await page.goto(`http://127.0.0.1:${demo.app.chairPort}/`);
  await page.waitForSelector("#meetingView:not(.hidden)");
  await page.fill("#chairText", "まず各自、最大の影響を一つ挙げてください。");
  await page.click('[data-ask="all"]');
  await page.waitForFunction(() => document.querySelectorAll(".msg.gemini, .msg.chatgpt, .msg.claude").length >= 3, null, { timeout: 30000 });
  out.askAll = true;
  await page.fill("#autoTurns", "6");
  await page.click("#startAuto");
  await page.waitForTimeout(2500);
  await page.fill("#chairText", "割込: 予算は半分です。");
  await page.click('[data-ask=""]');
  await page.waitForFunction(() => /一時停止/.test(document.querySelector("#runBadge").textContent), null, { timeout: 10000 });
  out.interruptPaused = true;
  await shot("interrupted");
  await page.click("#resume");
  await page.waitForFunction(() => /完了/.test(document.querySelector("#runBadge").textContent), null, { timeout: 60000 });
  out.autoCompleted = true;
  await page.click('.tabs button[data-tab="probe"]');
  await page.selectOption("#probeWho", "chatgpt");
  await page.selectOption("#probeMode", "events");
  await page.selectOption("#probeDelay", "0");
  await page.click("#startProbe");
  await page.waitForFunction(() => /成立|不成立/.test(document.querySelector("#probeResults").textContent), null, { timeout: 30000 });
  out.probe = /成立/.test(await page.textContent("#probeResults")) && /MCP Events/.test(await page.textContent("#probeResults"));
  await shot("probe");
  await page.click("#chain6");
  await page.waitForFunction(() => /完了/.test(document.querySelector("#chainResults").textContent), null, { timeout: 60000 });
  out.chain6 = /人の操作なしで届いた回答 6/.test(await page.textContent("#chainResults"));
  await page.click("#chain9");
  await page.waitForFunction(() => /受信済み/.test(document.querySelector("#probeTurn").textContent), null, { timeout: 20000 });
  await page.click("#chainStop");
  await page.waitForTimeout(2500);
  await page.click('.tabs button[data-tab="meeting"]');
  out.staleShown = (await page.locator(".msg.stale").count()) >= 1;
  const before = await page.locator(".msg").count();
  await page.reload();
  await page.waitForSelector("#meetingView:not(.hidden)");
  await page.waitForTimeout(500);
  out.reloadRestores = (await page.locator(".msg").count()) === before;
  await page.setViewportSize({ width: 390, height: 844 });
  out.noHorizontalOverflow = !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await shot("mobile");
} catch (e) {
  out.failure = e.message;
} finally {
  out.errors = errors;
  await browser.close();
  await demo.close();
}
const ok = !out.failure && !errors.length && ["askAll", "interruptPaused", "autoCompleted", "probe", "chain6", "staleShown", "reloadRestores", "noHorizontalOverflow"].every((k) => out[k]);
console.log(JSON.stringify(out, null, 2));
console.log(ok ? "UI CHECK: OK" : "UI CHECK: FAILED");
process.exit(ok ? 0 : 1);
