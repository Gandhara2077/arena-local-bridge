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
| `GET /health` | 健康检查 |
| `GET /v1/models` | 本地模型列表 |
| `POST /v1/chat/completions` | OpenAI 兼容聊天接口 |
| `GET /` | 本地运维界面 |

## 环境要求

- Node.js **20+**
- 一个你有权使用的 Arena.ai 账号
- 主机上有一个 Chromium 内核浏览器 —— **Chrome 或 Edge 就够**；Playwright 自带的 Chromium 只是兜底：
  `npx playwright install chromium`

本项目面向你自己的**账号**。它不提供 Arena API Key，也不绕过账号认证或配额。

## 快速开始

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
- **本地 MCP** —— 可选。通道启动后，Agent 会被告知工作位置，并能读写你的工作区文件。
  在消息真正交给 Arena 之前失败的 turn 不会消耗一次性前言。
- **采集与批量测试** —— 批量创建与驱动 Session。
- **本地运维界面** —— Session、模型池、绑定、账号与额度一目了然。

## 便携发行

给没有装 Node 的机器打一个自包含压缩包：

~~~bash
npm run package:portable -- --node "C:\Program Files\nodejs"
~~~

解压 `dist/` 后双击 **`start-gui.bat`**。这是 Node 应用，所以没有单文件 exe，也没有安装程序；
包内任何东西都不会联网下载，驱动的仍然是你机器上已有的浏览器。

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

## 许可证

MIT。详见 [LICENSE](LICENSE)。
