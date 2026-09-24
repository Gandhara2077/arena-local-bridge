// batchtest.mjs — send the same prompt to many archived sessions and report.
//
// Deliberately goes through our OWN /v1/chat/completions endpoint rather than
// calling bridge internals: what we measure is then exactly what a real
// OpenAI-compatible client would experience (same auth, same rate limiter,
// same converse-only path, same failures).
const MAX_KEEP = 200;

export class BatchTest {
  constructor({ origin, bridgeKey, sessions }) {
    this.origin = origin;
    this.bridgeKey = bridgeKey;
    this.sessions = sessions || [];
    this.state = {
      running: false,
      stopRequested: false,
      total: 0,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: null,
      finishedAt: null,
      prompt: "",
      concurrency: 1,
      results: [],
    };
  }

  status() {
    return { ...this.state };
  }

  stop() {
    if (!this.state.running) return { ok: true, note: "not running" };
    this.state.stopRequested = true;
    return { ok: true, note: "stop requested; in-flight requests finish" };
  }

  start({ sessionIds = [], prompt = "1+1=", concurrency = 1 } = {}) {
    if (this.state.running) return { ok: false, error: "batch test already running" };
    const text = String(prompt || "").trim();
    if (!text) return { ok: false, error: "prompt 不能为空" };
    const ids = [...new Set(sessionIds.filter(Boolean))];
    if (!ids.length) return { ok: false, error: "请至少选择一个 session" };

    const byId = new Map(this.sessions.map((s) => [s.sessionId, s]));
    const targets = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!targets.length) return { ok: false, error: "所选 session 不在归档中" };

    Object.assign(this.state, {
      running: true,
      stopRequested: false,
      total: targets.length,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      prompt: text,
      concurrency: Math.max(1, Math.min(8, Number(concurrency) || 1)),
      results: [],
    });

    this.#run(targets, text, this.state.concurrency)
      .catch(() => undefined)
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = Date.now();
      });

    return { ok: true, total: targets.length };
  }

  async #one(target, prompt) {
    const startedAt = Date.now();
    const result = {
      sessionId: target.sessionId,
      model: target.model || target.title || target.sessionId,
      ok: false,
      ms: 0,
      text: "",
      error: null,
    };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 180_000);
      const r = await fetch(`${this.origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.bridgeKey}`,
        },
        body: JSON.stringify({ model: target.sessionId, messages: [{ role: "user", content: prompt }] }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        result.error = body?.error?.message || `HTTP ${r.status}`;
        return result;
      }
      result.ok = true;
      result.text = String(body?.choices?.[0]?.message?.content || "").slice(0, 4000);
      result.usage = body?.usage || null;
      return result;
    } catch (error) {
      result.error = error?.name === "AbortError" ? "超时（180s）" : error?.message || String(error);
      return result;
    } finally {
      result.ms = Date.now() - startedAt;
    }
  }

  async #run(targets, prompt, concurrency) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        if (this.state.stopRequested) return;
        const target = targets[cursor++];
        const result = await this.#one(target, prompt);
        this.state.results.push(result);
        if (result.ok) this.state.ok += 1;
        else this.state.failed += 1;
        this.state.done += 1;
        if (this.state.results.length > MAX_KEEP) this.state.results.shift();
      }
    });
    await Promise.all(workers);
  }
}
