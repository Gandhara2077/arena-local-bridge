# Arena Local Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

Run your own [Arena.ai](https://arena.ai) Agent Mode sessions through a local **OpenAI-compatible API**.

The project combines the browser/session bridge from [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge) with additional local tooling for:

- persistent Arena sessions;
- batch session harvesting;
- model identification;
- model-result archival;
- batch prompt testing;
- a local operations UI.

> **Project status:** early-stage OSS. Arena's web application and undocumented runtime behavior can change without notice. Expect maintenance when Arena changes its frontend, authentication flow, or telemetry format.

## What it does

~~~text
Your local agent / client
        │
        │ OpenAI-compatible HTTP
        ▼
┌──────────────────────────┐
│     Arena Local Bridge   │
│                          │
│  session management      │
│  browser automation      │
│  OpenAI-compatible API   │
│  harvesting / testing    │
│  model archival          │
└────────────┬─────────────┘
             │
             ▼
        arena.ai Agent Mode
~~~

The bridge binds to 127.0.0.1 by default and exposes:

| Endpoint | Purpose |
| --- | --- |
| GET /health | Health check |
| GET /v1/models | Local model list |
| POST /v1/chat/completions | OpenAI-compatible chat endpoint |
| GET / | Local operations UI |

## Requirements

- Node.js **20+**
- An Arena.ai account that you are authorized to use
- Chromium/Playwright support on the host

The project is intended for your **own account**. It does not provide an Arena API key or bypass account authentication.

## Quick start

~~~bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git
cd arena-local-bridge

npm install
npx playwright install chromium

node bin/login.mjs --email you@example.com --password 'your-password'
node src/index.mjs
~~~

The service listens on:

http://127.0.0.1:20140

For the bundled GUI, use the platform-specific startup helper where available:

~~~bash
bash install.sh
~~~

or on Windows:

~~~text
start-gui.bat
~~~

See [SKILL.md](SKILL.md) for the detailed agent-oriented workflow.

## API example

Set a local bearer key first:

~~~bash
export ARENA_AGENT_BRIDGE_KEY='replace-with-a-random-secret'
~~~

Then:

~~~bash
curl -X POST http://127.0.0.1:20140/v1/chat/completions \
  -H "Authorization: Bearer $ARENA_AGENT_BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -H "x-codex-session-id: agent-01" \
  -d '{
    "model": "agent",
    "stream": false,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
~~~

The x-codex-session-id header lets clients keep separate persistent Arena sessions.

## Repository layout

~~~text
src/        Core bridge, server, browser/session handling, harvesting and UI
bin/        Login, session, verification and diagnostic helpers
test/       Node.js test suite
prompts/    Optional installation prompts
assets/     Public project assets
docs/       Public documentation
~~~

## Model identification

Arena does not normally expose the underlying model name in its user-facing blind-battle UI.

This project has two identification paths:

1. a locally supplied page probe, when available;
2. a Node-side fallback that reads the public run trace exposed for the current session.

The optional probe file assets/arena-model-probe.inject.js is **not distributed by this repository** because its licensing/provenance could not be established. The repository therefore remains functional without it.

Model identification is inherently dependent on Arena's current runtime behavior and should not be treated as a permanent public API.

## Model pools

Archived sessions are presented as **model pools**: every pool is one Model, and holds all the
Sessions identified as that Model. Sessions whose Model could not be identified are not a Model —
they go into a separate **未识别** bucket, and you can re-run identification on demand (补标).

A pool is an **index, not a scheduler**. It never picks a Session for you, because conversation
context lives on the Arena side and is bound to one specific Session: switching Sessions silently
would drop that context. You pick; the pool only helps you see what you have and find it again.

### Session bindings

When a client passes a session UUID as `model`, that is an explicit choice, and the bridge records
a **binding** between the client's conversation id (from the `x-codex-session-id` request header,
falling back to `x-arena-session-id`) and that Session. Later requests carrying the same header
return to the same Session, so the conversation keeps its context.

- Bindings are only created by an explicit choice. `model: "active"` does **not** bind.
- If a bound Session is later marked suspected-dead, the request fails with **409
  `bound_session_dead`** rather than silently switching to another Session and answering with a
  different conversation. Pick another Session, or drop the binding.
- `GET /api/pool/bindings` lists the current bindings; the GUI shows them under 会话绑定.
  `POST /api/pool/unbind` (body: `{"clientId": "…"}`) drops one.

### Session health

`GET /api/sessions` returns `groups` (the pools) alongside the flat `sessions` list. Each Session
carries a state of `ok` or `suspected-dead`.

- A Session is marked **suspected-dead** when a request against it actually fails. That is the only
  trusted signal: there is no time-based decay and no health score.
- `POST /api/pool/verify` (body: `{"sessionId": "<uuid>"}`) runs a manual check by driving **one real
  turn** with a unique nonce, then marking the session alive or suspected-dead. A page that merely
  renders is not proof a session can still answer, and a *fixed* probe string would be served from
  the bridge's idempotency cache without ever reaching Arena — hence the nonce.
  **This appends one short message to that session's transcript.** It is manual by design: no
  background polling, so nothing burns session lifetime on your behalf.
- `POST /api/pool/reprobe` (body: `{"sessionId": "<uuid>"}`) re-runs model identification for one
  session and, if a Model is found, writes it back into `记录.json`.

Health state is stored in a sidecar file (`pool-state.json` in the data directory) that holds only
session state and bindings. `记录.json` remains the single source of truth for session data, and the
sidecar can be deleted — every Session then simply reads as `ok` again.

## Accounts

Signing in successfully is **not** the same as having a usable account. Arena returns `200` from its
sign-in endpoint and hands out a valid auth cookie for an account it has quietly restricted, then
serves every session to that account as a visitor. `login()` therefore proves the session by
fetching `/agent` and checking that the server payload carries the account's own email — that check
was validated against a known-restricted account and a known-good one, and it flips between them.

Because of that, the bridge keeps a **pool** of accounts and will not use one it cannot serve:

- An account that signs in but fails the usability check is **disabled with a reason** instead of
  being driven as if it worked. `/health` lists every account and its state.
- At boot, and whenever a cookie approaches expiry, the bridge walks the pool by priority until one
  account both signs in and is usable. A rejected account is skipped and the next one is tried.
- `node bin/accounts.mjs list | add | disable | enable | priority` manages the pool. `add` verifies
  the account before storing it. Lower `priority` wins; `0` is valid.
- An account that logs in successfully is re-enabled automatically, so recovery needs no manual step.

If every account ends up disabled, the bridge refuses to start rather than driving a dead session,
and says which accounts failed and why.

## Local MCP (letting the Arena agent work on this machine)

When the local AgentDock MCP tunnel is up, the bridge prepends a short preamble to the session once,
so the agent knows where to work and what "delivering a file" means:

```
[本地 MCP 已接入] endpoint: https://<tunnel>/mcp
header: Authorization: Bearer <token>
本地工作区: <your workspace>
约定:
1) 读写本地文件一律走 MCP 工具（read_file / list_dir / search_text / file_edit / exec_command）。
2) MCP 的相对路径解析到 ~/AgentDock，不是工作区——要落到工作区请传绝对路径。
3) 你生成的文件必须写回本地（file_edit action=add 或 replace），不要只在回复里贴内容。
4) 需要交付给人的产物用 file_publish 发布成 artifact。
```

**Why rule 2 is there:** AgentDock resolves relative paths against `~/AgentDock`, which is *not* your
project. An agent that writes `report.md` with a relative path puts it somewhere you will never look.
Rule 3 exists because an agent that only pastes generated content into its reply has not delivered a file.

**Where the workspace comes from**, highest priority first:

1. **The caller's request header** `x-arena-workspace` — always wins when present.
2. **Auto-detected from the Codex session.** Codex writes one transcript per conversation at
   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl`, and the transcript records the
   working directory it ran in. Codex sends that same id as `x-codex-session-id`, so the bridge can
   recover the directory this conversation belongs to **with no client-side configuration at all** —
   each project's Codex run reports its own path automatically. Override the root with
   `ARENA_CODEX_SESSIONS_DIR` if your Codex data lives elsewhere.
3. `ARENA_MCP_WORKSPACE`, or a plain-text file named `mcp-workspace.txt` next to `archive-dir.txt`
   (the launcher picks it up the same way it picks up `ARENA_ARCHIVE_DIR`).
4. None apply → the preamble omits the workspace line.

Detection never guesses: an unrecognised session id resolves to nothing and falls through, so a
missing transcript cannot silently point the agent at the wrong project. That is also why the
"single active transcript" fallback stays silent whenever more than one transcript was written
recently — two active conversations cannot be attributed to either caller. The bridge logs which
source it used (`workspaceFrom: request-header | codex-session | codex-recent | config | none`).

> **Implementation-dependent:** the Codex detection reads Codex's own on-disk transcripts
> (`~/.codex/sessions/…/rollout-*.jsonl` and their `cwd` field). That layout is undocumented and not
> a public interface, so it can change with any Codex release. When it breaks, the feature degrades
> to "no workspace" rather than a wrong one, and `ARENA_MCP_WORKSPACE` / the request header remain
> the stable paths. Set `ARENA_CODEX_SESSIONS_DIR` if Codex stores its data elsewhere.

Note that a local proxy between the client and this bridge can drop custom headers entirely. If a
header you configured never shows up, check the bridge's `workspace hints` log line, which reports
the `x-*` headers that actually arrived. When using a proxy or gateway, make sure it preserves the
request headers required by your client integration.

Only **absolute** paths are accepted from the header (drive letter, UNC, or POSIX). A relative path is
ignored rather than forwarded, because AgentDock would resolve it against `~/AgentDock` — the exact
mistake the line exists to prevent.

The header is read on the turn that injects the preamble, so a client that sends it on every request
needs no extra care. Internal probes (`体检`) do **not** consume the one-shot preamble.

The preamble is sent **once per session**, and only while the tunnel is up; it is kept short on purpose
because a long first message raises Arena's reCAPTCHA risk.

## Security model

The bridge handles highly sensitive local data because it stores Arena authentication state.

- Credentials are encrypted at rest with AES-256-GCM.
- Credential files are written with restrictive file permissions where supported.
- The HTTP service binds to 127.0.0.1 by default.
- Runtime state, cookies, credentials, .env files and tunnel metadata are excluded by .gitignore.
- Do **not** expose the local HTTP port to an untrusted network.
- Use a strong ARENA_AGENT_BRIDGE_KEY for API access.
- Review SECURITY.md before deploying the bridge on a shared machine.

### Data flows

Normal operation communicates with Arena.ai.

The model-identification fallback can additionally query **trigger.dev** run/trace endpoints using the public run token exposed by the current Arena session. This is an intentional part of the identification mechanism and should be considered when evaluating privacy and availability.

Optional proxy/tunnel integrations can introduce additional network destinations; enable them only when you understand their trust model.

## Development

Run the test suite with:

~~~bash
npm test
~~~

The repository uses Node's built-in test runner. Pull requests should keep the test suite passing and should add regression coverage for behavior that is difficult to validate manually.

## Limitations

This project depends on behavior that Arena.ai does not necessarily document as a stable public API. In particular:

- browser selectors and page structure can change;
- authentication and anti-bot behavior can change;
- runtime trace formats can change;
- model-identification behavior can change;
- Arena account or service policies can change.

This project does not guarantee compatibility with future Arena releases.

## Attribution

The core bridge is derived from [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge), released under the MIT License. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for attribution and third-party provenance.

No code from the separately referenced Arena Model Assistant probe is distributed with this repository.

## License

MIT. See [LICENSE](LICENSE).
