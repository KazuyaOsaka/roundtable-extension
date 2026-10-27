import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import dns from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { EventHub, safePost } from "../src/mcp/events.js";
import { makeRt, newMeeting, tmpDir } from "./helpers.js";

async function callback(t, handler) {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  } catch {
    t.skip("openssl not available");
    return null;
  }
  const ca = fs.readFileSync(path.join(dir, "c.pem"));
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: ca }, (req, res) => {
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  return { url: `https://localhost:${server.address().port}/callback`, options: { ca, allowPrivate: true } };
}

test("callback response closing mid-body rejects instead of hanging", async (t) => {
  const cb = await callback(t, (_req, res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write("partial");
    setTimeout(() => res.destroy(), 20);
  });
  if (!cb) return;
  await assert.rejects(safePost(cb.url, {}, "{}", { ...cb.options, timeoutMs: 1000 }), { code: "ECONNRESET" });
});

test("callback deadline bounds a response which keeps sending bytes", async (t) => {
  const cb = await callback(t, (_req, res) => {
    res.writeHead(200);
    res.write("partial");
    const timer = setInterval(() => res.write("."), 20);
    res.on("close", () => clearInterval(timer));
  });
  if (!cb) return;
  await assert.rejects(safePost(cb.url, {}, "{}", { ...cb.options, timeoutMs: 150 }), { code: "ETIMEDOUT" });
});

test("callback deadline also bounds DNS lookup", async (t) => {
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  await assert.rejects(safePost("https://callback.example/", {}, "{}", { timeoutMs: 30 }), { code: "ETIMEDOUT" });
});

test("callback TCP connection may use another vetted address without replaying HTTP", async (t) => {
  let requests = 0;
  const cb = await callback(t, (_req, res) => {
    requests++;
    res.end("ok");
  });
  if (!cb) return;
  t.mock.method(dns, "lookup", async () => [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }]);
  assert.equal((await safePost(cb.url, {}, "{}", cb.options)).status, 200);
  assert.equal(requests, 1);
});

test("callback refuses DNS sets containing a private fallback address", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await assert.rejects(safePost("https://callback.example/", {}, "{}"), /non-public address/);
});

const params = {
  name: "turn.assigned",
  arguments: {},
  delivery: { mode: "webhook", url: "https://callback.example/", secret: "whsec_" + Buffer.alloc(32, 7).toString("base64") },
};

test("credential rotation revokes subscriptions and verification cache persistently", async (t) => {
  const { rt, store } = makeRt();
  let verified = 0;
  const hub = new EventHub({ rt, store, graceMs: () => 60_000, poster: async (_url, _headers, body) => {
    verified++;
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  } });
  t.after(() => { hub.close(); store.close(); });
  await hub.subscribe("chatgpt", params);
  await hub.subscribe("claude", params);
  hub.revokeParticipant("chatgpt");
  assert.equal(hub.activeFor("chatgpt").length, 0);
  assert.equal(hub.activeFor("claude").length, 1);
  assert.deepEqual(Object.values(store.readJson("subscriptions.json", {})).map((s) => s.participant), ["claude"]);
  await hub.subscribe("chatgpt", params);
  assert.equal(verified, 3, "new credentials must verify the callback again");
});

test("verification started before credential rotation cannot restore a subscription", async (t) => {
  const { rt, store } = makeRt();
  let complete;
  const hub = new EventHub({ rt, store, graceMs: () => 60_000, poster: (_url, _headers, body) => new Promise((resolve) => {
    complete = () => resolve({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) });
  }) });
  t.after(() => { hub.close(); store.close(); });
  const pending = hub.subscribe("chatgpt", params);
  hub.revokeParticipant("chatgpt");
  complete();
  await assert.rejects(pending, /credentials were revoked/);
  assert.equal(hub.activeFor("chatgpt").length, 0);
  assert.equal(hub.verified.size, 0);
  assert.deepEqual(store.readJson("subscriptions.json", {}), {});
});

test("old delivery returning 410 cannot remove a subscription made after rotation", async (t) => {
  const { rt, store } = makeRt();
  newMeeting(rt, { settings: { triggerGraceSec: 0, wake: { chatgpt: { events: true } } } });
  let complete;
  const hub = new EventHub({ rt, store, graceMs: () => 60_000, poster: async (_url, _headers, body) => {
    const message = JSON.parse(body);
    if (message.type === "verification") return { status: 200, body: JSON.stringify({ challenge: message.challenge }) };
    return new Promise((resolve) => { complete = () => resolve({ status: 410, body: "" }); });
  } });
  t.after(() => { hub.close(); store.close(); });
  await hub.subscribe("chatgpt", params);
  rt.chairPost({ text: "Q", ask: "chatgpt" });
  const pending = hub.push("chatgpt", rt.active.requestOrder[0]);
  hub.revokeParticipant("chatgpt");
  await hub.subscribe("chatgpt", params);
  complete();
  await pending;
  assert.equal(hub.activeFor("chatgpt").length, 1);
  assert.equal(Object.keys(store.readJson("subscriptions.json", {})).length, 1);
});
