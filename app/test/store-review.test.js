import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventStore } from "../src/core/store.js";
import { tmpDir } from "./helpers.js";

function fixture(t) {
  const dir = tmpDir();
  const store = new EventStore(dir);
  const first = { n: 1, text: "already committed" };
  store.append("meeting", first);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, first, file: store.meetingFile("meeting") };
}

test("append handles repeated short writes without losing UTF-8 bytes", (t) => {
  const { store, first } = fixture(t);
  const original = fs.writeSync;
  let writes = 0;
  fs.writeSync = (fd, buffer, offset, length, position) => {
    writes++;
    return original(fd, buffer, offset, Math.min(3, length), position);
  };
  const second = { n: 2, text: "仮説を確認する🌏" };
  try {
    store.append("meeting", second);
  } finally {
    fs.writeSync = original;
  }
  assert.ok(writes > 1);
  assert.deepEqual(store.load("meeting"), { events: [first, second], warnings: [] });
});

test("zero-progress writes fail closed and preserve the previous log", (t) => {
  const { store, dir, first, file } = fixture(t);
  const previous = fs.readFileSync(file);
  const original = fs.writeSync;
  fs.writeSync = () => 0;
  try {
    assert.throws(() => store.append("meeting", { n: 2 }), /no valid progress/);
  } finally {
    fs.writeSync = original;
  }
  assert.deepEqual(fs.readFileSync(file), previous);
  assert.throws(() => store.append("meeting", { n: 3 }), /unavailable after a write failure/);
  store.close();
  const restored = new EventStore(dir);
  try {
    assert.deepEqual(restored.load("meeting", { repair: true }).events, [first]);
    restored.append("meeting", { n: 2, text: "after storage recovery" });
    assert.equal(restored.load("meeting").events.length, 2);
  } finally {
    restored.close();
  }
});

test("an error after a partial append rolls back instead of corrupting the next record", (t) => {
  const { store, file } = fixture(t);
  const previous = fs.readFileSync(file);
  const original = fs.writeSync;
  let writes = 0;
  fs.writeSync = (fd, buffer, offset, length, position) => {
    if (writes++ === 0) return original(fd, buffer, offset, Math.min(8, length), position);
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  try {
    assert.throws(() => store.append("meeting", { n: 2, text: "not committed" }), /disk full/);
  } finally {
    fs.writeSync = original;
  }
  assert.deepEqual(fs.readFileSync(file), previous);
  assert.throws(() => store.append("meeting", { n: 3 }), /unavailable after a write failure/);
});

test("failed rollback blocks further appends and restart repairs the torn tail", (t) => {
  const { store, dir, first } = fixture(t);
  const write = fs.writeSync;
  const truncate = fs.ftruncateSync;
  let writes = 0;
  fs.writeSync = (fd, buffer, offset, length, position) => {
    if (writes++ === 0) return write(fd, buffer, offset, Math.min(8, length), position);
    throw new Error("device unavailable");
  };
  fs.ftruncateSync = () => { throw new Error("rollback unavailable"); };
  try {
    assert.throws(() => store.append("meeting", { n: 2, text: "not committed" }), /device unavailable/);
  } finally {
    fs.writeSync = write;
    fs.ftruncateSync = truncate;
  }
  assert.throws(() => store.append("meeting", { n: 3 }), /unavailable after a write failure/);
  store.close();
  const restored = new EventStore(dir);
  try {
    const loaded = restored.load("meeting", { repair: true });
    assert.deepEqual(loaded.events, [first]);
    assert.ok(loaded.warnings.some((w) => w.includes("truncated torn tail")));
    restored.append("meeting", { n: 2, text: "recovered" });
    assert.equal(restored.load("meeting").events.length, 2);
  } finally {
    restored.close();
  }
});

test("fsync failure does not leave an unacknowledged event followed by further writes", (t) => {
  const { store, file } = fixture(t);
  const previous = fs.readFileSync(file);
  const original = fs.fsyncSync;
  let syncs = 0;
  fs.fsyncSync = (fd) => {
    if (syncs++ === 0) throw new Error("sync failed");
    return original(fd);
  };
  try {
    assert.throws(() => store.append("meeting", { n: 2, text: "not committed" }), /sync failed/);
  } finally {
    fs.fsyncSync = original;
  }
  assert.deepEqual(fs.readFileSync(file), previous);
  assert.throws(() => store.append("meeting", { n: 3 }), /unavailable after a write failure/);
});
