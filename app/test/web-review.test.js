import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startApp } from "../src/app.js";

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-web-review-"));
  const app = await startApp({ dataDir, chairPort: 0, participantPort: 0, env: {}, log: () => {}, ...options });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, chair: `http://127.0.0.1:${app.chairPort}`, participant: `http://127.0.0.1:${app.participantPort}` };
}

test("fresh chair state supports connection setup before a meeting exists", async (t) => {
  const { chair } = await fixture(t);
  const response = await fetch(`${chair}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.meeting, null);
  assert.deepEqual(state.participants, []);
  assert.equal(typeof state.now, "number");
  assert.equal(state.setup.length, 3);
});

test("participant previews require read access but do not consume a turn", async (t) => {
  const { app, participant } = await fixture(t);
  const meeting = app.rt.createMeeting({ title: "RESTRICTED MEETING TITLE", topic: "preview permissions" });
  app.rt.chairPost({ text: "Private question", ask: "gemini" });
  const request = Object.values(meeting.requests).find((r) => r.status === "open");
  const url = `${participant}/p/${app.config.tokens.gemini}`;
  const allowed = await fetch(`${url}?preview=1`);
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /RESTRICTED MEETING TITLE/);
  assert.equal(request.deliveries, 0);

  app.rt.updateMembers({ ...meeting.members, gemini: { read: false, write: false } });
  for (const suffix of ["", "?preview=1", "/turn.txt?preview=1"]) {
    const denied = await fetch(`${url}${suffix}`);
    assert.equal(denied.status, 403);
    assert.doesNotMatch(await denied.text(), /RESTRICTED MEETING TITLE/);
  }
  app.rt.updateSettings({ wake: { gemini: { web: false } } });
  assert.equal((await fetch(url)).status, 403, "a disabled page must not leak a preview either");
});

test("rotating a participant URL also revokes previously authorized webhooks", async (t) => {
  const deliveries = [];
  const poster = async (url, headers, body) => {
    const message = JSON.parse(body);
    if (message.type === "verification") return { status: 200, body: JSON.stringify({ challenge: message.challenge }) };
    deliveries.push({ url, message });
    return { status: 202, body: "" };
  };
  const { app, chair, participant } = await fixture(t, { poster });
  app.rt.createMeeting({ topic: "rotation", settings: { triggerGraceSec: 600, wake: { chatgpt: { wait: false, panel: false, events: true } } } });
  await app.hub.subscribe("chatgpt", {
    name: "turn.assigned",
    arguments: {},
    delivery: { mode: "webhook", url: "https://former-token-holder.example/callback", secret: "whsec_" + Buffer.alloc(32, 7).toString("base64") },
  });
  const oldToken = app.config.tokens.chatgpt;
  const response = await fetch(`${chair}/api/rotate-token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-roundtable-chair": app.config.chairToken },
    body: JSON.stringify({ participant: "chatgpt" }),
  });
  assert.equal(response.status, 200);
  assert.notEqual(app.config.tokens.chatgpt, oldToken);
  assert.equal((await fetch(`${participant}/p/${oldToken}`)).status, 404);
  assert.deepEqual(app.hub.activeFor("chatgpt"), []);
  assert.ok(!Object.values(app.store.readJson("subscriptions.json", {})).some((s) => s.participant === "chatgpt"));
  app.rt.chairPost({ text: "A new question after revocation", ask: "chatgpt" });
  const request = Object.values(app.rt.active.requests).find((r) => r.status === "open");
  assert.equal(await app.hub.push("chatgpt", request.id), null);
  assert.deepEqual(deliveries, []);
});

test("chair UI renders a fresh install and preserves unsaved permission edits across SSE", async (t) => {
  const { chromium } = createRequire(import.meta.url)("playwright");
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (!/Executable doesn't exist/.test(error.message)) throw error;
    if (!fs.existsSync(chromium.executablePath())) {
      t.skip("Chromium is not installed; HTTP regressions still run");
      return;
    }
    browser = await chromium.launch({ executablePath: chromium.executablePath() });
  }
  const { app, chair } = await fixture(t);
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(chair);
  await page.waitForSelector("#setupCards .card", { state: "attached" });
  assert.equal(await page.locator("#setupCards > .card").count(), 3);
  await page.fill("#newTopic", "First meeting");
  await page.click("#createMeeting");
  await page.waitForSelector("#meetingView:not(.hidden)");
  await page.click('[data-tab="config"]');
  await page.uncheck("#mw-claude");
  app.rt.chairPost({ text: "Refresh draft controls" });
  await page.waitForFunction(() => document.querySelector("#timeline").textContent.includes("Refresh draft controls"));
  assert.equal(await page.isChecked("#mw-claude"), false, "SSE must preserve the unsaved restriction");
  await page.click("#saveMembers");
  await page.waitForFunction(() => document.querySelector("#toast").textContent === "保存しました");
  assert.equal(app.rt.active.members.claude.write, false);

  await page.uncheck("#mr-gemini");
  app.rt.createMeeting({ title: "Second meeting", topic: "New permissions" });
  await page.waitForFunction(() => document.querySelector("#meetingTitle").textContent === "Second meeting");
  assert.equal(await page.isChecked("#mr-gemini"), true, "drafts from another meeting must be discarded");
  assert.deepEqual(errors, []);
});
