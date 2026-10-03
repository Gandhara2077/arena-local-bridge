# Arena Local Bridge

[![Test](https://github.com/Gandhara2077/arena-local-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Gandhara2077/arena-local-bridge/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#requirements)

[English](README.md) | [简体中文](README.zh-CN.md)

Run your own [Arena.ai](https://arena.ai) Agent Mode sessions through a local **OpenAI-compatible API**.

Any client that speaks the OpenAI protocol can drive a persistent Arena conversation — and, with the optional
local MCP tunnel, let that agent read and write files in your own workspace.

> **Project status:** early-stage OSS. The bridge depends on Arena's web application and undocumented runtime
> behaviour, both of which can change without notice. See [Limitations](#limitations).

## What it does

~~~text
your local agent / client
        │  OpenAI-compatible HTTP
        ▼
┌──────────────────────────────────────────────┐
│               Arena Local Bridge             │
│  persistent sessions · model identification  │
│  account pool · harvesting · batch testing   │
└───────────────────────┬──────────────────────┘
                        │  browser automation
                        ▼
                 arena.ai Agent Mode
~~~

It binds to `127.0.0.1` by default and exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Service health and account readiness status |
| `GET /ready` | Account readiness; HTTP 503 until an account is usable |
| `GET /v1/models` | Local model list |
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `GET /` | Local operations UI |

## Requirements

- Windows 10/11 **x64** for the portable release (uses the .NET Framework runtime included with Windows)
- Node.js **20+** for a source installation; the portable release includes Node.js 22
- An Arena.ai account that you are authorized to use
- A Chromium-based browser on the host — **Chrome or Edge is enough**. Playwright's own Chromium is only a
  fallback: `npx playwright install chromium`

The bridge is for **your own account**. It provides no Arena API key and does not bypass authentication or quotas.

## Quick start

On Windows, download **`arena-bridge-portable-1.1.0-win32-x64.zip`** from
[Releases](https://github.com/Gandhara2077/arena-local-bridge/releases), extract it to a writable directory,
and double-click **`ArenaLocalBridge.exe`**. The launcher starts the bundled Node runtime and opens the local
GUI after its HTTP health check succeeds. In the GUI's **账号额度** panel on **模型归档 / 连接**, enter your
Arena email and password, then choose **登录并保存 / Sign in** to complete your first Arena login.
The GUI can start before an account is signed in; API chat still needs a usable Arena account.

For a source installation:

~~~bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git
cd arena-local-bridge

bash install.sh --email you@example.com
~~~

`install.sh` generates the local keys, logs in with your own account and starts the bridge; it prints the bearer
key it wrote to `~/.arena-bridge/.env`. On Windows, double-click `start-gui.bat` instead.

Doing it by hand:

~~~bash
npm install

# The bridge refuses to start without a bearer key for its own API, and login.mjs does not create one.
export ARENA_AGENT_BRIDGE_KEY="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"

node bin/login.mjs --email you@example.com --password 'your-password'
node src/index.mjs
~~~

Either way the local operations UI is at <http://127.0.0.1:20140>.

## Using the API

Set a bearer key, then point any OpenAI-compatible client at `http://127.0.0.1:20140/v1`:

~~~bash
export ARENA_AGENT_BRIDGE_KEY='replace-with-a-random-secret'

curl -X POST http://127.0.0.1:20140/v1/chat/completions \
  -H "Authorization: Bearer $ARENA_AGENT_BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -H "x-codex-session-id: agent-01" \
  -d '{"model":"agent","stream":false,"messages":[{"role":"user","content":"Hello"}]}'
~~~

A stable `x-codex-session-id` keeps one persistent Arena session per client conversation.

## Features

- **Persistent sessions** — one Arena session per client conversation, keyed by a request header.
- **Model pools** — sessions grouped by identified model, with on-demand re-identification.
- **Account pool** — several accounts with priority and failover; an account that cannot actually be served is
  disabled with a reason instead of being driven as if it worked.
- **Model identification** — the model name and reasoning tier come from Arena's execution trace, which the
  probe reads back from Trigger.dev using the run token the page itself is given. There is no model API key to
  configure; see [SECURITY.md](SECURITY.md) for that network path.
- **Local MCP** — optional, with our self-built Node runtime as the default. All six tools work without
  AgentDock: read, list, search, edit, execute and publish. An explicitly enabled tunnel lets Arena reach them.
  A turn that fails before Arena receives the message does not spend the one-shot preamble.
  If manual re-injection cannot identify the workspace, choose a recent Codex workspace in the UI and confirm;
  the bridge never chooses a candidate for you. The choice applies to the next turn whose message reaches Arena,
  survives a failed send, and yields to that turn's explicit `x-arena-workspace` header.
  The bridge-key-protected `GET /api/mcp/workspaces` returns up to ten distinct candidates, newest first,
  as `{ workspace, lastWriteAt }` (ISO timestamp), without transcript contents or filenames. A missing Codex
  sessions directory returns an empty array, and the existing recovery hint remains available.
- **Harvesting and batch testing** — create and drive many sessions at once.
- **Local operations UI** — sessions, pools, bindings, accounts and quota at a glance.

To start Local MCP, enter an existing absolute workspace in the GUI, or set `ARENA_MCP_WORKSPACE`.
The listener binds only to `127.0.0.1` (`ARENA_LOCAL_MCP_PORT`, default `8765`). File tools allow that workspace
and explicit read-only `ARENA_SKILL_ROOTS`; they deny `DATA_DIR` and other directories. `exec_command` runs as
the bridge's local user: its starting directory is pinned, but it is **not a sandbox**.

Arena runs remotely and cannot reach a loopback URL. Opt in to public transport by setting
`ARENA_CLOUDFLARED_PATH` to an existing absolute path to the open-source cloudflared executable. It is never
downloaded automatically. Only a successfully published tunnel is injected into Arena. Treat its URL and token
as local-tool credentials and stop it after use. Startup errors or tunnel exits revoke this instance's endpoint.
Repeated starts share the selected workspace; stop before selecting a different one. A conversation naming a
workspace outside that grant receives HTTP `409`.

AgentDock is an optional legacy compatibility integration: choose `ARENA_MCP_RUNTIME=agentdock` and explicitly
set `ARENA_AGENTDOCK_DIR` to a directory containing both legacy executables. The default and portable release
do not need AgentDock, an install-directory search, or any third-party closed-source runtime.

## Portable release

The Windows x64 ZIP includes a lightweight **`ArenaLocalBridge.exe`** launcher, the Node runtime with its
license at `runtime/LICENSE`, the web GUI and application dependencies. Keep the extracted files together:
the executable launches this Node application; it is not a single-file bundle or an installer.
It uses your installed **Edge or Chrome**, bundles no Chromium, and performs no automatic dependency downloads.
The bridge still connects to Arena when you log in or send a message. Local MCP uses the self-built runtime
by default; AgentDock and cloudflared remain optional and are not bundled prerequisites.

Double-clicking the launcher again opens the same installation's GUI. Use **`stop-gui.bat`** or
`ArenaLocalBridge.exe --stop` to stop that installation. Before upgrading an older release, close the previous
bridge from its original console or stop its verified process, back up and retain the existing **`.arena-gui`**
directory, then replace the application files. This directory holds the portable
installation's configuration and account/session data.

Maintainers: install the source dependencies with `npm ci`, obtain an official **Windows x64 Node.js 22**
distribution including its `LICENSE`, then build and package on Windows:

~~~powershell
npm run build:launcher
npm run package:portable -- --node "C:\release-tools\node-win-x64"
~~~

`build:launcher` uses Windows' .NET Framework compiler without downloading build tools. The packager defaults
to `dist/ArenaLocalBridge.exe`; pass `--launcher <exe>` to use a different build. It reads the Node license
beside the selected runtime, or accepts `--node-license <file>` when that license is elsewhere. Missing required
assets or the Node license stop packaging before previous outputs are replaced. The output name includes the
platform and architecture, for example `dist/arena-bridge-portable-1.1.0-win32-x64.zip`.

Release assets include `SHA256SUMS.txt`. Check the downloaded archive with
`Get-FileHash .\arena-bridge-portable-1.1.0-win32-x64.zip -Algorithm SHA256` and compare its hash with that file.

## Documentation

| Document | Covers |
| --- | --- |
| [SKILL.md](SKILL.md) | Detailed workflow: API, sessions and pools, accounts, local MCP, troubleshooting |
| [SECURITY.md](SECURITY.md) | Security model, data flows, and how to report a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development, tests and repository layout |
| [NOTICE.md](NOTICE.md) | Upstream attribution |

## Security

Credentials are encrypted at rest with AES-256-GCM, and credential files are written owner-only. The HTTP
service binds to `127.0.0.1`: do **not** expose the port to an untrusted network, and use a strong
`ARENA_AGENT_BRIDGE_KEY`. Review [SECURITY.md](SECURITY.md) before running the bridge on a shared machine.

## Development

~~~bash
npm test
~~~

Node's built-in test runner. Keep the suite passing, and add regression coverage for behaviour that is hard to
verify by hand.

## Limitations

This project depends on Arena behaviour that is not documented as a stable public API — browser selectors and
page structure, authentication and anti-bot behaviour, and runtime trace formats can all change. Compatibility
with future Arena releases is not guaranteed.

## Attribution

The core bridge is derived from [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge),
released under the MIT License; its copyright notice is recorded in [NOTICE.md](NOTICE.md). The
model-identification probe is part of this project and ships as the single-file artifact
`assets/arena-model-probe.inject.js`.


## Repository Traffic

![Repository Traffic](https://raw.githubusercontent.com/Gandhara2077/arena-local-bridge/traffic-data/assets/traffic.svg)

Updated daily. Summary counts cover the latest 14 days; the chart retains daily history.


## License

MIT. See [LICENSE](LICENSE).
