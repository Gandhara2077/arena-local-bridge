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
- Optional Local MCP defaults to the self-built Node listener on `127.0.0.1`. It requires an explicitly selected
  workspace, bearer authentication, and rejects every browser Origin. File tools deny DATA_DIR, allow workspace
  read/write, and allow configured skill roots read-only. `exec_command` runs with the bridge user's full
  permissions; pinning its cwd is not a sandbox (ADR 0011).
- Public transport requires an explicit absolute cloudflared executable path. Endpoint credentials and process
  records stay inside DATA_DIR, including resolved symlink targets. Publication carries this instance's owner
  and selected workspace; startup refuses conflicting records and stop revokes only owned records.
  If child termination fails, the old port remains bound with a refusal handler until exit is confirmed, so a
  still-running tunnel cannot expose another local service that reuses that port.

## Data flows

Normal operation communicates with Arena.ai.

Model identification reads Arena's execution trace back from **trigger.dev** (`api.trigger.dev` run/trace
endpoints), using the short-lived public run token the Arena page is given for that run. This is an intentional
part of the identification mechanism and should be considered when evaluating privacy and availability.

Optional proxy/tunnel integrations can introduce additional network destinations; enable them only when you
understand their trust model.

## Operational guidance

- Keep the bridge bound to 127.0.0.1 unless an authenticated trusted proxy is used.
- Treat the Arena account password, cookies, encryption key and bridge bearer key as secrets.
- Do not commit runtime data or .env files.
- Review optional proxy/tunnel configuration before enabling it.
- Treat a public MCP URL and bearer token as local-tool authority. Stop the tunnel after use. AgentDock is an
  explicitly selected optional legacy integration; the default path requires no third-party closed-source runtime.
- Remember that model identification traffic reaches trigger.dev.
