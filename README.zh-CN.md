# Arena Local Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

通过本地 **OpenAI 兼容 API** 运行你自己的 [Arena.ai](https://arena.ai) Agent Mode 会话。

本项目在 [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge) 的浏览器/会话桥接基础上，增加了：

- 持久化 Arena Session；
- 批量 Session 采集；
- 模型识别；
- 模型结果归档；
- 批量 Prompt 测试；
- 本地运维界面。

> **项目状态：早期 OSS。** Arena 的网页应用和未公开的运行时行为可能随时变化。当 Arena 修改前端、认证流程或遥测格式时，本项目可能需要维护更新。

## 工作方式

~~~text
你的本地 Agent / 客户端
        │
        │ OpenAI 兼容 HTTP
        ▼
┌──────────────────────────┐
│     Arena Local Bridge   │
│                          │
│  Session 管理            │
│  浏览器自动化            │
│  OpenAI 兼容 API         │
│  采集 / 测试             │
│  模型归档                │
└────────────┬─────────────┘
             │
             ▼
        arena.ai Agent Mode
~~~

Bridge 默认绑定到 127.0.0.1，并提供：

| 接口 | 用途 |
| --- | --- |
| GET /health | 健康检查 |
| GET /v1/models | 本地模型列表 |
| POST /v1/chat/completions | OpenAI 兼容聊天接口 |
| GET / | 本地运维界面 |

## 环境要求

- Node.js **20+**
- 你有权使用的 Arena.ai 账号
- 主机能够运行 Chromium / Playwright

本项目面向你自己的**账号**。它不提供 Arena API Key，也不绕过账号认证。

## 快速开始

~~~bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git
cd arena-local-bridge

npm install
npx playwright install chromium

node bin/login.mjs --email you@example.com --password 'your-password'
node src/index.mjs
~~~

服务默认监听：

http://127.0.0.1:20140

如果需要使用内置 GUI，可在支持的平台上使用对应的启动辅助脚本：

~~~bash
bash install.sh
~~~

Windows：

~~~text
start-gui.bat
~~~

详细的 Agent 工作流见 [SKILL.md](SKILL.md)。

## API 示例

首先设置本地 Bearer Key：

~~~bash
export ARENA_AGENT_BRIDGE_KEY='replace-with-a-random-secret'
~~~

然后：

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

x-codex-session-id Header 用于让客户端保持相互独立的持久化 Arena Session。

## 仓库结构

~~~text
src/        核心 Bridge、服务器、浏览器/Session 管理、采集和 UI
bin/        登录、Session、验证和诊断辅助工具
test/       Node.js 测试套件
prompts/    可选安装 Prompt
assets/     公共项目资源
docs/       公共文档
~~~

## 模型识别

Arena 的面向用户的盲测 UI 通常不会直接公开底层模型名称。

本项目提供两条识别路径：

1. 在可用时使用本地提供的页面探针；
2. 使用 Node 端 fallback，读取当前 Session 暴露的公开 run trace。

可选探针文件 assets/arena-model-probe.inject.js **不由本仓库分发**，因为其许可证/来源无法确认。因此，即使没有该文件，仓库仍可正常运行。

模型识别依赖 Arena 当前的运行时行为，因此不应将其视为永久稳定的公开 API。

## 模型池

归档后的 Session 会按 **Model Pool（模型池）** 展示：每个池对应一个 Model，并包含所有被识别为该 Model 的 Session。无法识别 Model 的 Session 不会被视为一个 Model，而是进入单独的**未识别**池；你可以按需重新执行识别（补标）。

模型池是一个**索引，而不是调度器**。它不会替你选择 Session，因为对话上下文存在于 Arena 侧，并绑定到某个具体 Session；如果静默切换 Session，就会丢失原有上下文。你负责选择，模型池负责帮助你查看和找回已有 Session。

### Session 绑定

当客户端将某个 Session UUID 作为 model 传入时，这是一次显式选择，Bridge 会在客户端对话 ID 与该 Session 之间建立**绑定**。客户端对话 ID 来自 x-codex-session-id Request Header，并在不存在时回退到 x-arena-session-id。之后带有相同 Header 的请求会继续使用同一个 Session，从而保持对话上下文。

- 只有显式选择才会创建绑定。model: "active" **不会**创建绑定。
- 如果已绑定的 Session 后来被标记为 suspected-dead，请求会返回 **409 bound_session_dead**，而不是静默切换到另一个 Session 并用不同的对话回答。此时应选择其他 Session，或删除该绑定。
- GET /api/pool/bindings 列出当前绑定；GUI 会在“会话绑定”中显示它们。POST /api/pool/unbind（Body：{"clientId": "…"}）可以删除一个绑定。

### Session 健康状态

GET /api/sessions 除扁平化的 sessions 列表外，还会返回 groups（模型池）。每个 Session 都带有 ok 或 suspected-dead 状态。

- 只有当针对某个 Session 的请求实际失败时，该 Session 才会被标记为 **suspected-dead**。这是唯一可信的信号：没有基于时间的衰减，也没有健康分数。
- POST /api/pool/verify（Body：{"sessionId": "<uuid>"}）会通过发送**一次真实 turn**并使用唯一 nonce 进行手动检查，然后将 Session 标记为存活或 suspected-dead。仅仅能够渲染页面并不能证明 Session 仍然可以回答；固定的探针字符串又可能直接命中 Bridge 的幂等缓存而根本不会到达 Arena，因此必须使用 nonce。**该操作会向 Session 的 transcript 追加一条简短消息。** 这是手动操作：不会后台轮询，因此不会替你消耗 Session 生命周期。
- POST /api/pool/reprobe（Body：{"sessionId": "<uuid>"}）会重新执行指定 Session 的模型识别；如果识别到 Model，则会将结果写回 记录.json。

健康状态保存在数据目录中的 sidecar 文件（pool-state.json），其中只保存 Session 状态和绑定关系。记录.json 仍然是 Session 数据的唯一事实来源；删除 sidecar 后，每个 Session 都会重新显示为 ok。

## 账号

成功登录**不等于**账号可用。Arena 可能对某个账号进行限制，但登录接口仍返回 200 并下发有效认证 Cookie；之后该账号的 Session 实际上会以访客身份提供服务。因此，login() 会进一步访问 /agent，检查服务器返回的数据是否包含该账号自己的邮箱。该检查已经针对一个已知受限账号和一个已知正常账号进行验证，并可以区分二者。

因此，Bridge 维护一个**账号池**，不会使用无法正常提供服务的账号：

- 一个账号虽然可以登录，但未通过可用性检查时，会带有原因地被**禁用**，而不是继续把它当作可用账号驱动。/health 会列出所有账号及其状态。
- 启动时，以及 Cookie 即将过期时，Bridge 会按照优先级遍历账号池，直到找到一个既能登录又可用的账号。被拒绝的账号会跳过并尝试下一个。
- node bin/accounts.mjs list | add | disable | enable | priority 用于管理账号池。add 会先验证账号，再保存它。数值越小优先级越高；0 是有效值。
- 一个成功登录的账号会自动重新启用，因此恢复不需要手动操作。

如果所有账号最终都被禁用，Bridge 会拒绝启动，而不是驱动一个失效 Session，并说明各账号失败的原因。

## 本地 MCP（让 Arena Agent 操作本地工作区）

当本地 AgentDock MCP Tunnel 已启动时，Bridge 会向 Session 前置发送一段简短的 preamble，使 Agent 知道工作位置以及“交付文件”的含义：

~~~
[本地 MCP 已接入] endpoint: https://<tunnel>/mcp
header: Authorization: Bearer <token>
本地工作区: <your workspace>
约定:
1) 读写本地文件一律走 MCP 工具（read_file / list_dir / search_text / file_edit / exec_command）。
2) MCP 的相对路径解析到 ~/AgentDock，不是工作区——要落到工作区请传绝对路径。
3) 你生成的文件必须写回本地（file_edit action=add 或 replace），不要只在回复里贴内容。
4) 需要交付给人的产物用 file_publish 发布成 artifact。
~~~

**为什么有第 2 条：** AgentDock 会把相对路径解析到 ~/AgentDock，而不是你的项目。Agent 如果使用相对路径写入 report.md，文件就可能出现在你不会查看的位置。第 3 条存在的原因是：如果 Agent 只把生成内容贴在回复中，就不能算真正交付了文件。

**工作区的来源**按以下优先级排列：

1. **调用方的 Request Header** x-arena-workspace —— 始终优先。
2. **从 Codex Session 自动发现。** Codex 会为每个对话在 ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl 保存一个 transcript，其中记录运行时的工作目录。Codex 会将同一个 ID 作为 x-codex-session-id 发送，因此 Bridge 可以**无需客户端额外配置**地恢复当前对话所属目录——每个项目的 Codex 运行都会自动报告自己的路径。如果 Codex 数据位于其他位置，可以通过 ARENA_CODEX_SESSIONS_DIR 覆盖根目录。
3. ARENA_MCP_WORKSPACE，或者位于 archive-dir.txt 同目录的纯文本文件 mcp-workspace.txt（启动器会像读取 ARENA_ARCHIVE_DIR 一样读取它）。
4. 以上都不适用 → preamble 不包含工作区信息。

检测机制不会猜测：无法识别的 Session ID 会解析为空并继续回退，因此缺失 transcript 不会静默地把 Agent 指向错误项目。这也是“最近只有一个活跃 transcript”回退机制在近期存在多个 transcript 时保持静默的原因——两个活跃对话无法可靠归属于其中任何一个调用方。Bridge 会记录实际使用的来源（workspaceFrom: request-header | codex-session | codex-recent | config | none）。

> **依赖实现细节：** Codex 自动发现读取 Codex 自己的磁盘 transcript（~/.codex/sessions/…/rollout-*.jsonl 及其 cwd 字段）。该目录结构属于未公开文档，也不是公开接口，因此任何 Codex 版本都可能改变它。功能失效时会退化为“无工作区”，而不会指向错误项目；ARENA_MCP_WORKSPACE 和 Request Header 仍然是稳定的配置路径。如果 Codex 数据存储在其他位置，可以设置 ARENA_CODEX_SESSIONS_DIR。

需要注意的是，本地客户端与 Bridge 之间的代理可能会完全丢弃自定义 Header。如果配置的 Header 始终没有出现，请检查 Bridge 的 workspace hints 日志行，其中会报告实际收到的 x-* Header。使用代理或 Gateway 时，请确保它保留客户端集成所需的 Request Header。

Header 只接受**绝对路径**（盘符路径、UNC 或 POSIX 路径）。相对路径会被忽略而不会继续转发，因为 AgentDock 会将其解析到 ~/AgentDock——这正是上述规则要避免的问题。

Header 会在注入 preamble 的那个 turn 中读取，因此客户端如果每次请求都发送它，不需要额外处理。内部探针（体检）**不会**消耗一次性的 preamble。

Preamble **每个 Session 只发送一次**，并且只在 Tunnel 正常运行时发送；它被刻意保持简短，因为过长的首条消息会提高 Arena 触发 reCAPTCHA 的风险。

## 安全模型

Bridge 会处理高度敏感的本地数据，因为它保存 Arena 的认证状态。

- 凭据使用 AES-256-GCM 加密保存。
- 在支持的系统上，凭据文件会使用严格的文件权限。
- HTTP 服务默认绑定到 127.0.0.1。
- 运行时状态、Cookie、凭据、.env 文件和 Tunnel 元数据都通过 .gitignore 排除。
- **不要**将本地 HTTP 端口暴露给不可信网络。
- API 访问使用强随机的 ARENA_AGENT_BRIDGE_KEY。
- 在共享机器上部署 Bridge 前，请阅读 SECURITY.md。

### 数据流

正常运行时会与 Arena.ai 通信。

模型识别 fallback 还可能使用当前 Arena Session 暴露的公开 run token 查询 **trigger.dev** 的 run/trace 接口。这是模型识别机制的一部分，在评估隐私和可用性时应将其纳入考虑。

可选的代理 / Tunnel 集成可能引入额外的网络目的地；只有在理解其信任模型后才应启用。

## 开发

使用以下命令运行测试套件：

~~~bash
npm test
~~~

仓库使用 Node 内置测试运行器。Pull Request 应保持测试套件通过，并针对难以手动验证的行为增加回归测试。

## 限制

本项目依赖 Arena.ai 未必作为稳定公开 API 文档化的行为，尤其包括：

- 浏览器 Selector 和页面结构可能变化；
- 认证和反自动化行为可能变化；
- 运行时 Trace 格式可能变化；
- 模型识别行为可能变化；
- Arena 账号或服务策略可能变化。

本项目不保证兼容未来的 Arena 版本。

## 来源与致谢

核心 Bridge 源自 [parham7991/arena-account-bridge](https://github.com/parham7991/arena-account-bridge)，该项目采用 MIT License。来源和第三方代码/资产说明见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

另行提到的 Arena Model Assistant 探针代码没有被分发在本仓库中。

## 许可证

MIT。详见 [LICENSE](LICENSE)。
