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

### Manual numeric fingerprinting (experimental)

The dashboard's **补标** action first tries the execution-trace probe. If it cannot identify a model, it tries
a numeric fingerprint: one Arena turn asks for integers and compares the reply with the local bank. This
consumes an additional turn only when the bank is ready, and the prompt becomes part of that Session's history.

Both endpoints require the bridge bearer key:

- `GET /api/fingerprint/status` reports bank readiness without sending an Arena turn.
- `POST /api/pool/fingerprint-reprobe` accepts `{"sessionId":"<UUID>","dryRun":true}`. Optional `variant`
  selects a probe template; the default is `v1-instant`.
- `dryRun: true` still sends a probe turn when the bank is ready, but changes neither the fingerprint bank
  nor the archive. With `dryRun` omitted or false, the reply is stored in `DATA_DIR/fingerprint-bank.json`.
- Only an attribution passing both the confidence and raw-margin gates updates the archive's Model.
  An unresolved result reports `nearMiss`, `margin`, and `confidence` without changing the archived Model.
  These are statistical inferences, not verified model identities; confidence is not a measured accuracy rate.

The default raw-margin gate is 1.2 for two models. For larger banks it is capped at the winning model's own
centroid margin against its nearest rival, so an ideal match is not rejected solely by bank geometry.
This remains a conservative heuristic, not a calibrated false-positive or coverage guarantee; a correct
top candidate can still be left unresolved.

In the available external reference data's leave-one-condition-out checks, this default gate accepted
0/288 GPT replies and 0/324 Claude replies. The reported 95.1%/95.7% top-candidate accuracies exclude this
gate and therefore do not measure successful archive identification. Threshold calibration remains open.

The current dashboard does not initialize or label a bank; it requires a pre-existing local
`DATA_DIR/fingerprint-bank.json`. An empty or insufficient bank returns a failure without spending a
fingerprint turn. Automatic fingerprinting during harvesting and automatic beta calibration are not
connected yet. Real Arena identification accuracy has not been established.

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

That token is delivered per **Trigger.dev task version**, and Arena locks a Session to the version current when it answered the create-chat request. Since 2026-09-30 the version Arena picks for new Sessions (see `triggerConfig.lockToVersion` in its own session response) no longer carries a run-scoped token at all, which makes the model name unreadable. To keep reading it, the browser layer sends that one request to the previous Arena deployment, whose Sessions still lock to the older version and still get the token — see `installDeploymentPin` in `src/arena-login.mjs`. Measured on arena.ai, the `__vdpl` cookie does not change which deployment answers document navigations or `/api/*` calls — Arena serves its web frontend and its API from two different deployments, and its own deployment headers take precedence — so the page and the rest of the context stay on the current deployment; the step is confined to the create-chat request.

Treat the result as dependent on Arena's current runtime implementation, not as a stable API contract. The pin is a stopgap on the same terms: it stops working when Arena removes that deployment, after which a Session created by the current deployment yields no token and the model reads as unknown. `ARENA_DEPLOYMENT_PIN` overrides the pinned deployment id; `ARENA_DEPLOYMENT_PIN=none` disables the pin (and with it, model identification for new Sessions).

## Local MCP and the workspace

Local MCP uses this project's self-built Node runtime by default. AgentDock is an **optional legacy
compatibility integration**, selected only with `ARENA_MCP_RUNTIME=agentdock` and an explicit
`ARENA_AGENTDOCK_DIR`; there is no Downloads/install-directory discovery.

Start from the GUI with an existing absolute workspace, or configure `ARENA_MCP_WORKSPACE`.
`POST /api/mcp/start` accepts `{"workspace":"<absolute directory>"}` behind the bridge bearer key.
The listener binds only to `127.0.0.1`, with `ARENA_LOCAL_MCP_PORT=8765` by default. All six tools work locally
without AgentDock. `exec_command` is a shell running with the bridge user's permissions; its cwd is pinned
inside the workspace, but the command is not sandboxed (ADR 0011).

For remote Arena access, explicitly set `ARENA_CLOUDFLARED_PATH` to an already-installed open-source
cloudflared executable's **absolute path**. Nothing downloads it automatically. Without it, status shows a
local listener (`localUrl`), no public URL, and `bridgeInjecting: false`. Only a successfully published tunnel
is injected. Startup failure, tunnel exit and stop revoke this instance's public record. If the OS refuses to
terminate a tunnel, access is revoked immediately and the old loopback port stays occupied by a refusal handler
until child exit is confirmed. Status reports `cleanupPending`; retry stop before starting again.
Other instances' endpoint/PID records are never adopted or removed by the default runtime. A stale reservation
after a crash must be inspected and resolved explicitly; startup refuses to overwrite it.

When the explicit public tunnel is up, the bridge prepends a short preamble to the session once, so the agent
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

Rule 2 exists because the default self-built MCP rejects relative paths; the optional legacy AgentDock
integration resolves them against `~/AgentDock`, which is not your project. Rule 3 exists
because an agent that only pastes content into its reply has not delivered a file.

The preamble is sent **once per session**, and only while the tunnel is up. It is kept short on purpose: a long
first message raises Arena's reCAPTCHA risk. Internal probes (体检) do **not** consume it, and neither does a turn
that fails before Arena receives the message: it is spent only once the prompt is really out, so a failed turn
does not cost the user a re-injection.

### Workspace authorization and conversation hints

The runtime grants **one explicitly selected startup workspace**. Configuration or the GUI startup body can
grant it; a client header or a discovered Codex transcript cannot add roots. Repeated/concurrent starts reuse
the same grant. A different startup workspace returns `409`; stop before switching.

Conversation hints are resolved separately and must remain inside that authorized workspace. A recognized
conflicting directory returns `409` for manual reinjection and ordinary chat, even after the first preamble was
spent. DATA_DIR remains private, and configured skills remain read-only.

Highest priority first:

1. The caller's request header `x-arena-workspace` — always wins when present. Only **absolute** paths are
   accepted (drive letter, UNC or POSIX); a relative path is ignored rather than forwarded.
2. Auto-detected from the Codex session. Codex writes one transcript per conversation at
   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl`, recording the working directory it ran in,
   and sends the same id as `x-codex-session-id` — so the bridge recovers the directory with no client-side
   configuration at all. Override the root with `ARENA_CODEX_SESSIONS_DIR`.
3. The single recent Codex transcript, if exactly one is attributable.
4. The explicit workspace recorded in this instance's published Local MCP endpoint. A GUI start therefore
   works for reinjection and chat without client headers, Codex association or a configured default. A startup
   body overrides the configured startup default.
5. In legacy mode, `ARENA_MCP_WORKSPACE`, or the launcher's plain-text `mcp-workspace.txt` next to `archive-dir.txt`.
6. In legacy compatibility mode only, no hint may leave the preamble without a workspace line.

Detection never guesses: an unrecognised session id resolves to nothing and falls through, so a missing
transcript cannot silently point the agent at the wrong project. The log's `workspaceFrom` records which source
was used (`request-header | codex-session | codex-recent | config | local-runtime | none`).

A local proxy between the client and this bridge can drop custom headers entirely. If a header you configured
never shows up, check the bridge's `workspace hints` log line, which reports the `x-*` headers that actually
arrived.

### The manual re-injection boundary

The default runtime can reuse the explicitly selected workspace from its owned public endpoint; no new
persistent Session-to-workspace mapping is established. The dashboard enables *re-inject* only after a public
tunnel is published, and it arms the next real turn instead of sending a message by itself.

In legacy mode, the dashboard's *re-inject* button carries no request and no Codex conversation of its own, so it can only reuse
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

The Windows x64 portable release includes **ArenaLocalBridge.exe**, the Node runtime, the web GUI and its
dependencies. Extract the entire ZIP to a writable directory, keep its files together, and double-click
**ArenaLocalBridge.exe**. The executable is a lightweight launcher for the bundled Node application; it waits
for `/health` before opening the GUI and does not require a separate Node or npm installation.

For a new account, enter your Arena email and password in the **账号额度** panel on **模型归档 / 连接** and choose
**登录并保存 / Sign in**. Use `stop-gui.bat` or `ArenaLocalBridge.exe --stop` to stop this installation.

Maintainers: install source dependencies and obtain an official **Windows x64 Node.js 22** distribution with
its `LICENSE`, then build and package on Windows:

~~~powershell
npm ci
npm run build:launcher
npm run package:portable -- --node "C:\release-tools\node-win-x64"
~~~

`build:launcher` uses the Windows .NET Framework compiler without downloading build tools. Packaging defaults
to `dist/ArenaLocalBridge.exe`; `--launcher <exe>` selects another build. The selected Node runtime's `LICENSE`
must be beside its executable, or supplied with `--node-license <file>`; the archive includes it at
`runtime/LICENSE`. Missing required assets stop packaging before previous outputs are replaced.

The archive lands in `dist/` with platform and architecture in its filename, for example
`arena-bridge-portable-1.1.0-win32-x64.zip`. It uses installed Edge or Chrome, bundles no Chromium, and downloads
no dependencies automatically. Windows 10/11 x64 is the supported portable path; source installations can
run wherever Node 20+ and a compatible browser are available.

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
