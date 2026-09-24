// sessions.mjs — persistent map of Arena Agent sessions (JSON file, 0600).
import fs from "node:fs";

export class SessionStore {
  constructor({ filePath, ttlMs }) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.sessions = new Map(Object.entries(parsed || {}));
    } catch {
      this.sessions = new Map();
    }
  }

  get(key) {
    const state = this.sessions.get(key);
    if (!state) return undefined;
    if (Date.now() - Number(state.updatedAt || 0) > this.ttlMs) {
      this.sessions.delete(key);
      return undefined;
    }
    return state;
  }

  set(key, state) {
    this.sessions.set(key, state);
    this.persist();
  }

  delete(key) {
    this.sessions.delete(key);
    this.persist();
  }

  get size() {
    return this.sessions.size;
  }

  persist() {
    const now = Date.now();
    for (const [key, value] of this.sessions) {
      if (!value || now - Number(value.updatedAt || 0) > this.ttlMs) this.sessions.delete(key);
    }
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}
