// Append-only event log (one JSONL file per meeting).
//
// The meeting state is never written directly: every change is an event, and
// the state is rebuilt by replaying the log. This gives three properties the
// meeting needs:
//   - restore after reload / process restart (replay),
//   - an audit trail that keeps raw text even when a post is rejected,
//   - idempotency checks that survive restarts (they read replayed state).
//
// Each append is fsync'ed before the command returns, so an accepted post is
// on disk before the participant is told "accepted".

import fs from "node:fs";
import path from "node:path";

export class EventStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, "meetings"), { recursive: true });
    this.fds = new Map();
  }

  meetingFile(meetingId) {
    if (!/^[A-Za-z0-9_-]+$/.test(meetingId)) throw new Error("bad meeting id");
    return path.join(this.dir, "meetings", `${meetingId}.jsonl`);
  }

  listMeetingIds() {
    return fs
      .readdirSync(path.join(this.dir, "meetings"))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  }

  // Returns { events, warnings }. A torn final line (crash mid-write) is
  // skipped with a warning; a corrupt line in the middle is a hard error,
  // because silently dropping it could reorder the meeting.
  load(meetingId) {
    const file = this.meetingFile(meetingId);
    if (!fs.existsSync(file)) return { events: [], warnings: [] };
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const events = [];
    const warnings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        const rest = lines.slice(i + 1).some((l) => l.trim());
        if (rest) throw new Error(`corrupt event log ${file} line ${i + 1}`);
        warnings.push(`ignored torn last line in ${file}`);
      }
    }
    return { events, warnings };
  }

  append(meetingId, event) {
    let fd = this.fds.get(meetingId);
    if (fd === undefined) {
      fd = fs.openSync(this.meetingFile(meetingId), "a");
      this.fds.set(meetingId, fd);
    }
    fs.writeSync(fd, JSON.stringify(event) + "\n");
    fs.fsyncSync(fd);
  }

  readJson(name, fallback) {
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  // Atomic replace (write temp + rename) for small config files.
  writeJson(name, value, { mode } = {}) {
    const file = path.join(this.dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
    fs.renameSync(tmp, file);
  }

  close() {
    for (const fd of this.fds.values()) fs.closeSync(fd);
    this.fds.clear();
  }
}
