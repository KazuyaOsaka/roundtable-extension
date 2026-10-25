// Regression tests for defects found in the independent review.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { makeRt, reload, newMeeting, answer, tmpDir } from "./helpers.js";
import { EventHub, safePost } from "../src/mcp/events.js";
import { CommandError } from "../src/core/engine.js";

function hubFor(rt, store, poster) {
  return new EventHub({ rt, store, poster, graceMs: () => 60_000, log: () => {} });
}

async function subscribeAs(hub, participant, url = "https://cb.example/x") {
  const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
  return hub.subscribe(participant, { name: "turn.assigned", arguments: {}, delivery: { mode: "webhook", url, secret } });
}

const verifyOk = async (url, headers, body) => {
  const msg = JSON.parse(body);
  return msg.type === "verification" ? { status: 200, body: JSON.stringify({ challenge: msg.challenge }) } : null;
};

test("safePost reaches a real HTTPS endpoint (lookup callback shape on Node 20+)", async (t) => {
  const dir = tmpDir();
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  } catch {
    t.skip("openssl not available");
    return;
  }
  const key = fs.readFileSync(path.join(dir, "k.pem"));
  const cert = fs.readFileSync(path.join(dir, "c.pem"));
  let got = null;
  const srv = https.createServer({ key, cert }, (req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      got = { headers: req.headers, body: b };
      res.writeHead(202);
      res.end("ok");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const url = `https://localhost:${srv.address().port}/cb`;
    const r = await safePost(url, { "content-type": "application/json", "webhook-id": "evt_1" }, '{"a":1}', { allowPrivate: true, ca: cert });
    assert.equal(r.status, 202);
    assert.equal(got.body, '{"a":1}');
    assert.equal(got.headers["webhook-id"], "evt_1");
    await assert.rejects(safePost(url, {}, "{}", { ca: cert }), /non-public/, "private addresses are refused by default");
    await assert.rejects(safePost(`http://localhost:${srv.address().port}/cb`, {}, "{}", { allowPrivate: true }), /https/);
  } finally {
    srv.close();
  }
});

test("torn tail is cut on boot so the next event is not lost", () => {
  const { rt, dir, clock } = makeRt();
  const m = newMeeting(rt);
  rt.chairPost({ text: "Q", ask: "gemini" });
  rt.store.close();
  fs.appendFileSync(rt.store.meetingFile(m.id), '{"n":99,"type":"mess');
  const rt2 = reload(dir, clock);
  const d = rt2.deliver("gemini", "get");
  assert.equal(rt2.post("gemini", { requestId: d.request.id, text: "保存されるべき回答" }).status, "accepted");
  rt2.store.close();
  const rt3 = reload(dir, clock);
  assert.ok(rt3.active.messages.some((x) => x.text === "保存されるべき回答"), "accepted post survives the next restart");
  assert.ok(!rt3.warnings.some((w) => /torn/.test(w)), "no torn line left");
});

test("panel and MCP Events cannot both wake the same request", async () => {
  const { rt, store, clock } = makeRt();
  newMeeting(rt, { settings: { triggerGraceSec: 0, wake: { chatgpt: { wait: false, panel: true, events: true } } } });
  let release;
  const posts = [];
  const hub = hubFor(rt, store, async (url, headers, body) => {
    const v = await verifyOk(url, headers, body);
    if (v) return v;
    posts.push(body);
    await new Promise((r) => (release = r)); // slow receiver
    return { status: 202, body: "" };
  });
  await subscribeAs(hub, "chatgpt");
  rt.chairPost({ text: "Q", ask: "chatgpt" });
  const req = Object.values(rt.active.requests)[0];
  const pushing = hub.push("chatgpt", req.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.claimTrigger("chatgpt", { requestId: req.id, instanceId: "w1" }).granted, false, "panel loses while the event is in flight");
  release();
  await pushing;
  assert.equal(posts.length, 1);
  assert.equal(req.triggers.length, 1);
  assert.equal(req.triggers[0].result, "sent");
  hub.close();
  void clock;
});

test("one wake-up per request even with several subscriptions; unknown outcome is not resent", async () => {
  const { rt, store } = makeRt();
  newMeeting(rt, { settings: { triggerGraceSec: 0, wake: { chatgpt: { wait: false, events: true } } } });
  let calls = 0;
  const hub = hubFor(rt, store, async (url, headers, body) => {
    const v = await verifyOk(url, headers, body);
    if (v) return v;
    calls++;
    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  });
  await subscribeAs(hub, "chatgpt", "https://cb.example/a");
  await subscribeAs(hub, "chatgpt", "https://cb.example/b");
  rt.chairPost({ text: "Q", ask: "chatgpt" });
  const req = Object.values(rt.active.requests)[0];
  const r = await hub.push("chatgpt", req.id);
  assert.equal(calls, 1, "one POST, no automatic retry");
  assert.equal(r.result, "unknown");
  assert.equal(await hub.push("chatgpt", req.id), null, "not resent without the chair");
  assert.equal(rt.participantView(rt.active, "chatgpt").state, "needs_confirmation");
  rt.authorizeRetrigger(req.id);
  await hub.push("chatgpt", req.id);
  assert.equal(calls, 2, "resent once after the chair allowed it");
  hub.close();
});

test("subscription created after the turn was assigned still announces it", async () => {
  const { rt, store } = makeRt();
  newMeeting(rt, { settings: { triggerGraceSec: 0, wake: { chatgpt: { wait: false, events: true } } } });
  const sent = [];
  const hub = new EventHub({
    rt,
    store,
    graceMs: () => 0,
    log: () => {},
    poster: async (url, headers, body) => (await verifyOk(url, headers, body)) || (sent.push(JSON.parse(body)), { status: 202, body: "" }),
  });
  rt.chairPost({ text: "Q", ask: "chatgpt" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0, "no subscription yet");
  await subscribeAs(hub, "chatgpt");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 1);
  hub.close();
});

test("changing the secret re-verifies the callback", async () => {
  const { rt, store } = makeRt();
  newMeeting(rt);
  let verifications = 0;
  const hub = hubFor(rt, store, async (url, headers, body) => {
    verifications += JSON.parse(body).type === "verification" ? 1 : 0;
    return verifyOk(url, headers, body);
  });
  const d = (k) => ({ name: "turn.assigned", arguments: {}, delivery: { mode: "webhook", url: "https://cb.example/x", secret: "whsec_" + Buffer.alloc(32, k).toString("base64") } });
  await hub.subscribe("chatgpt", d(1));
  await hub.subscribe("chatgpt", d(1));
  assert.equal(verifications, 1);
  await hub.subscribe("chatgpt", d(2));
  assert.equal(verifications, 2);
  hub.close();
});

test("run with nobody allowed to write pauses instead of looping", () => {
  const { rt } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ maxTurns: 6 });
  const before = m.eventCount;
  rt.updateMembers({ claude: { read: true, write: false }, chatgpt: { read: true, write: false }, gemini: { read: true, write: false } });
  for (let i = 0; i < 5; i++) rt.tick();
  assert.equal(rt._run(m).state, "paused");
  assert.ok(m.eventCount - before < 10, `bounded events (${m.eventCount - before})`);
});

test("skip only moves past the turn the run is on", () => {
  const { rt, clock } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ maxTurns: 6 });
  const g = answer(rt, "gemini");
  assert.throws(() => rt.skip(g.delivery.request.id), (e) => e.code === "bad_state", "answered request cannot be skipped");
  assert.equal(rt.deliver("chatgpt", "get").status, "your_turn", "ChatGPT keeps its turn");
  clock.advance(m.settings.requestTimeoutSec * 1000 + 1);
  rt.tick();
  const expired = Object.values(m.requests).find((r) => r.status === "expired");
  rt.skip(expired.id);
  assert.throws(() => rt.skip(expired.id), (e) => e.code === "bad_state", "second skip refused");
  rt.resume();
  assert.equal(rt.deliver("claude", "get").status, "your_turn");
  assert.equal(rt.deliver("gemini", "get").status, "not_your_turn");
});

test("independent round: no peek at peers while waiting to be re-asked", () => {
  const { rt } = makeRt();
  newMeeting(rt);
  rt.startAuto({ presetId: "theory", maxTurns: 12 });
  const dg = rt.deliver("gemini", "get");
  rt.deliver("chatgpt", "get");
  rt.post("gemini", { requestId: dg.request.id, text: "GEMINI-SECRET-ROUND1" });
  rt.updateRole("chatgpt", "synthesize"); // ChatGPT's request superseded; run paused
  assert.doesNotMatch(rt.getMessages("chatgpt", {}).messages, /GEMINI-SECRET-ROUND1/);
  assert.doesNotMatch(rt.brief("chatgpt").recent, /GEMINI-SECRET-ROUND1/);
});

test("invalid chair input changes nothing", () => {
  const { rt } = makeRt();
  const m = newMeeting(rt);
  rt.startAuto({ maxTurns: 6 });
  rt.updateMembers({ claude: { read: true, write: false }, chatgpt: { read: true, write: true }, gemini: { read: true, write: true } });
  const n = m.messages.length;
  const state = rt._run(m).state;
  assert.throws(() => rt.chairPost({ text: "Q", ask: "claude" }), CommandError);
  assert.equal(m.messages.length, n, "no chair message recorded");
  assert.equal(rt._run(m).state, state, "run untouched");
  assert.throws(() => rt.createMeeting({ topic: "x", order: ["claude", "claude"] }), CommandError);
  assert.equal(rt.active.id, m.id);
  assert.equal(m.status, "open", "current meeting not ended by a rejected create");
});

test("manual panel wake is debounced while the previous one is unconfirmed", () => {
  const { rt, clock } = makeRt();
  const m = newMeeting(rt, { settings: { wake: { claude: { wait: false, panel: true } } } });
  rt.chairPost({ text: "Q", ask: "claude" });
  const req = Object.values(m.requests)[0];
  assert.equal(rt.claimTrigger("claude", { requestId: req.id, instanceId: "a", manual: true }).granted, true);
  assert.equal(rt.claimTrigger("claude", { requestId: req.id, instanceId: "a", manual: true }).granted, false);
  clock.advance(21_000);
  assert.equal(rt.claimTrigger("claude", { requestId: req.id, instanceId: "a", manual: true }).granted, true);
});
