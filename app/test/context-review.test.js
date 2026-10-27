import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { startApp } from "../src/app.js";
import { startupPrompt } from "../src/core/setup.js";
import { CHARTER } from "../src/core/presets.js";
import { participantRoutes } from "../src/web/participant.js";
import { tmpDir, makeRt } from "./helpers.js";
import { mcpClient } from "./mocks.js";

async function fixture(t) {
  const dataDir = tmpDir();
  const app = await startApp({ dataDir, chairPort: 0, participantPort: 0, env: {}, log: () => {} });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.participantPort}`;
  return {
    app,
    page: (id) => `${base}/p/${app.config.tokens[id]}`,
    mcp: (id) => `${base}/mcp/${app.config.tokens[id]}`,
  };
}

function meeting(rt) {
  return rt.createMeeting({
    topic: "REJOIN-TOPIC",
    instructions: "REJOIN-PREMISE",
    roles: { claude: { name: "REJOIN-ROLE", text: "REJOIN-ROLE-INSTRUCTIONS" } },
    settings: { wake: { claude: { web: true }, chatgpt: { web: true }, gemini: { web: true } } },
  });
}

test("every MCP startup route requires a brief before consuming turns", () => {
  for (const wake of [{ wait: true }, { panel: true }, { events: true }, {}]) {
    const prompt = startupPrompt("claude", wake);
    assert.match(prompt, /1\. 最初に必ず get_meeting_brief/);
    assert.match(prompt, /新しいチャットで参加し直した場合も省略しない/);
    const consume = prompt.search(/get_my_turn|wait_for_my_turn|open_roundtable_panel/);
    assert.ok(prompt.indexOf("get_meeting_brief") < consume);
  }
  assert.match(startupPrompt("gemini", {}, { route: "web" }), /まずページの「現在の会議概要」/);
});

test("a fresh MCP chat recovers context after a previous chat consumed the initial brief", async (t) => {
  const env = await fixture(t);
  const m = meeting(env.app.rt);
  env.app.rt.startAuto({ order: ["claude"], maxTurns: 1 });
  const first = await mcpClient(env.mcp("claude"));
  try {
    const turn = await first.callTool({ name: "get_my_turn", arguments: {} });
    await first.callTool({ name: "post_message", arguments: { request_id: turn.structuredContent.request_id, text: "PREVIOUS-CHAT-ANSWER" } });
  } finally { await first.close(); }

  env.app.rt.startAuto({ order: ["claude"], maxTurns: 1 });
  const nextRequest = m.requests[m.requestOrder.at(-1)];
  const second = await mcpClient(env.mcp("claude"));
  try {
    const brief = await second.callTool({ name: "get_meeting_brief", arguments: {} });
    const text = brief.content.map((c) => c.text || "").join("\n");
    for (const marker of ["REJOIN-TOPIC", "REJOIN-PREMISE", "REJOIN-ROLE-INSTRUCTIONS", "PREVIOUS-CHAT-ANSWER"]) assert.ok(text.includes(marker), marker);
    for (const rule of CHARTER) assert.ok(text.includes(rule), rule);
    assert.equal(nextRequest.deliveries, 0, "reading a brief must not consume the current request");
    const turn = await second.callTool({ name: "get_my_turn", arguments: {} });
    assert.equal(turn.structuredContent.request_id, nextRequest.id);
    assert.equal(nextRequest.includePremise, false);
    assert.equal(nextRequest.includeRole, false);
  } finally { await second.close(); }
});

test("web rejoining restores current context even when turn deltas omit it", async (t) => {
  const { app, page } = await fixture(t);
  const m = meeting(app.rt);
  app.rt.startAuto({ order: ["claude"], maxTurns: 1 });
  const first = app.rt.deliver("claude", "web");
  app.rt.post("claude", { requestId: first.request.id, text: "PREVIOUS-WEB-ANSWER", via: "web" });
  app.rt.startAuto({ order: ["claude"], maxTurns: 1 });
  const request = m.requests[m.requestOrder.at(-1)];
  for (const suffix of ["", "/turn.txt"]) {
    const response = await fetch(page("claude") + suffix);
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const marker of ["REJOIN-TOPIC", "REJOIN-PREMISE", "REJOIN-ROLE-INSTRUCTIONS", "PREVIOUS-WEB-ANSWER"]) assert.ok(body.includes(marker), marker);
    for (const rule of CHARTER) assert.ok(body.includes(rule), rule);
    assert.match(body, /回答欄に本文を入力し/);
    assert.doesNotMatch(body, /post_message ツール|report_problem/);
  }
  assert.equal(request.includePremise, false, "context must be restored without resetting delta cursors");
  assert.equal(request.includeRole, false);
  app.rt.post("claude", { requestId: request.id, text: "SECOND-WEB-ANSWER", via: "web" });
  app.rt.updatePremise({ topic: "UPDATED-TOPIC", instructions: "UPDATED-PREMISE" });
  app.rt.updateRole("claude", { name: "UPDATED-ROLE", text: "UPDATED-ROLE-INSTRUCTIONS" });
  const waiting = await (await fetch(page("claude"))).text();
  assert.match(waiting, /STATUS: WAITING/);
  for (const marker of ["UPDATED-TOPIC", "UPDATED-PREMISE", "UPDATED-ROLE-INSTRUCTIONS"]) assert.ok(waiting.includes(marker), marker);
});

test("web context respects independent-round hiding and read authorization", async (t) => {
  const { app, page } = await fixture(t);
  const m = meeting(app.rt);
  app.rt.startAuto({ presetId: "theory", maxTurns: 12 });
  const gemini = app.rt.deliver("gemini", "get");
  app.rt.post("gemini", { requestId: gemini.request.id, text: "HIDDEN-INDEPENDENT-ANSWER" });
  const claude = Object.values(m.requests).find((r) => r.participant === "claude" && r.status === "open");
  for (const suffix of ["?preview=1", "/turn.txt?preview=1"]) {
    const response = await fetch(page("claude") + suffix);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /REJOIN-TOPIC/);
    assert.doesNotMatch(body, /HIDDEN-INDEPENDENT-ANSWER/);
    assert.equal(claude.deliveries, 0, "preview brief must not deliver a request");
  }
  const active = await (await fetch(page("claude"))).text();
  assert.doesNotMatch(active, /HIDDEN-INDEPENDENT-ANSWER/);
  app.rt.updateMembers({ ...m.members, claude: { read: false, write: false } });
  for (const suffix of ["", "?preview=1", "/turn.txt", "/turn.txt?preview=1"]) {
    const response = await fetch(page("claude") + suffix);
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /REJOIN-TOPIC|REJOIN-PREMISE|REJOIN-ROLE-INSTRUCTIONS/);
  }
});

test("revoking a participant URL while its form body arrives prevents the old post", { timeout: 5000 }, async (t) => {
  const { rt, store, dir } = makeRt();
  const m = meeting(rt);
  rt.startAuto({ order: ["claude"], maxTurns: 1 });
  const turn = rt.deliver("claude", "web");
  let token = "original-token";
  let sawAuthentication;
  const authenticated = new Promise((resolve) => { sawAuthentication = resolve; });
  const handle = participantRoutes({ rt, mcp: null, participantForToken: (candidate) => {
    if (candidate !== token) return null;
    sawAuthentication();
    return "claude";
  } });
  const errors = [];
  const server = http.createServer((req, res) => handle(req, res).catch((error) => {
    errors.push(error);
    res.writeHead(500).end();
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = new URLSearchParams({ request_id: turn.request.id, text: "OLD-TOKEN-ANSWER" }).toString();
  let finish;
  const pending = new Promise((resolve, reject) => {
    const request = http.request(`${base}/p/${token}/post`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body),
    } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    request.on("error", reject);
    request.write(body.slice(0, 1));
    finish = () => request.end(body.slice(1));
  });
  await authenticated;
  token = "replacement-token";
  finish();
  assert.equal(await pending, 404);
  assert.equal(turn.request.status, "open");
  assert.equal(m.messages.length, 0);
  const valid = await fetch(`${base}/p/${token}/post`, { method: "POST", body, redirect: "manual" });
  assert.equal(valid.status, 303);
  assert.equal(turn.request.status, "answered");
  assert.deepEqual(errors, []);
});
