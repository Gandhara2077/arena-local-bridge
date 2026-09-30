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
| `GET /health` | Health check |
| `GET /v1/models` | Local model list |
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `GET /` | Local operations UI |

## Requirements

- Node.js **20+**
- An Arena.ai account that you are authorized to use
- A Chromium-based browser on the host — **Chrome or Edge is enough**. Playwright's own Chromium is only a
  fallback: `npx playwright install chromium`

The bridge is for **your own account**. It provides no Arena API key and does not bypass authentication or quotas.

## Quick start

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
- **Local MCP** — optional. When the tunnel is up, the agent is told where to work and can read and write files
  in your workspace. A turn that fails before Arena receives the message does not spend the one-shot preamble.
- **Harvesting and batch testing** — create and drive many sessions at once.
- **Local operations UI** — sessions, pools, bindings, accounts and quota at a glance.

## Portable release

For a machine without Node, build a self-contained archive:

~~~bash
npm run package:portable -- --node "C:\Program Files\nodejs"
~~~

Unzip `dist/` and double-click **`start-gui.bat`**. This is a Node application, so there is no single-file
`.exe` and no installer; nothing in the archive downloads anything, and the browser it drives is still the one
already on your machine.

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

![Repository Traffic](./assets/traffic.svg)


## License

MIT. See [LICENSE](LICENSE).
