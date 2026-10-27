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

// writeSync may successfully write fewer bytes than requested (for example
// when a device is nearly full). A string write's return value is bytes, not
// JS characters, so keep a Buffer and advance by the actual byte count.
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw new Error("event log write made no valid progress");
    }
    offset += written;
  }
}

export class EventStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, "meetings"), { recursive: true });
    this.fds = new Map();
    this.appendFailure = null;
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
    if (this.appendFailure) {
      throw new Error("event store is unavailable after a write failure; restart after checking storage", { cause: this.appendFailure });
    }
    let fd = this.fds.get(meetingId);
    let startSize = null;
    try {
      const file = this.meetingFile(meetingId);
      if (fd === undefined) {
        fd = fs.openSync(file, "a");
        this.fds.set(meetingId, fd);
      }
      startSize = fs.fstatSync(fd).size;
      let prefix = "";
      // Never glue a new event onto a complete line without its newline.
      if (startSize > 0) {
        const last = Buffer.alloc(1);
        const rfd = fs.openSync(file, "r");
        try {
          fs.readSync(rfd, last, 0, 1, startSize - 1);
        } finally {
          fs.closeSync(rfd);
        }
        if (last[0] !== 0x0a) prefix = "\n";
      }
      writeAll(fd, Buffer.from(prefix + JSON.stringify(event) + "\n", "utf8"));
      fs.fsyncSync(fd);
    } catch (error) {
      // The command must not be acknowledged or followed by another append
      // after an incomplete write. Roll back this append where possible;
      // otherwise boot's torn-tail repair can recover it after a restart.
      this.appendFailure = error;
      if (fd !== undefined && startSize !== null) {
        try {
          fs.ftruncateSync(fd, startSize);
          fs.fsyncSync(fd);
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
      }
      throw error;
    }
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
