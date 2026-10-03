# Arena Local Bridge v1.1.0

Windows users can now extract the portable ZIP and double-click **ArenaLocalBridge.exe** to open the existing
web GUI without installing Node or npm. The small executable starts the bundled Node application and waits
for HTTP health before opening the browser. A fresh installation can reach the GUI before Arena login;
account readiness remains separate from service health.

- A Windows x64 launcher supports repeated launches and stopping its own installation without terminating
  an unrelated process that uses the same port.
- Model identification has a numeric fingerprint fallback and tracks unresolved results so unknown models
  are not selected as identified ones.
- Local MCP offers a recent workspace picker and checks conversation workspaces against the selected grant.
  It uses the project's own runtime by default; AgentDock remains an explicitly selected legacy option.
- Account browsers are isolated by account and purpose, with retry and idempotency fixes that keep session
  operations consistent.
- The portable archive includes Node.js **22.23.3** and `runtime/LICENSE`, with platform and architecture in
  the filename: **arena-bridge-portable-1.1.0-win32-x64.zip**. `SHA256SUMS.txt` accompanies the release assets.
- The release uses installed Edge or Chrome. Chromium, AgentDock, personal state and credentials are excluded;
  no dependency is downloaded automatically.
- Required launcher files and the Node license are checked before previous packaging outputs are replaced.
  Packaging accepts paths containing spaces and apostrophes.
- Unreadable or corrupt archives are preserved when an operation fails, rather than being replaced by an
  empty archive.

For a new installation, extract the entire ZIP into a writable directory, start **ArenaLocalBridge.exe**,
and enter your Arena email and password in the **账号额度** panel on **模型归档 / 连接**; choose
**登录并保存 / Sign in** to finish login. Windows 10/11 x64 and an installed Edge or Chrome browser are required.
The launcher uses the .NET Framework runtime included with Windows. The executable must remain beside its
bundled runtime and app files.

To upgrade, close the previous bridge from its original console or stop its verified process, back up and
retain its **.arena-gui** directory, then replace the application files. Account configuration and session data
live in that directory. Once v1.1.0 is running, **stop-gui.bat** or `ArenaLocalBridge.exe --stop` stops its own
installation.
