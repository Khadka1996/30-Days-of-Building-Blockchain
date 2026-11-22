// A tiny storage layer for the indexer.
//
// The whole state (events + cursor + recent block hashes) is saved as ONE
// JSON document, so the events and the cursor can never disagree after a crash.
// FileStore writes to a temp file and renames it: a rename is atomic, so a crash
// mid-write leaves the old file intact instead of a half-written one.
const fs = require("fs");
const path = require("path");

class MemoryStore {
  constructor() { this.data = null; }
  load() { return this.data ? JSON.parse(this.data) : null; }
  save(state) { this.data = JSON.stringify(state); }
}

class FileStore {
  constructor(file) { this.file = file; }
  load() {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(fs.readFileSync(this.file, "utf8"));
  }
  save(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { MemoryStore, FileStore };
