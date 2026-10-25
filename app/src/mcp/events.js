// MCP Events (webhook delivery) for waking an AI whose task has ended.
//
// Implements the parts of the draft MCP Events extension that ChatGPT Work
// chats support (https://developers.openai.com/plugins/build/mcp-events):
// events/list, events/subscribe (with callback verification), events/unsubscribe,
// and Standard Webhooks-signed POSTs of one event per request.
//
// The event payload carries only identifiers. What the AI should do when an
// event arrives is set by the person when they subscribe in the chat; the
// payload never contains instructions.

import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Webhook } from "standardwebhooks";
import { DISPLAY_NAMES } from "../core/presets.js";

export const TURN_EVENT = "turn.assigned";

export const EVENT_DEFINITIONS = [
  {
    name: TURN_EVENT,
    description:
      "A Roundtable meeting has assigned a speaking turn to this participant. Payload holds only identifiers; read the request with the get_my_turn tool.",
    delivery: ["webhook"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    payloadSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        meeting_id: { type: "string" },
        participant: { type: "string" },
        phase: { type: "string" },
        assigned_at: { type: "string" },
      },
      required: ["request_id", "meeting_id", "participant", "assigned_at"],
      additionalProperties: false,
    },
  },
];

const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const MAX_TTL_MS = 7 * 24 * 3600 * 1000;
const MIN_TTL_MS = 10 * 60 * 1000;
const VERIFY_CACHE_MS = 24 * 3600 * 1000;

export class EventsError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function isPublicAddress(addr) {
  const fam = net.isIP(addr);
  if (fam === 4) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (fam === 6) {
    const x = addr.toLowerCase();
    if (x === "::1" || x === "::") return false;
    if (x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) return false;
    if (x.startsWith("fc") || x.startsWith("fd") || x.startsWith("ff")) return false;
    if (x.startsWith("::ffff:")) return isPublicAddress(x.slice(7));
    return true;
  }
  return false;
}

// POST to an https URL after resolving and validating the address, pinning
// the connection to that address (no DNS rebinding) and never following
// redirects. Returns { status, body }.
export async function safePost(url, headers, body, { timeoutMs = 10000, allowPrivate = false } = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new EventsError(-32015, "callback must be https", { reason: "insecure_url" });
  const addrs = await dns.lookup(u.hostname, { all: true, verbatim: true });
  const ok = addrs.find((a) => allowPrivate || isPublicAddress(a.address));
  if (!ok || (!allowPrivate && addrs.some((a) => !isPublicAddress(a.address))))
    throw new EventsError(-32015, "callback resolves to a non-public address", { reason: "private_address" });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        servername: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
        lookup: (_h, _o, cb) => cb(null, ok.address, ok.family),
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          if (data.length < 64 * 1024) data += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

export class EventHub {
  // poster(url, headers, body) -> {status, body}; injectable for tests.
  constructor({ rt, store, now = () => Date.now(), poster, graceMs, log = () => {} }) {
    this.rt = rt;
    this.store = store;
    this.now = now;
    this.poster = poster || ((u, h, b) => safePost(u, h, b, { allowPrivate: process.env.RT_ALLOW_PRIVATE_CALLBACKS === "1" }));
    this.graceMs = graceMs;
    this.log = log;
    this.subs = new Map(Object.entries(store.readJson("subscriptions.json", {})));
    this.verified = new Map(); // `${participant} ${url}` -> verifiedAt
    this.timers = new Set();
    rt.on("event", ({ event }) => {
      if (event.type === "request_created") this._schedule(event.data.participant, event.data.id);
      if (event.type === "retrigger_authorized") {
        const req = rt._meetingForRequest(event.data.requestId)?.requests[event.data.requestId];
        if (req) this._schedule(req.participant, req.id, 0);
      }
    });
  }

  _save() {
    this.store.writeJson("subscriptions.json", Object.fromEntries(this.subs), { mode: 0o600 });
  }

  list() {
    return { events: EVENT_DEFINITIONS };
  }

  activeFor(participant) {
    const now = this.now();
    return [...this.subs.values()].filter((s) => s.participant === participant && (s.refreshBefore == null || Date.parse(s.refreshBefore) > now));
  }

  summary() {
    const now = this.now();
    return [...this.subs.values()].map((s) => ({
      id: s.id,
      participant: s.participant,
      name: s.name,
      host: new URL(s.url).host,
      createdAt: s.createdAt,
      refreshBefore: s.refreshBefore,
      active: s.refreshBefore == null || Date.parse(s.refreshBefore) > now,
      lastDelivery: s.lastDelivery || null,
    }));
  }

  async subscribe(participant, params) {
    const { name, arguments: args = {}, delivery, ttlMs } = params || {};
    const def = EVENT_DEFINITIONS.find((e) => e.name === name);
    if (!def) throw new EventsError(-32602, `unknown event ${name}`);
    if (args && Object.keys(args).length) throw new EventsError(-32602, `${name} takes no arguments`);
    if (!delivery || delivery.mode !== "webhook") throw new EventsError(-32602, "only webhook delivery is supported");
    const secret = String(delivery.secret || "");
    if (!secret.startsWith("whsec_")) throw new EventsError(-32602, "secret must start with whsec_");
    let keyLen = 0;
    try {
      keyLen = Buffer.from(secret.slice(6), "base64").length;
    } catch {
      keyLen = 0;
    }
    if (keyLen < 24 || keyLen > 64) throw new EventsError(-32602, "secret must decode to 24-64 bytes");
    let url;
    try {
      url = new URL(delivery.url);
    } catch {
      throw new EventsError(-32015, "invalid callback url", { reason: "invalid_url" });
    }
    if (url.protocol !== "https:") throw new EventsError(-32015, "callback must be https", { reason: "insecure_url" });

    const id = "sub_" + crypto.createHash("sha256").update(`${participant}\n${url.href}\n${name}\n${canonical(args)}`).digest("hex").slice(0, 24);
    const vkey = `${participant} ${url.href}`;
    const cached = this.verified.get(vkey);
    if (!cached || this.now() - cached > VERIFY_CACHE_MS) {
      await this._verify(id, url.href, secret);
      this.verified.set(vkey, this.now());
    }
    let ttl = ttlMs == null ? DEFAULT_TTL_MS : Number(ttlMs);
    if (!Number.isFinite(ttl)) ttl = DEFAULT_TTL_MS;
    ttl = Math.min(Math.max(ttl, MIN_TTL_MS), MAX_TTL_MS);
    const refreshBefore = new Date(this.now() + ttl).toISOString();
    const prev = this.subs.get(id);
    this.subs.set(id, {
      id,
      participant,
      name,
      arguments: args,
      url: url.href,
      secret,
      createdAt: prev?.createdAt || new Date(this.now()).toISOString(),
      refreshedAt: new Date(this.now()).toISOString(),
      refreshBefore,
      lastDelivery: prev?.lastDelivery || null,
    });
    this._save();
    this.log(`[events] ${DISPLAY_NAMES[participant]} subscribed ${name} (${id}) until ${refreshBefore}`);
    return { id, refreshBefore, cursor: null, truncated: false };
  }

  unsubscribe(participant, params) {
    const { name, arguments: args = {}, delivery } = params || {};
    let href = "";
    try {
      href = new URL(delivery?.url).href;
    } catch {
      return {};
    }
    const id = "sub_" + crypto.createHash("sha256").update(`${participant}\n${href}\n${name}\n${canonical(args)}`).digest("hex").slice(0, 24);
    const s = this.subs.get(id);
    if (s && s.participant === participant) {
      this.subs.delete(id);
      this._save();
      this.log(`[events] ${DISPLAY_NAMES[participant]} unsubscribed ${id}`);
    }
    return {};
  }

  _headers(secret, msgId, subId, body) {
    const at = new Date(this.now());
    return {
      "content-type": "application/json",
      "webhook-id": msgId,
      "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign(msgId, at, body),
      "x-mcp-subscription-id": subId,
    };
  }

  async _verify(subId, url, secret) {
    const challenge = crypto.randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    let res;
    try {
      res = await this.poster(url, this._headers(secret, `msg_verification_${crypto.randomBytes(8).toString("hex")}`, subId, body), body);
    } catch (e) {
      if (e instanceof EventsError) throw e;
      throw new EventsError(-32015, `callback verification failed: ${e.message}`, { reason: /timeout/i.test(e.message) ? "timeout" : "unreachable" });
    }
    if (!(res.status >= 200 && res.status < 300)) throw new EventsError(-32015, `callback verification got HTTP ${res.status}`, { reason: "challenge_failed" });
    let echoed = "";
    try {
      echoed = String(JSON.parse(res.body).challenge || "");
    } catch {
      echoed = "";
    }
    const a = Buffer.from(echoed);
    const b = Buffer.from(challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new EventsError(-32015, "callback did not echo the challenge", { reason: "challenge_failed" });
  }

  _schedule(participant, requestId, delayMs = this.graceMs()) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.push(participant, requestId).catch((e) => this.log(`[events] push error ${e.message}`));
    }, delayMs);
    t.unref?.();
    this.timers.add(t);
  }

  // Send the wake-up event for a request, at most once per request (the
  // engine refuses after the first recorded attempt unless the chair allows
  // a retry). Retries inside one attempt keep the same event ID, so the
  // receiver can de-duplicate them.
  async push(participant, requestId) {
    if (!this.rt.mayPushWake(participant, requestId)) return null;
    const subs = this.activeFor(participant);
    if (!subs.length) return null;
    const m = this.rt._meetingForRequest(requestId);
    const req = m.requests[requestId];
    const results = [];
    for (const sub of subs) {
      const event = {
        eventId: `evt_${requestId}_${req.triggers.length}`,
        name: TURN_EVENT,
        timestamp: new Date(req.createdAt).toISOString(),
        data: { request_id: req.id, meeting_id: m.id, participant, phase: req.phase || "", assigned_at: new Date(req.createdAt).toISOString() },
        cursor: null,
      };
      const body = JSON.stringify(event);
      let result = "unknown";
      let detail = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await this.poster(sub.url, this._headers(sub.secret, event.eventId, sub.id, body), body);
          if (res.status >= 200 && res.status < 300) {
            result = "sent";
            detail = `HTTP ${res.status}`;
            break;
          }
          detail = `HTTP ${res.status}`;
          if (res.status === 410) {
            this.subs.delete(sub.id);
            this._save();
            result = "failed";
            break;
          }
          if (res.status === 413 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
            result = "failed";
            break;
          }
        } catch (e) {
          detail = e.message;
          result = "unknown";
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt).unref?.());
      }
      sub.lastDelivery = { at: new Date(this.now()).toISOString(), requestId, result, detail };
      this._save();
      this.rt.recordWake(participant, requestId, { channel: "mcp_events", ref: sub.id, result, detail });
      results.push({ sub: sub.id, result, detail });
    }
    return results;
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
