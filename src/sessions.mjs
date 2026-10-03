// sessions.mjs — persistent map of Arena Agent sessions (JSON file, 0600).
import fs from "node:fs";

export class SessionStore {
  constructor({ filePath, ttlMs }) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    try {
      const snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const [key, state] of Object.entries(snapshot || {})) this.sessions.set(key, state);
    } catch {
      this.sessions.clear();
    }
  }

  #expired(state, now) {
    return !state || now - Number(state.updatedAt || 0) > this.ttlMs;
  }

  get(key) {
    const state = this.sessions.get(key);
    if (!state) return undefined;
    if (!this.#expired(state, Date.now())) return state;
    this.sessions.delete(key);
    return undefined;
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
    for (const [key, state] of this.sessions) {
      if (this.#expired(state, now)) this.sessions.delete(key);
    }
    const snapshot = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, snapshot, { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}
