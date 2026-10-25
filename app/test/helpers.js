import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../src/core/store.js";
import { Roundtable } from "../src/core/engine.js";

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rt-test-"));
}

export function makeClock(start = Date.UTC(2026, 9, 25, 0, 0, 0)) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => {
    t += ms;
  };
  return clock;
}

export function makeRt(dir = tmpDir(), clock = makeClock()) {
  const store = new EventStore(dir);
  const rt = new Roundtable({ store, now: clock }).boot();
  return { rt, store, dir, clock };
}

// Reload from disk as a fresh process would.
export function reload(dir, clock) {
  const store = new EventStore(dir);
  return new Roundtable({ store, now: clock }).boot();
}

export function newMeeting(rt, extra = {}) {
  return rt.createMeeting({ title: "テスト会議", topic: "テスト用の議題", ...extra });
}

// Answer the participant's current turn the way a well-behaved AI would.
export function answer(rt, participant, text) {
  const d = rt.deliver(participant, "get");
  if (d.status !== "your_turn") throw new Error(`${participant}: ${d.status}`);
  return { delivery: d, result: rt.post(participant, { requestId: d.request.id, text: text ?? `${participant} の回答 (${d.request.id})` }) };
}
