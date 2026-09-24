# Arena Local Bridge

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

---

**English / 简体中文:** [README.zh-CN.md](README.zh-CN.md)