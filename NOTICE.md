# 第三方代码与资产说明

本仓库是在上游项目之上做的二次开发，并引用了若干第三方资产。此处列明来源与授权状态。

## 继承的上游代码

**parham7991 / AraTmDev — arena-account-bridge**

https://github.com/parham7991/arena-account-bridge · **MIT License**

构成本仓库主体的登录、凭据加密、Agent 会话驱动、OpenAI 兼容接口、安装脚本等代码来自该项目。MIT 许可要求保留版权声明，因此 [LICENSE](LICENSE) 保留了上游版权行，并追加本仓库修改部分的版权声明。

本仓库的 README 只保留当前项目的公开文档，不再复制上游 README；上游项目本身仍可通过上述链接查看。

## 未随本仓库分发的第三方资产

**assets/arena-model-probe.inject.js**（模型识别探针）

- 来源：Arena Model Assistant 桌面工具的注入脚本。
- 文件内没有可确认的作者署名或许可证声明。
- 因此该文件不随本仓库分发，并在 .gitignore 中排除。
- 缺失时 src/probe.mjs 会使用 Node 端 fallback 路径。

如果该资产的权利人希望补充授权、署名或提出移除要求，请通过 GitHub issue 或其他公开维护渠道联系项目维护者。

## 参考但未复制的项目

**IvanSkainet / arena-agent**

https://github.com/IvanSkainet/arena-agent

本仓库未包含其代码。

## 归档格式兼容

src/archive.mjs 读写的归档结构兼容 Arena Model Assistant 的既有目录格式。这里仅复用数据结构与字段约定，未复制其代码。