# Arena Local Bridge

[![Test](https://github.com/Gandhara2077/arena-local-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Gandhara2077/arena-local-bridge/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#环境要求)

[English](README.md) | [简体中文](README.zh-CN.md)

通过本地 **OpenAI 兼容 API** 运行你自己的 [Arena.ai](https://arena.ai) Agent Mode 会话。

任何说 OpenAI 协议的客户端都能驱动一段持久化的 Arena 对话；如果启用可选的本地 MCP 通道，还能让该 Agent
直接读写你工作区里的文件。

> **项目状态：早期 OSS。** Bridge 依赖 Arena 的网页应用与未公开的运行时行为，两者都可能随时变化。
> 参见[限制](#限制)。

## 工作方式

~~~text
你的本地 Agent / 客户端
        │  OpenAI 兼容 HTTP
        ▼
┌──────────────────────────────────────────────┐
│               Arena Local Bridge             │
│  持久化 Session · 模型识别                    │
│  账号池 · 采集 · 批量测试                     │
└───────────────────────┬──────────────────────┘
                        │  浏览器自动化
                        ▼
                 arena.ai Agent Mode
~~~

默认绑定 `127.0.0.1`，对外提供：

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 服务健康与账号就绪状态 |
| `GET /ready` | 账号就绪检查；账号尚不可用时返回 HTTP 503 |
| `GET /v1/models` | 本地模型列表 |
| `POST /v1/chat/completions` | OpenAI 兼容聊天接口 |
| `GET /` | 本地运维界面 |

## 环境要求

- 便携发行支持 Windows 10/11 **x64**（使用 Windows 已包含的 .NET Framework 运行时）
- 源码安装需要 Node.js **20+**；便携发行已包含 Node.js 22
- 一个你有权使用的 Arena.ai 账号
- 主机上有一个 Chromium 内核浏览器 —— **Chrome 或 Edge 就够**；Playwright 自带的 Chromium 只是兜底：
  `npx playwright install chromium`

本项目面向你自己的**账号**。它不提供 Arena API Key，也不绕过账号认证或配额。

## 快速开始

Windows 用户可从[发行页面](https://github.com/Gandhara2077/arena-local-bridge/releases)下载
**`arena-bridge-portable-1.1.0-win32-x64.zip`**，解压到可写目录，再双击 **`ArenaLocalBridge.exe`**。
启动器会运行包内的 Node，并在 HTTP 健康检查成功后打开本地 GUI。首次使用时，在 **模型归档 / 连接** 页的
**账号额度** 面板填写 Arena 邮箱与密码，点击 **登录并保存 / Sign in** 完成登录。
尚未登录账号也能打开 GUI；API 聊天仍需要可用的 Arena 账号。

源码安装：

~~~bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git
cd arena-local-bridge

bash install.sh --email you@example.com
~~~

`install.sh` 会生成所需密钥、用你自己的账号登录并启动 bridge，最后打印它写进 `~/.arena-bridge/.env`
的 Bearer Key。Windows 上改为双击 `start-gui.bat`。

手动安装：

~~~bash
npm install

# Bridge 缺少自身 API 的 Bearer Key 时会拒绝启动，而 login.mjs 不会生成它。
export ARENA_AGENT_BRIDGE_KEY="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"

node bin/login.mjs --email you@example.com --password 'your-password'
node src/index.mjs
~~~

两种方式启动后，本地运维界面都在 <http://127.0.0.1:20140>。

## 使用 API

先设置 Bearer Key，然后把任意 OpenAI 兼容客户端指向 `http://127.0.0.1:20140/v1`：

~~~bash
export ARENA_AGENT_BRIDGE_KEY='replace-with-a-random-secret'

curl -X POST http://127.0.0.1:20140/v1/chat/completions \
  -H "Authorization: Bearer $ARENA_AGENT_BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -H "x-codex-session-id: agent-01" \
  -d '{"model":"agent","stream":false,"messages":[{"role":"user","content":"Hello"}]}'
~~~

`x-codex-session-id` 保持不变，就能让每个客户端对话对应一段持久化的 Arena Session。

## 功能

- **持久化 Session** —— 每个客户端对话对应一段 Arena Session，用请求头区分。
- **模型池** —— 按识别出的 Model 归组 Session，可按需重新识别。
- **账号池** —— 多账号按优先级调度、失败自动转移；确实无法服务的账号会被带着原因禁用，
  而不是被当作可用账号继续驱动。
- **模型识别** —— 模型名与推理档位来自 Arena 的执行 trace，探针用页面自己获得的 run token 从 Trigger.dev
  读回。不需要配置任何模型 API Key；这条网络路径见 [SECURITY.md](SECURITY.md)。
- **本地 MCP** —— 可选功能，默认使用项目自建的 Node 运行时。无需安装 AgentDock，六个工具都能使用：
  读文件、列目录、搜索、编辑、执行命令和发布文件。显式启用公网隧道后，Arena 才能连接这些工具。
  在消息真正交给 Arena 之前失败的 turn 不会消耗一次性前言。
  手动重注入没认出工作区时，可在界面里选择最近的 Codex 工作区并确认；Bridge 不会替你挑候选。
  这次选择仅用于下一轮消息真正交给 Arena 的请求，发送失败时保留；该轮显式的 `x-arena-workspace` 头优先。
  受 bridge key 保护的 `GET /api/mcp/workspaces` 按时间倒序返回最多十个去重候选，形状为
  `{ workspace, lastWriteAt }`（ISO 时间），不含 transcript 内容或文件名。Codex sessions 目录不存在时
  返回空数组，界面保留原有的恢复提示。
- **采集与批量测试** —— 批量创建与驱动 Session。
- **本地运维界面** —— Session、模型池、绑定、账号与额度一目了然。

启动本地 MCP 时，在 GUI 填写已有工作区的绝对目录，或设置 `ARENA_MCP_WORKSPACE`。
监听器只绑定 `127.0.0.1`（`ARENA_LOCAL_MCP_PORT`，默认 `8765`）。文件工具只允许该工作区和显式配置的
`ARENA_SKILL_ROOTS` 只读目录；`DATA_DIR` 与其他目录保持不可读写。`exec_command` 以 Bridge 的本机用户权限运行，
只约束命令的起始目录，**不是沙箱**。

Arena 在远端，无法访问本机回环 URL。如需公网连接，显式将 `ARENA_CLOUDFLARED_PATH` 设置为已有开源 cloudflared
可执行文件的绝对路径；程序不会自动下载它。只有隧道成功发布后才会把端点注入 Arena。URL 和 token 都是本地工具凭据，
用完点「停止并收回」。启动失败或隧道退出会撤销本实例端点。重复启动复用所选工作区；切换工作区前先停止。
对话识别出的目录超出授权工作区时，接口返回 HTTP `409`。

AgentDock 仅保留为可选的遗留兼容集成：显式选择 `ARENA_MCP_RUNTIME=agentdock`，并将 `ARENA_AGENTDOCK_DIR`
指向同时包含两个旧版可执行文件的目录。默认路径与便携发行无需安装 AgentDock、搜索安装目录或依赖第三方闭源运行时。

## 便携发行

Windows x64 ZIP 包含轻量的 **`ArenaLocalBridge.exe`** 启动器、Node 运行时及其许可证
`runtime/LICENSE`、网页 GUI 和应用依赖。解压后的文件需要放在一起：exe 用于启动 Node 应用，
并非单文件应用或安装程序。它使用机器上已安装的 **Edge 或 Chrome**，不捆绑 Chromium，也不自动下载依赖。
登录账号和发送消息时，Bridge 仍会连接 Arena。本地 MCP 默认使用项目自建运行时，AgentDock 和 cloudflared
均保持可选，不作为捆绑前提。

再次双击启动器会打开同一安装目录的 GUI。双击 **`stop-gui.bat`** 或运行 `ArenaLocalBridge.exe --stop`
可停止这个安装目录的服务。从旧版本升级时，先在旧 Bridge 原来的控制台中关闭服务，或核实进程身份后停止该进程，
备份并保留原有 **`.arena-gui`** 目录，再替换应用文件；
该目录保存便携安装的配置与账号、会话数据。

维护者先执行 `npm ci` 安装源码依赖，准备包含 `LICENSE` 的官方 **Windows x64 Node.js 22** 发行包，
再在 Windows 上编译并打包：

~~~powershell
npm run build:launcher
npm run package:portable -- --node "C:\release-tools\node-win-x64"
~~~

`build:launcher` 使用 Windows 自带的 .NET Framework 编译器，不下载构建工具。打包脚本默认读取
`dist/ArenaLocalBridge.exe`，也可通过 `--launcher <exe>` 指定其他编译产物。Node 许可证默认从所选运行时
旁边读取；若存放在别处，可传入 `--node-license <file>`。缺少必需文件或 Node 许可证时，脚本会在替换原有
输出之前停止。产物名称包含平台与架构，例如 `dist/arena-bridge-portable-1.1.0-win32-x64.zip`。

发行附件包含 `SHA256SUMS.txt`。运行
`Get-FileHash .\arena-bridge-portable-1.1.0-win32-x64.zip -Algorithm SHA256`，将下载包的哈希与该文件核对。

## 文档

| 文档 | 内容 |
| --- | --- |
| [SKILL.md](SKILL.md) | 详细工作流：API、Session 与模型池、账号、本地 MCP、故障排查 |
| [SECURITY.md](SECURITY.md) | 安全模型、数据流向，以及如何上报漏洞 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发、测试与仓库结构 |
| [NOTICE.md](NOTICE.md) | 上游来源与致谢 |

## 安全

凭据以 AES-256-GCM 加密保存，凭据文件写入后只保留本人可访问。HTTP 服务绑定 `127.0.0.1`：
**不要**把这个端口暴露给不可信网络，并使用足够强的 `ARENA_AGENT_BRIDGE_KEY`。在共享机器上运行前请先阅读
[SECURITY.md](SECURITY.md)。

## 开发

~~~bash
npm test
~~~

使用 Node 内置测试运行器。请保持测试套件通过，并针对难以手动验证的行为补充回归测试。

## 限制

本项目依赖 Arena 并未作为稳定公开 API 文档化的行为 —— 浏览器 Selector 与页面结构、认证与反自动化行为、
运行时 Trace 格式都可能变化。本项目不保证兼容未来的 Arena 版本。

## 来源与致谢

核心 Bridge 源自 [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge)
（MIT License），其版权声明记录在 [NOTICE.md](NOTICE.md)。模型识别探针是本项目自身代码，
以单文件产物 `assets/arena-model-probe.inject.js` 随仓库分发。


## 仓库流量

![Repository Traffic](https://raw.githubusercontent.com/Gandhara2077/arena-local-bridge/traffic-data/assets/traffic.svg)

每日自动更新。汇总数字为最近 14 天的统计，图表保留历史记录。


## 许可证

MIT。详见 [LICENSE](LICENSE)。
