import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { makeRt } from "./helpers.js";
import { EventHub } from "../src/mcp/events.js";
import { createMcpEndpoint } from "../src/mcp/server.js";
import { participantRoutes } from "../src/web/participant.js";

const subscription = {
  name: "turn.assigned",
  arguments: {},
  delivery: { mode: "webhook", url: "https://revoked-client.example/callback", secret: "whsec_" + Buffer.alloc(32, 9).toString("base64") },
};

function envelope(era, method, params) {
  return {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": era === "modern" ? "2026-07-28" : "2025-06-18",
      ...(era === "modern" ? { "mcp-method": method } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: {
        ...params,
        ...(era === "modern" ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "rotation-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}),
      },
    }),
  };
}

async function fixture(t) {
  const { rt, store, dir } = makeRt();
  rt.createMeeting({ topic: "Credential rotation" });
  let currentToken = "original-participant-token";
  let duringDispatch = null;
  let authenticated;
  const sawAuthentication = new Promise((resolve) => { authenticated = resolve; });
  const participantForToken = (token) => {
    if (token !== currentToken) return null;
    authenticated();
    return "chatgpt";
  };
  let verifications = 0;
  const hub = new EventHub({ rt, store, poster: async (_url, _headers, body) => {
    verifications++;
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  } });
  const mcp = createMcpEndpoint({ rt, hub, participantForToken, widgetDomain: () => {
    // This factory hook runs after HTTP authentication and before the SDK
    // dispatches an event method, letting the test rotate at that boundary.
    const callback = duringDispatch;
    duringDispatch = null;
    callback?.();
    return null;
  } });
  const handle = participantRoutes({ rt, mcp, participantForToken });
  const errors = [];
  const server = http.createServer((req, res) => handle(req, res).catch((error) => {
    errors.push(error);
    res.writeHead(500).end();
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    hub.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    hub, errors, sawAuthentication,
    duringDispatch(callback) { duringDispatch = callback; },
    get verifications() { return verifications; },
    url: (token = currentToken) => `http://127.0.0.1:${server.address().port}/mcp/${token}`,
    rotate() { currentToken = "replacement-participant-token"; hub.revokeParticipant("chatgpt"); },
  };
}

for (const era of ["legacy", "modern"]) {
  test(`${era}: token revoked while reading a subscription body cannot register again`, { timeout: 5000 }, async (t) => {
    const env = await fixture(t);
    const { headers, body } = envelope(era, "events/subscribe", subscription);
    let finish;
    const pending = new Promise((resolve, reject) => {
      const req = http.request(env.url(), { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      req.write(body.slice(0, 1));
      finish = () => req.end(body.slice(1));
    });
    await env.sawAuthentication;
    env.rotate();
    finish();
    const response = await pending;
    assert.equal(response.status, 404, response.text);
    assert.deepEqual(env.hub.activeFor("chatgpt"), []);
    assert.equal(env.verifications, 0, "revoked request must not contact its callback");

    // The cached per-participant handler must accept the replacement URL.
    const valid = await fetch(env.url(), { method: "POST", headers, body });
    assert.equal(valid.status, 200);
    assert.ok((await valid.json()).result.id);
    assert.equal(env.hub.activeFor("chatgpt").length, 1);
    assert.equal(env.verifications, 1);
    assert.deepEqual(env.errors, []);
  });

  test(`${era}: rotation during SDK dispatch cannot restore an event subscription`, async (t) => {
    const env = await fixture(t);
    const { headers, body } = envelope(era, "events/subscribe", subscription);
    env.duringDispatch(() => env.rotate());
    const response = await fetch(env.url(), { method: "POST", headers, body });
    const result = await response.json();
    assert.equal(result.error.code, -32000);
    assert.match(result.error.message, /revoked/);
    assert.deepEqual(env.hub.activeFor("chatgpt"), []);
    assert.equal(env.verifications, 0);
    assert.deepEqual(env.errors, []);
  });
}
