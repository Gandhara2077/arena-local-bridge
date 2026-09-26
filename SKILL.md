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

Then start the bridge:

~~~bash
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

The repository ships its own page probe: source in `src/probe/modules/*.js`, assembled by `bin/build-probe.mjs` into `assets/arena-model-probe.inject.js`. It hooks the network traffic the page already performs, so the model name and the reasoning tier come from the trace the page fetched itself — no run token, no extra request.

Treat the result as dependent on Arena's current runtime implementation, not as a stable API contract.

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