---
name: arena-local-bridge
description: >
  Run Arena.ai Agent Mode sessions through a local OpenAI-compatible bridge.
  Supports persistent sessions, local API access, harvesting and batch testing.
---

# Arena Local Bridge

Use this skill when the user wants to operate Arena.ai Agent Mode through the local Arena Local Bridge.

## Scope

The bridge:

1. logs into the user's own Arena.ai account;
2. stores the resulting credentials/session state locally in encrypted form;
3. exposes Arena Agent Mode through a local OpenAI-compatible HTTP endpoint;
4. supports multiple persistent sessions identified by x-codex-session-id;
5. optionally supports session harvesting, model identification, archival and batch testing.

Do not describe this project as an official Arena.ai API or as a bypass for Arena authentication or quotas.

## Install

Requirements: Node.js 20+.

~~~bash
cd <skill-dir>
npm install
npx playwright install chromium
~~~

Log in with the user's own credentials:

~~~bash
node bin/login.mjs --email <email> --password '<password>'
~~~

The bridge refuses to start without a bearer key for its own API, and `login.mjs` does not create one — it only
provisions `STORAGE_ENCRYPTION_KEY`. Set `ARENA_AGENT_BRIDGE_KEY` (or let `install.sh` generate it and persist it
in `DATA_DIR/.env`) before starting:

~~~bash
export ARENA_AGENT_BRIDGE_KEY="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
node src/index.mjs
~~~

Check:

~~~bash
curl -s http://127.0.0.1:20140/health
~~~

## API

Chat requests use:

~~~text
POST http://127.0.0.1:20140/v1/chat/completions
Authorization: Bearer <ARENA_AGENT_BRIDGE_KEY>
Content-Type: application/json
~~~

Example:

~~~bash
curl -X POST http://127.0.0.1:20140/v1/chat/completions \
  -H "Authorization: Bearer $ARENA_AGENT_BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -H "x-codex-session-id: agent-01" \
  -d '{"model":"agent","stream":false,"messages":[{"role":"user","content":"Hello"}]}'
~~~

Each distinct x-codex-session-id can map to a persistent Arena session. Keep identifiers stable when continuity is required.

## Sessions and pools

Archived sessions are presented as **model pools**: every pool is one Model and holds every Session identified
as that Model. A Session whose Model could not be identified is not a Model — it goes into a separate **未识别**
bucket, and identification can be re-run on demand (补标).

A pool is an **index, not a scheduler**. It never picks a Session for you: conversation context lives on Arena's
side and is bound to one specific Session, so switching Sessions silently would drop that context.

### Bindings

When a client passes a session UUID as `model`, that is an explicit choice, and the bridge records a **binding**
between the client's conversation id (from `x-codex-session-id`, falling back to `x-arena-session-id`) and that
Session. Later requests carrying the same header return to the same Session.

- Only an explicit choice creates a binding. `model: "active"` does **not**.
- If a bound Session is later marked suspected-dead, the request fails with **409 `bound_session_dead`** instead
  of silently answering from a different conversation.
- `GET /api/pool/bindings` lists the current bindings (the GUI shows them under 会话绑定); `POST /api/pool/unbind`
  (body `{"clientId": "…"}`) drops one.

### Session health

`GET /api/sessions` returns `groups` (the pools) alongside the flat `sessions` list. Each Session carries a state
of `ok` or `suspected-dead`.

- A Session is marked **suspected-dead** only when a request against it actually fails. There is no time-based
  decay and no health score.
- `POST /api/pool/verify` (body `{"sessionId": "<uuid>"}`) drives **one real turn** with a unique nonce and then
  marks the Session alive or suspected-dead. A page that merely renders is not proof a session can still answer,
  so the check really asks something, and the nonce keeps every run a distinct turn. **This appends one short
  message to that session's transcript.** It is manual by design — nothing polls in the background.
- `POST /api/pool/reprobe` (body `{"sessionId": "<uuid>"}`) re-runs model identification for one session and, if
  a Model is found, writes it back into `记录.json`.

Health state lives in a sidecar file (`pool-state.json` in the data directory) holding only session state and
bindings. `记录.json` remains the single source of truth, and the sidecar can be deleted — every Session then
simply reads as `ok` again.

## Accounts

Signing in successfully is **not** the same as having a usable account. Arena returns `200` and hands out a valid
auth cookie for an account it has quietly restricted, then serves every session to that account as a visitor.
`login()` therefore proves the session by fetching `/agent` and checking that the server payload carries the
account's own email.

The bridge keeps a **pool** of accounts and will not use one it cannot serve:

- An account that signs in but fails the usability check is **disabled with a reason**, not driven as if it worked.
- At boot, and whenever a cookie approaches expiry, the bridge walks the pool by priority until one account both
  signs in and is usable. A rejected account is skipped and the next one is tried.
- `node bin/accounts.mjs list | add | disable | enable | priority` manages the pool; `add` verifies the account
  before storing it. Lower `priority` wins, and `0` is valid.
- An account that logs in successfully is re-enabled automatically, so recovery needs no manual step.

If every account ends up disabled, the bridge refuses to start rather than driving a dead session, and says which
accounts failed and why.

## Security

Treat this bridge as a local credential-bearing service.

- Keep HOST at 127.0.0.1 unless there is a deliberate authenticated proxy in front of it.
- Set a strong ARENA_AGENT_BRIDGE_KEY.
- Never place real passwords, cookies, bridge keys or runtime data in the repository.
- Runtime credentials are encrypted with AES-256-GCM.
- Do not paste credentials into issue reports, logs, prompts or pull requests.
- Do not claim that all network traffic stays within Arena.ai: model identification may query trigger.dev traces, and optional proxy/tunnel features may add other destinations.

## Model identification

Arena's blind-battle UI does not reliably expose the underlying model name.

The repository ships its own page probe: source in `src/probe/modules/*.js`, assembled by `bin/build-probe.mjs` into `assets/arena-model-probe.inject.js`.

Arena's response stream carries no model name, but the server hands the page a short-lived `public-access-token` — a JWT with `pub: true` and a `read:runs:<runId>` scope — for each run. The probe picks that token up from traffic the page already performs, then reads the run's own trace back from `api.trigger.dev`: the `ai.streamText.doStream` span carries the model name the worker wrote, and the trace also yields the reasoning tier. There is therefore no model API key to configure anywhere, and the trace reads go to Trigger.dev rather than to Arena — see [SECURITY.md](SECURITY.md).

Treat the result as dependent on Arena's current runtime implementation, not as a stable API contract.

## Local MCP and the workspace

When the local AgentDock MCP tunnel is up, the bridge prepends a short preamble to the session once, so the agent
knows where to work and what "delivering a file" means:

~~~text
[本地 MCP 已接入] endpoint: https://<tunnel>/mcp
header: Authorization: Bearer <token>
本地工作区: <your workspace>
约定:
1) 读写本地文件一律走 MCP 工具（read_file / list_dir / search_text / file_edit / exec_command）。
2) 一律传绝对路径：相对路径不会落到工作区（自建 MCP 直接拒绝；旧 AgentDock 会解析到 ~/AgentDock）。
3) 你生成的文件必须写回本地（file_edit action=add 或 replace），不要只在回复里贴内容。
4) 需要交付给人的产物用 file_publish 发布成 artifact。
~~~

Rule 2 exists because relative paths never land in the workspace: today's AgentDock upstream resolves them
against `~/AgentDock`, which is not your project, and our own MCP server rejects them outright. Rule 3 exists
because an agent that only pastes content into its reply has not delivered a file.

The preamble is sent **once per session**, and only while the tunnel is up. It is kept short on purpose: a long
first message raises Arena's reCAPTCHA risk. Internal probes (体检) do **not** consume it, and neither does a turn
that fails before Arena receives the message: it is spent only once the prompt is really out, so a failed turn
does not cost the user a re-injection.

### Where the workspace comes from

Highest priority first:

1. The caller's request header `x-arena-workspace` — always wins when present. Only **absolute** paths are
   accepted (drive letter, UNC or POSIX); a relative path is ignored rather than forwarded.
2. Auto-detected from the Codex session. Codex writes one transcript per conversation at
   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl`, recording the working directory it ran in,
   and sends the same id as `x-codex-session-id` — so the bridge recovers the directory with no client-side
   configuration at all. Override the root with `ARENA_CODEX_SESSIONS_DIR`.
3. `ARENA_MCP_WORKSPACE`, or a plain-text `mcp-workspace.txt` next to `archive-dir.txt`.
4. None apply → the preamble omits the workspace line.

Detection never guesses: an unrecognised session id resolves to nothing and falls through, so a missing
transcript cannot silently point the agent at the wrong project. The log's `workspaceFrom` records which source
was used (`request-header | codex-session | codex-recent | config | none`).

A local proxy between the client and this bridge can drop custom headers entirely. If a header you configured
never shows up, check the bridge's `workspace hints` log line, which reports the `x-*` headers that actually
arrived.

### The manual re-injection boundary

The dashboard's *re-inject* button carries no request and no Codex conversation of its own, so it can only reuse
what the bridge already learned while serving that Session. A Session that has **never** been served a turn here,
combined with **more than one** recently written transcript, therefore has nothing to attribute it to — and the
button refuses ("没认出工作区") rather than guess. Two ways out: run one real turn in the target project, which
teaches the bridge which directory that Session belongs to, or set a default via `ARENA_MCP_WORKSPACE` /
`mcp-workspace.txt`.

> **Implementation-dependent:** Codex detection reads Codex's own on-disk transcripts. That layout is
> undocumented and not a public interface, so it can change with any Codex release. When it breaks, the feature
> degrades to "no workspace" rather than a wrong one.

### Read-only skill roots (optional)

Beyond the workspace you can grant additional **read-only** directories — typically your global agent skills —
via `ARENA_SKILL_ROOTS` (absolute paths, separated by the platform path delimiter — `:` on POSIX, `;` on Windows):

~~~text
ARENA_SKILL_ROOTS=/home/me/.workbuddy/skills:/home/me/shared-prompts
ARENA_SKILL_ROOTS=C:\Users\me\.workbuddy\skills;D:\shared-prompts
~~~

Unset means no read-only roots at all — nothing outside the workspace is readable. Entries must be absolute and
must not overlap the workspace (a skill root that intersects it would silently be writable, so configuration is
refused), and the bridge data directory is denied regardless.

## Browser

On startup the bridge looks for a Chromium-based browser that is **already installed** — Chrome first, then Edge,
then one Playwright may have downloaded earlier — and uses that. Point at a specific one with `ARENA_AGENT_CHROME`:

~~~bash
export ARENA_AGENT_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"   # Windows
export ARENA_AGENT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # macOS
~~~

If nothing is found the bridge says where it looked and stops. It never downloads a browser on your behalf.

## Portable release

For a machine without a Node install, build a self-contained archive — the app, a Node runtime and the launcher:

~~~bash
npm run package:portable -- --node "C:\Program Files\nodejs"
~~~

The archive lands in `dist/` (~106 MB unpacked, ~36 MB zipped; bundling Playwright's Chromium would make it
350–700 MB, which is why there is none). Unzip it and double-click `start-gui.bat`.

The archive is a **Windows** artifact today — the platform the release targets, and `start-gui.bat` is the only
launcher it ships. The bridge itself runs anywhere Node does (`node src/index.mjs`, with `runtime/node` from the
archive), so a macOS or Linux user can use one, but that is not the packaged path.

## Harvesting and batch testing

These features can create multiple Arena sessions and send repeated prompts. Use them only with the user's own account and within applicable service limits.

Before running a large batch:

1. confirm the requested session count and prompt workload;
2. confirm the archive destination;
3. use conservative concurrency/rate limits;
4. stop when repeated failures indicate that Arena or the network is rejecting requests.

## Troubleshooting

Useful helpers:

~~~bash
node bin/verify-session.mjs <session-id>
node bin/verify-session.mjs <session-id> --probe "test message"
node bin/selftest.mjs
~~~

If Arena changes its authentication flow, browser structure, runtime trace schema or anti-bot behavior, expect the bridge to require maintenance.

## Development

Run:

~~~bash
npm test
~~~

Changes that affect session handling, credential storage, request parsing or authentication should include regression tests.