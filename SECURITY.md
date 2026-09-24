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

## Operational guidance

- Keep the bridge bound to 127.0.0.1 unless an authenticated trusted proxy is used.
- Treat the Arena account password, cookies, encryption key and bridge bearer key as secrets.
- Do not commit runtime data or .env files.
- Review optional proxy/tunnel configuration before enabling it.
- Remember that model-identification fallback traffic can reach trigger.dev.