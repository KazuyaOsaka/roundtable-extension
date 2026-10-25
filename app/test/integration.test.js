// End-to-end over real HTTP/MCP with simulated participants (see mocks.js).
// These verify Roundtable's side of each connection route; they are not
// evidence that the real Claude / ChatGPT / Gemini behave this way.

import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../src/app.js";
import { tmpDir } from "./helpers.js";
import { sleep, mcpClient, waitLoopParticipant, eventsParticipant, panelParticipant, webParticipant, answerOnce } from "./mocks.js";

async function boot(dataDir = tmpDir(), receivers = []) {
  const poster = async (url, headers, body) => {
    for (const r of receivers) {
      const out = await r(url, headers, body);
      if (out) return out;
    }
    throw new Error(`no receiver for ${url}`);
  };
  const app = await startApp({ dataDir, chairPort: 0, participantPort: 0, poster, log: () => {}, tickMs: 50, env: { RT_WAIT_MAX_SEC: "2" } });
  const base = `http://127.0.0.1:${app.participantPort}`;
  const chair = async (action, body = {}) => {
    const r = await fetch(`http://127.0.0.1:${app.chairPort}/api/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-roundtable-chair": app.config.chairToken },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${action}: ${j.message || j.error}`);
    return j;
  };
  return { app, base, chair, dataDir, receivers, mcpUrl: (id) => `${base}/mcp/${app.config.tokens[id]}`, pageUrl: (id) => `${base}/p/${app.config.tokens[id]}` };
}

async function until(fn, ms = 8000, step = 20) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error("timeout waiting for condition");
}

const aiMessages = (rt) => rt.active.messages.filter((x) => x.status === "accepted" && x.speaker !== "chair");

test("three routes together: 6 then 9 utterances with no human action between turns", async () => {
  const ev = eventsParticipant("ChatGPT");
  const env = await boot(tmpDir(), [ev.receiver]);
  const { app, chair } = env;
  try {
    await chair("meeting", {
      title: "結合試験",
      topic: "都市の夜間照明を減らすと何が起きるか",
      settings: {
        triggerGraceSec: 0,
        wake: { claude: { wait: true, panel: false, events: false }, chatgpt: { wait: false, panel: false, events: true }, gemini: { wait: true } },
      },
    });
    const claude = await mcpClient(env.mcpUrl("claude")); // 2025-era client
    const chatgpt = await mcpClient(env.mcpUrl("chatgpt"), { modern: true }); // 2026-07-28 client
    const sub = await ev.subscribe(chatgpt);
    assert.match(sub.id, /^sub_/);
    assert.equal(ev.verified, 1, "callback verified with a signed challenge");
    const cl = waitLoopParticipant(claude, "Claude");
    const ge = webParticipant(env.pageUrl("gemini"), "Gemini");

    await chair("auto", { presetId: "free", maxTurns: 6, maxMinutes: 5 });
    await until(() => app.rt.active.runs[app.rt.active.runId].state === "completed");
    let msgs = aiMessages(app.rt);
    assert.deepEqual(msgs.map((x) => x.speaker), ["gemini", "chatgpt", "claude", "gemini", "chatgpt", "claude"]);
    // Round 2: each answer quotes the immediately previous speaker's text.
    for (let i = 3; i < 6; i++) {
      const prev = msgs[i - 1];
      assert.match(msgs[i].text, new RegExp(`#${prev.seq}`), `${msgs[i].speaker} refers to #${prev.seq}`);
      assert.ok(msgs[i].text.includes(prev.text.slice(0, 24)), "quote is the previous text");
    }
    assert.equal(ev.badSignatures, 0);
    assert.equal(ev.received.length, 2, "ChatGPT woken twice by MCP Events");
    const chain = app.rt.chainReport();
    assert.equal(chain.answered, 6);
    assert.equal(chain.automaticAnswered, 6, "every turn reached the AI without a person");
    assert.deepEqual(chain.rows.map((r) => r.wakeCode), ["web", "events", "wait", "web", "events", "wait"]);
    assert.equal(chain.quotedPrevious, 5, "every answer after the first quotes the previous AI");
    await Promise.all(ev.runs);

    await chair("auto", { presetId: "free", maxTurns: 9, maxMinutes: 5 });
    await until(() => app.rt.active.runs[app.rt.active.runId].state === "completed");
    await Promise.all(ev.runs);
    msgs = aiMessages(app.rt);
    assert.equal(msgs.length, 15);
    // No request was answered twice and nothing was lost.
    const reqIds = msgs.map((x) => x.requestId);
    assert.equal(new Set(reqIds).size, reqIds.length);
    cl.stopped = ge.stopped = true;
    await chair("end");
    await Promise.all([cl.done, ge.done]);
    await claude.close();
    await chatgpt.close();
  } finally {
    await app.close();
  }
});

test("probe via each wake route is classified correctly", async () => {
  const ev = eventsParticipant("ChatGPT");
  const env = await boot(tmpDir(), [ev.receiver]);
  const { app, chair } = env;
  try {
    await chair("meeting", {
      topic: "接続試験",
      settings: { triggerGraceSec: 0, wake: { claude: { wait: false, panel: true }, chatgpt: { wait: false, events: true }, gemini: { wait: true } } },
    });
    const claude = await mcpClient(env.mcpUrl("claude"));
    const chatgpt = await mcpClient(env.mcpUrl("chatgpt"), { modern: true });
    await ev.subscribe(chatgpt);
    const panel = panelParticipant(claude, "Claude");
    const ge = webParticipant(env.pageUrl("gemini"), "Gemini");

    const modes = { claude: { wait: false, panel: true, events: false }, chatgpt: { wait: false, panel: false, events: true }, gemini: { wait: true, panel: false, events: false } };
    for (const p of ["claude", "chatgpt", "gemini"]) {
      await chair("probe", { participant: p, delaySec: 1, wake: modes[p] });
      await until(() => app.rt.active.runs[app.rt.active.runId].state === "completed");
    }
    const reps = app.rt.probeReport();
    const by = Object.fromEntries(reps.map((r) => [r.participant, r]));
    assert.ok(by.claude.passed && by.chatgpt.passed && by.gemini.passed);
    assert.match(by.claude.wakeRoute, /MCP App パネル/);
    assert.match(by.chatgpt.wakeRoute, /MCP Events/);
    assert.match(by.gemini.wakeRoute, /参加者ページ/);
    for (const r of reps) assert.ok(r.waitedSec >= 1, "B came after the configured wait");
    for (const r of reps) assert.ok(r.passedAutomatically);
    assert.deepEqual(by.claude.wakeSetting, modes.claude);
    panel.stopped = ge.stopped = true;
    await chair("end");
    await Promise.all([panel.done, ge.done]);
    await claude.close();
    await chatgpt.close();
  } finally {
    await app.close();
  }
});

test("stop during generation: late answer kept as stale, nothing new starts", async () => {
  const env = await boot();
  const { app, chair } = env;
  try {
    await chair("meeting", { topic: "停止試験", settings: { wake: { gemini: { wait: true } } } });
    const gem = await mcpClient(env.mcpUrl("gemini"));
    const g = waitLoopParticipant(gem, "Gemini", { genMs: 400 });
    await chair("auto", { maxTurns: 6, maxMinutes: 5 });
    await until(() => Object.values(app.rt.active.requests).some((r) => r.deliveries > 0));
    await chair("stop");
    await until(() => g.results.length === 1);
    assert.equal(g.results[0].status, "stale");
    assert.equal(g.results[0].forwarded, false);
    await sleep(300);
    assert.equal(Object.values(app.rt.active.requests).length, 1, "no new request after stop");
    assert.equal(aiMessages(app.rt).length, 0);
    g.stopped = true;
    await chair("end");
    await g.done;
    await gem.close();
  } finally {
    await app.close();
  }
});

test("lost response: re-sent post is a duplicate, the meeting advances once", async () => {
  const env = await boot();
  const { app, chair } = env;
  try {
    await chair("meeting", { topic: "重複試験" });
    await chair("post", { text: "質問", ask: "claude" });
    const c = await mcpClient(env.mcpUrl("claude"));
    const t = await c.callTool({ name: "get_my_turn", arguments: {} });
    const id = t.structuredContent.request_id;
    const a = await c.callTool({ name: "post_message", arguments: { request_id: id, text: "回答" } });
    const b = await c.callTool({ name: "post_message", arguments: { request_id: id, text: "回答" } });
    assert.equal(a.structuredContent.status, "accepted");
    assert.equal(b.structuredContent.status, "duplicate");
    assert.equal(aiMessages(app.rt).length, 1);
    const d = await c.callTool({ name: "post_message", arguments: { request_id: id, text: "書き直した回答" } });
    assert.equal(d.isError, true);
    assert.match(d.content[0].text, /already_answered/);
    await c.close();
  } finally {
    await app.close();
  }
});

test("connection dropped during wait: the turn is not marked delivered", async () => {
  const env = await boot();
  const { app, chair } = env;
  try {
    await chair("meeting", { topic: "通信断試験" });
    const ac = new AbortController();
    const c = await mcpClient(env.mcpUrl("claude"));
    const waiting = c.callTool({ name: "wait_for_my_turn", arguments: { timeout_sec: 2 } }, undefined, { signal: ac.signal }).catch((e) => e);
    await until(() => app.rt.presence.claude.waitingSince);
    ac.abort();
    await waiting;
    await sleep(100);
    await chair("post", { text: "質問", ask: "claude" });
    await sleep(200);
    const req = Object.values(app.rt.active.requests)[0];
    assert.equal(req.deliveries, 0, "aborted waiter must not consume the turn");
    const r = await answerOnce(c, "Claude");
    assert.equal(r.status, "accepted");
    await c.close();
  } finally {
    await app.close();
  }
});

test("permissions: unknown token, other participant's request, chair API without token", async () => {
  const env = await boot();
  const { app, chair, base } = env;
  try {
    await chair("meeting", { topic: "権限試験" });
    assert.equal((await fetch(`${base}/mcp/not-a-token`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/p/not-a-token`)).status, 404);
    await chair("post", { text: "Q", ask: "gemini" });
    const g = await mcpClient(env.mcpUrl("gemini"));
    const t = await g.callTool({ name: "get_my_turn", arguments: {} });
    const c = await mcpClient(env.mcpUrl("claude"));
    const r = await c.callTool({ name: "post_message", arguments: { request_id: t.structuredContent.request_id, text: "なりすまし" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /forbidden/);
    const noTok = await fetch(`http://127.0.0.1:${app.chairPort}/api/end`, { method: "POST" });
    assert.equal(noTok.status, 403);
    const tools = (await c.listTools()).tools.map((x) => x.name);
    for (const forbidden of ["updateOrder", "start_auto", "set_role"]) assert.ok(!tools.includes(forbidden));
    await g.close();
    await c.close();
  } finally {
    await app.close();
  }
});

test("MCP Events: bad subscriptions rejected; duplicate webhook runs post once", async () => {
  const ev = eventsParticipant("ChatGPT");
  ev.duplicateEvery = true;
  const env = await boot(tmpDir(), [ev.receiver]);
  const { app, chair } = env;
  try {
    await chair("meeting", { topic: "イベント試験", settings: { triggerGraceSec: 0, wake: { chatgpt: { wait: false, events: true } } } });
    const c = await mcpClient(env.mcpUrl("chatgpt"), { modern: true });
    const z = (await import("zod/v4")).z;
    const any = z.object({}).passthrough();
    await assert.rejects(
      c.request({ method: "events/subscribe", params: { name: "turn.assigned", arguments: {}, delivery: { mode: "webhook", url: "http://insecure.example/cb", secret: ev.secret } } }, any),
      /https/,
    );
    await assert.rejects(
      c.request({ method: "events/subscribe", params: { name: "turn.assigned", arguments: {}, delivery: { mode: "webhook", url: ev.callbackUrl, secret: "whsec_c2hvcnQ=" } } }, any),
      /24-64 bytes/,
    );
    const listed = await c.request({ method: "events/list", params: {} }, any);
    assert.equal(listed.events[0].name, "turn.assigned");
    const s1 = await ev.subscribe(c);
    const s2 = await ev.subscribe(c);
    assert.equal(s1.id, s2.id, "subscription id is deterministic / idempotent");
    assert.equal(ev.verified, 1, "verification cached for repeated subscribe");

    await chair("post", { text: "Q", ask: "chatgpt" });
    await until(() => ev.runs.length === 2);
    const results = await Promise.all(ev.runs);
    const statuses = results.map((r) => r.status || r.skipped).sort();
    assert.ok(statuses.includes("accepted"));
    assert.ok(statuses.every((s) => ["accepted", "duplicate", "request_closed", "not_your_turn"].includes(s)), statuses.join(","));
    assert.equal(aiMessages(app.rt).length, 1);
    // one wake-up per request
    const req = Object.values(app.rt.active.requests)[0];
    assert.equal(req.triggers.filter((t) => t.channel === "mcp_events").length, 1);

    await c.request({ method: "events/unsubscribe", params: { name: "turn.assigned", arguments: {}, delivery: { mode: "webhook", url: ev.callbackUrl } } }, any);
    assert.equal(app.hub.summary().length, 0);
    await c.close();
  } finally {
    await app.close();
  }
});

test("restart mid-meeting: record, open request and subscriptions survive", async () => {
  const ev = eventsParticipant("ChatGPT");
  const dir = tmpDir();
  let env = await boot(dir, [ev.receiver]);
  try {
    await env.chair("meeting", { topic: "再起動試験", settings: { triggerGraceSec: 0, wake: { chatgpt: { wait: false, events: true } } } });
    let c = await mcpClient(env.mcpUrl("chatgpt"), { modern: true });
    await ev.subscribe(c);
    await c.close();
    await env.app.close();

    env = await boot(dir, [ev.receiver]);
    c = await mcpClient(env.mcpUrl("chatgpt"), { modern: true });
    ev.client = c;
    assert.equal(env.app.hub.summary().length, 1);
    await env.chair("post", { text: "再起動後の質問", ask: "chatgpt" });
    await until(() => aiMessages(env.app.rt).length === 1);
    await Promise.all(ev.runs);
    assert.match(aiMessages(env.app.rt)[0].text, /ChatGPT の見解/);
    await c.close();
  } finally {
    await env.app.close();
  }
});

test("transport: both protocol eras answer plain JSON (tunnels without SSE)", async () => {
  const env = await boot();
  const { app } = env;
  try {
    await env.chair("meeting", { topic: "通信方式" });
    const url = env.mcpUrl("claude");
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } }) });
    assert.equal(init.status, 200);
    assert.match(init.headers.get("content-type"), /application\/json/);
    const j = await init.json();
    assert.equal(j.result.protocolVersion, "2025-06-18");
    assert.ok(j.result.capabilities.events, "events capability advertised");
    const list = await fetch(url, { method: "POST", headers: { ...h, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    assert.match(list.headers.get("content-type"), /application\/json/);
    const names = (await list.json()).result.tools.map((t) => t.name);
    for (const n of ["get_my_turn", "wait_for_my_turn", "post_message", "report_problem", "open_roundtable_panel"]) assert.ok(names.includes(n), n);
    const disc = await fetch(url, { method: "POST", headers: { ...h, "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
    assert.match(disc.headers.get("content-type"), /application\/json/);
    const d = await disc.json();
    assert.deepEqual(d.result.supportedVersions, ["2026-07-28"]);
    assert.ok(d.result.capabilities.events);
    assert.equal((await fetch(url)).status, 405);
  } finally {
    await app.close();
  }
});

test("restart with a pending request: the MCP Events wake-up is still sent", async () => {
  const ev = eventsParticipant("ChatGPT");
  const dir = tmpDir();
  let env = await boot(dir, [ev.receiver]);
  try {
    await env.chair("meeting", { topic: "再起動と通知", settings: { triggerGraceSec: 1, wake: { chatgpt: { wait: false, events: true } } } });
    let c = await mcpClient(env.mcpUrl("chatgpt"), { modern: true });
    await ev.subscribe(c);
    await c.close();
    await env.chair("post", { text: "Q", ask: "chatgpt" }); // push is due 1s later...
    await env.app.close(); // ...but the server stops before that
    assert.equal(ev.received.length, 0);
    env = await boot(dir, [ev.receiver]);
    c = await mcpClient(env.mcpUrl("chatgpt"), { modern: true });
    ev.client = c;
    await until(() => aiMessages(env.app.rt).length === 1);
    await Promise.all(ev.runs);
    const req = Object.values(env.app.rt.active.requests)[0];
    assert.equal(req.triggers.filter((t) => t.channel === "mcp_events").length, 1, "exactly one wake-up");
    await c.close();
  } finally {
    await env.app.close();
  }
});
