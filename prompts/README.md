# Arena Local Bridge — installation prompt

This directory contains the installation prompt for the current repository.

## Recommended

Use the repository directly:

~~~bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git ~/arena-local-bridge
cd ~/arena-local-bridge
bash install.sh
~~~

The installer checks Node.js, installs Playwright/Chromium, prepares the local data directory, and can then guide the user through login and startup.

## Security

- Use only the user's own Arena.ai account.
- Never place real credentials, cookies, bridge keys, or runtime data in this repository.
- Keep the service bound to 127.0.0.1 unless a trusted authenticated proxy is deliberately configured.
- Review SECURITY.md before enabling optional proxy or tunnel features.

The older upstream project is documented in NOTICE.md for attribution; installation instructions in this repository must always target arena-local-bridge itself.