// Where the monitor keeps its progress: the last block it finished, the rule state and
// the alerts. Saved after every chunk, so a restart continues exactly where it stopped.
const fs = require("node:fs");
const path = require("node:path");

// JSON can't hold BigInt: write them as { $big: "123" } and turn them back on load.
const replacer = (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_k, v) => (v && typeof v === "object" && typeof v.$big === "string" && Object.keys(v).length === 1 ? BigInt(v.$big) : v);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x, replacer), reviver));

class MemoryStore {
  constructor() { this.data = undefined; }
  load() { return clone(this.data); }
  save(data) { this.data = clone(data); }
}

class FileStore {
  constructor(file) { this.file = file; }
  load() {
    if (!fs.existsSync(this.file)) return undefined;
    return JSON.parse(fs.readFileSync(this.file, "utf8"), reviver);
  }
  save(data) {
    // write to a temp file and rename: a crash mid-write never leaves half a file
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, replacer));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { MemoryStore, FileStore };
