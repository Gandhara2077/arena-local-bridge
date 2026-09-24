# Arena Local Bridge

通过本地 **OpenAI 兼容 API** 运行你自己的 Arena.ai Agent Mode 会话。

本项目在 [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge) 的浏览器/会话桥接基础上增加持久化 Session、批量采集、模型识别、结果归档、批量测试和本地运维 GUI。

> **项目状态：早期 OSS。** Arena 的网页、认证流程和运行时行为可能变化，因此未来可能需要随 Arena 更新维护。

## 环境要求

- Node.js **20+**
- 你有权使用的 Arena.ai 账号
- 能够运行 Chromium / Playwright 的主机

本项目面向你自己的账号，不是官方 Arena API。

## 快速开始

~~~bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git
cd arena-local-bridge
npm install
npx playwright install chromium
node src/index.mjs
~~~

首次使用前请通过仓库提供的登录工具完成本地账号配置。服务默认监听 http://127.0.0.1:20140。

Windows 可使用 start-gui.bat；完整 Agent 工作流见 [SKILL.md](SKILL.md)。

## API

核心接口：

| 接口 | 用途 |
| --- | --- |
| GET /health | 健康检查 |
| GET /v1/models | 本地模型列表 |
| POST /v1/chat/completions | OpenAI 兼容聊天接口 |
| GET / | 本地运维界面 |

使用 x-codex-session-id 可以让不同客户端保持独立的持久化 Arena Session。

## 模型识别

Arena 的盲测 UI 通常不会直接显示底层模型名称。项目提供页面探针和 Node 端 fallback 两条识别路径。

模型探针 assets/arena-model-probe.inject.js **不由本仓库分发**，因为其许可证/来源无法确认。没有该文件仍可运行。

fallback 路径可能使用当前 Session 暴露的公开 run token 查询 trigger.dev 的 run/trace 接口。模型识别依赖 Arena 当前运行时实现，不应视为稳定公开 API。

## 安全

- 凭据使用 AES-256-GCM 加密保存；
- 默认只绑定 127.0.0.1；
- 运行时数据、Cookie、凭据和 .env 等通过 .gitignore 排除；
- 不要把本地 HTTP 端口暴露给不可信网络；
- 使用强随机的 ARENA_AGENT_BRIDGE_KEY；
- 共享机器部署前请阅读 [SECURITY.md](SECURITY.md)。

可选代理/隧道功能可能引入其他网络目的地，启用前请确认其信任边界。

## 开发

~~~bash
npm test
~~~

涉及认证、Session、请求解析、凭据存储或安全逻辑的修改，应尽可能补充回归测试。

## 限制

项目依赖 Arena 未必稳定公开的网页和运行时行为，包括页面结构、登录及反自动化机制、trace 格式和模型识别机制。因此不能保证未来 Arena 版本持续兼容。

## 来源与许可

核心桥接代码基于 [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge)，采用 MIT License。来源和第三方资产说明见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

本仓库不分发另行提到的 Arena Model Assistant 探针代码。

MIT License。

**Language / 语言:** [English](README.md) | [简体中文](README.zh-CN.md)