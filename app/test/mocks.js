// Simulated AI participants that talk to a running Roundtable over the real
// transports (MCP over HTTP, MCP Events webhooks, the participant web page).
// They stand in for Claude / ChatGPT / Gemini in automated tests ONLY; a pass
// here says nothing about the real services.

import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Webhook } from "standardwebhooks";
import * as z from "zod/v4";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic "answer": quote the last message in the delta and echo any
// probe code word, so tests can check the answer used the request content.
export function compose(me, turnText) {
  const blocks = [...turnText.matchAll(/<<<発言 #(\d+) ([^>]*)>>>\n([\s\S]*?)\n<<<#\1 ここまで>>>/g)];
  const codes = turnText.match(/(ALPHA|BRAVO)-[0-9A-F]{4}/g) || [];
  const reqId = (turnText.match(/依頼 (R-[\w-]+)】/) || [])[1];
  let quote = "";
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    quote = `前の発言（#${last[1]}）「${last[3].slice(0, 24)}」を踏まえて、`;
  }
  return `${quote}${me} の見解です（${reqId}）。${codes.join(" ")}`.trim();
}

export async function mcpClient(url, { modern = false } = {}) {
  const c = new Client({ name: "mock", version: "1" }, modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

// Claude-like: stays in one task and long-polls.
export function waitLoopParticipant(client, me, { genMs = 0, timeoutSec = 1 } = {}) {
  const state = { stopped: false, posts: [], results: [] };
  state.done = (async () => {
    while (!state.stopped) {
      const r = await client.callTool({ name: "wait_for_my_turn", arguments: { timeout_sec: timeoutSec } });
      const s = r.structuredContent || {};
      if (s.status === "meeting_ended") break;
      if (s.status !== "your_turn") continue;
      if (genMs) await sleep(genMs);
      const text = compose(me, r.content[0].text);
      const p = await client.callTool({ name: "post_message", arguments: { request_id: s.request_id, text } });
      state.posts.push(text);
      state.results.push(p.structuredContent);
    }
  })();
  return state;
}

// One "task run" started by an outside wake-up (event or panel message).
export async function answerOnce(client, me, requestId) {
  const r = await client.callTool({ name: "get_my_turn", arguments: requestId ? { request_id: requestId } : {} });
  const s = r.structuredContent || {};
  if (s.status !== "your_turn") return { skipped: s.status };
  const text = compose(me, r.content[0].text);
  const p = await client.callTool({ name: "post_message", arguments: { request_id: s.request_id, text } });
  return p.structuredContent;
}

// ChatGPT-like Work chat: subscribes to turn.assigned and runs a task per
// webhook. `receiver` is plugged into the app as its webhook poster.
export function eventsParticipant(me) {
  const secret = "whsec_" + crypto.randomBytes(32).toString("base64");
  const callbackUrl = `https://events.mock.example/callback/${crypto.randomBytes(4).toString("hex")}`;
  const state = { client: null, received: [], verified: 0, badSignatures: 0, runs: [], duplicateEvery: false };
  state.subscribe = async (client) => {
    state.client = client;
    return client.request(
      { method: "events/subscribe", params: { name: "turn.assigned", arguments: {}, delivery: { mode: "webhook", url: callbackUrl, secret }, cursor: null } },
      z.object({}).passthrough(),
    );
  };
  state.callbackUrl = callbackUrl;
  state.secret = secret;
  state.receiver = async (url, headers, body) => {
    if (url !== callbackUrl) return null;
    try {
      new Webhook(secret).verify(body, headers);
    } catch {
      state.badSignatures++;
      return { status: 401, body: "bad signature" };
    }
    const msg = JSON.parse(body);
    if (msg.type === "verification") {
      state.verified++;
      return { status: 200, body: JSON.stringify({ challenge: msg.challenge }) };
    }
    state.received.push(msg);
    const times = state.duplicateEvery ? 2 : 1;
    for (let i = 0; i < times; i++) {
      state.runs.push(
        (async () => {
          await sleep(5);
          return answerOnce(state.client, me, msg.data.request_id);
        })(),
      );
    }
    return { status: 202, body: "" };
  };
  return state;
}

// The MCP App panel as the host would run it: polls through app-only
// tools and, when told to, "sends" the wake message (here: starts a task run).
export function panelParticipant(client, me, { pollMs = 50 } = {}) {
  const instanceId = crypto.randomBytes(4).toString("hex");
  const state = { stopped: false, wakes: [], runs: [] };
  state.done = (async () => {
    while (!state.stopped) {
      const r = await client.callTool({ name: "panel_poll", arguments: { instance_id: instanceId } });
      const s = r.structuredContent;
      if (s.status === "ended") break;
      if (s.should_trigger) {
        const c = (await client.callTool({ name: "panel_claim_wake", arguments: { request_id: s.request.id, instance_id: instanceId } })).structuredContent;
        if (c.granted) {
          state.wakes.push(c.message);
          const id = (c.message.match(/request_id="([^"]+)"/) || [])[1];
          await client.callTool({ name: "panel_report_wake", arguments: { request_id: s.request.id, instance_id: instanceId, result: "sent" } });
          state.runs.push(answerOnce(client, me, id));
        }
      }
      await sleep(pollMs);
    }
  })();
  return state;
}

// Gemini-like browsing agent on the participant page.
export function webParticipant(pageUrl, me, { pollMs = 50 } = {}) {
  const state = { stopped: false, posts: [] };
  state.done = (async () => {
    while (!state.stopped) {
      const html = await (await fetch(pageUrl)).text();
      if (html.includes("STATUS: MEETING_ENDED")) break;
      const m = html.match(/name="request_id" value="([^"]+)"/);
      if (m) {
        const pre = html.match(/<pre id="request">([\s\S]*?)<\/pre>/)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
        const text = compose(me, pre);
        const res = await fetch(`${pageUrl}/post`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: m[1], text }), redirect: "manual" });
        state.posts.push({ text, status: res.status, location: res.headers.get("location") });
      }
      await sleep(pollMs);
    }
  })();
  return state;
}
