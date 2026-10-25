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
  // because silently dropping it could reorder the meeting. With `repair`,
  // the torn tail is cut off the file so the next append starts on a clean
  // line (otherwise it would be glued onto the fragment and lost).
  load(meetingId, { repair = false } = {}) {
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
        if (repair) {
          const keep = Buffer.byteLength(lines.slice(0, i).map((l) => l + "\n").join(""), "utf8");
          fs.truncateSync(file, keep);
          warnings.push(`truncated torn tail of ${file} at byte ${keep}`);
        }
      }
    }
    return { events, warnings };
  }

  append(meetingId, event) {
    let fd = this.fds.get(meetingId);
    if (fd === undefined) {
      const file = this.meetingFile(meetingId);
      fd = fs.openSync(file, "a");
      this.fds.set(meetingId, fd);
      // Never glue a new event onto a line that lacks its newline.
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        const rfd = fs.openSync(file, "r");
        fs.readSync(rfd, last, 0, 1, size - 1);
        fs.closeSync(rfd);
        if (last[0] !== 0x0a) fs.writeSync(fd, "\n");
      }
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
