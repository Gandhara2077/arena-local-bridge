# Security Policy

## Scope

Arena Local Bridge handles Arena.ai credentials, session cookies and a local HTTP API. Security reports should focus on credential exposure, unintended network transmission, authentication failures, local privilege escalation, and unsafe handling of untrusted Arena content.

## Reporting a vulnerability

Please do not publish credentials, cookies, tokens, or a working exploit in a public issue.

Until a dedicated security contact is configured, report suspected vulnerabilities privately through the repository owner's GitHub contact channel. Include:

- affected version or commit;
- reproduction steps;
- expected and observed behavior;
- impact assessment;
- any relevant logs with secrets removed.

## How the bridge protects local data

- Arena credentials are encrypted at rest with AES-256-GCM.
- Credential files are written owner-only: mode `0600` on POSIX, and via `icacls` on Windows (which has no POSIX
  mode bits, so an ACL is the only mechanism that works there). A secret is written owner-only **or not written
  at all** — if the permissions cannot be set, the write fails rather than leaving a file the documentation calls
  private and the filesystem does not.
- The HTTP service binds to `127.0.0.1` by default and rejects requests whose Host and Origin are not loopback,
  so the API is not reachable from another host by accident.
- Runtime state, cookies, credentials, `.env` files and tunnel metadata are excluded by `.gitignore`.

## Data flows

Normal operation communicates with Arena.ai.

The execution-trace identification path can read Arena's trace from **trigger.dev** (`api.trigger.dev`
run/trace endpoints), when Arena exposes a short-lived public run token. Current agent-mode sessions may not
expose that token. The manual numeric-fingerprint path instead sends an ordinary Arena turn and scores the
reply locally. Its browser page also carries the existing trace probe, so trace traffic remains possible
when the required token is available. Probe replies are stored locally unless `dryRun` is true; see
[manual numeric fingerprinting](SKILL.md#manual-numeric-fingerprinting-experimental) for the archive-write boundaries.

Optional proxy/tunnel integrations can introduce additional network destinations; enable them only when you
understand their trust model.

## Operational guidance

- Keep the bridge bound to 127.0.0.1 unless an authenticated trusted proxy is used.
- Treat the Arena account password, cookies, encryption key and bridge bearer key as secrets.
- Do not commit runtime data or .env files.
- Review optional proxy/tunnel configuration before enabling it.
- Remember that trace probes can contact trigger.dev, while numeric probes consume an Arena turn.
