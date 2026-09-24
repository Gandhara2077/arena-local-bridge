// harvest.mjs — "连抽": create N fresh Arena sessions, ask which model
// answered, and archive each one in the Arena模型助手 layout.
//
// This replaces the C# helper's collection loop for our flow:
//   1. createAgentSession()  (already in bridge.mjs) -> new session + run token
//   2. probeModel()          (src/probe.mjs)         -> real model name
//   3. archive.appendEntry() (src/archive.mjs)       -> 记录.json + 清单/汇总
// The resulting archive is byte-compatible with what the helper produces, so
// the GUI, /v1/models and the converse-only driver all keep working unchanged.
import { installProbe, readModelFromPage, probeModel } from "./probe.mjs";
import { appendEntry } from "./archive.mjs";
import { log } from "./util.mjs";

const MAX_ROUNDS = 500;
const MAX_KEEP = 40;

export class Harvester {
  constructor({ bridge, credentials, archiveDir }) {
    this.bridge = bridge;
    this.credentials = credentials;
    this.archiveDir = archiveDir;
    this.state = {
      running: false,
      stopRequested: false,
      total: 0,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      current: null,
      rounds: [],
    };
  }

  status() {
    return { ...this.state, archiveDir: this.archiveDir };
  }

  stop() {
    if (!this.state.running) return { ok: true, note: "not running" };
    this.state.stopRequested = true;
    return { ok: true, note: "stop requested; finishes the current round" };
  }

  #push(round) {
    this.state.rounds.push(round);
    if (this.state.rounds.length > MAX_KEEP) this.state.rounds.shift();
  }

  async start({ count = 1, prompt = "1+1=", intervalMs = 3000 } = {}) {
    if (this.state.running) return { ok: false, error: "harvest already running" };
    if (!this.archiveDir) return { ok: false, error: "ARENA_ARCHIVE_DIR 未设置，无法写入归档" };
    const total = Math.max(0, Math.min(MAX_ROUNDS, Number(count) || 0));
    if (!total) return { ok: false, error: "次数必须大于 0" };
    const text = String(prompt || "").trim();
    if (!text) return { ok: false, error: "prompt 不能为空" };

    Object.assign(this.state, {
      running: true,
      stopRequested: false,
      total,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
      current: null,
      rounds: [],
    });

    // Runs detached; status is polled via GET /api/harvest/status.
    this.#run({ total, prompt: text, intervalMs: Math.max(0, Math.min(60_000, Number(intervalMs) || 0)) })
      .catch((error) => {
        this.state.lastError = error?.message || String(error);
        log.error("harvest", "fatal", { error: this.state.lastError });
      })
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = Date.now();
        this.state.current = null;
      });

    return { ok: true, total };
  }

  async #run({ total, prompt, intervalMs }) {
    const credential = this.credentials.primary();
    if (!credential) throw new Error("没有可用账号，先运行 bin/login.mjs 登录");

    // One page for the whole batch: createAgentSession() navigates to /agent
    // each round, so a single page is enough and avoids re-auth churn.
    const page = await this.bridge.browser.getPage(credential.cookieHeader, credential.updatedAt);

    // Reuse the Arena模型助手 probe verbatim: it hooks the page's own network
    // traffic, so model attribution matches what the helper reports.
    const installed = await installProbe(page);
    if (!installed.ok) log.warn("harvest", "probe not installed", { error: installed.error });
    let consecutiveFailures = 0;

    for (let i = 1; i <= total; i++) {
      if (this.state.stopRequested) break;
      const round = { index: i, startedAt: Date.now(), sessionId: null, model: null, ok: false, error: null };
      this.state.current = { index: i, phase: "创建会话" };
      this.#push(round);

      try {
        const state = await this.bridge.createAgentSession(page, prompt);
        round.sessionId = state.id;
        this.state.current = { index: i, phase: "识别模型", sessionId: state.id };

        let model = null;
        let provider = null;
        try {
          if (installed.ok) {
            const hit = await readModelFromPage(page, { timeoutMs: 45_000 });
            model = hit.model || null;
            round.via = hit.via;
            round.runId = hit.runId || null;
            if (!model) round.probeError = hit.error || "页面探针未识别出模型";
          }
          // Node-side fallback: same trigger.dev API, driven by the run token.
          if (!model && state.token) {
            const probe = await probeModel(state.token, { attempts: 5, intervalMs: 2_000 });
            model = probe.model || null;
            provider = probe.provider || null;
            round.via = probe.via;
          }
        } catch (error) {
          // A missing model name is NOT a failed round: the session exists and
          // is usable, we just could not attribute it (rate limit, slow trace).
          round.probeError = error?.message || String(error);
          log.warn("harvest", "probe failed", { sessionId: state.id, error: round.probeError });
        }

        const record = appendEntry(this.archiveDir, {
          sessionId: state.id,
          model: model || "",
          url: `https://arena.ai/agent/${state.id}`,
          email: credential.email,
          prompt,
          provider,
        });

        round.model = record.Model;
        round.ok = true;
        this.state.ok += 1;
        consecutiveFailures = 0;
        log.info("harvest", "round ok", { index: i, sessionId: state.id, model: record.Model });
      } catch (error) {
        round.error = error?.message || String(error);
        this.state.failed += 1;
        this.state.lastError = round.error;
        consecutiveFailures += 1;
        log.error("harvest", "round failed", { index: i, error: round.error });
        if (consecutiveFailures >= 3) {
          throw new Error(`连续 3 轮失败，已中止：${round.error}`);
        }
      } finally {
        round.ms = Date.now() - round.startedAt;
        this.state.done += 1;
      }

      if (i < total && intervalMs && !this.state.stopRequested) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }
}
