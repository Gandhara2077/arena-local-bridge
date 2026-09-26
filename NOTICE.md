# 第三方代码与资产说明

本仓库是在上游项目之上做的二次开发。此处列明来源与授权状态。

## 继承的上游代码

**parham7991 / AraTmDev — arena-account-bridge**

https://github.com/parham7991/arena-account-bridge · **MIT License**

构成本仓库主体的登录、凭据加密、Agent 会话驱动、OpenAI 兼容接口、安装脚本等代码来自该项目，版权归原作者所有，按 MIT 许可使用。MIT 许可要求保留版权声明，该声明在此记录：

```
Copyright (c) 2026 Parham_7991 (AraTmDev)
```

[LICENSE](LICENSE) 中的版权行覆盖本仓库自身的修改部分（连抽采集、模型识别、模型归档、批量测试与运维界面）。

本仓库的 README 只保留当前项目的公开文档，不再复制上游 README；上游项目本身仍可通过上述链接查看。

## 模型识别探针

**`src/probe/`** —— 构建产物 `assets/arena-model-probe.inject.js`

- 该探针最初源自 Arena Model Assistant 桌面工具的注入脚本。
- 现已并入本仓库并随仓库分发：源码是 `src/probe/modules/*.js`，由 `bin/build-probe.mjs` 组装成单文件产物 `assets/arena-model-probe.inject.js`，经 `addInitScript` 注入页面。
- 原始文件内没有可确认的作者署名或许可证声明。

若该资产的权利人希望补充授权、署名或提出移除要求，请通过 GitHub issue 或其他公开维护渠道联系项目维护者。

## 参考但未复制的项目

**IvanSkainet / arena-agent**

https://github.com/IvanSkainet/arena-agent

本仓库未包含其代码。

## 归档格式兼容

`src/archive.mjs` 读写的归档结构兼容 Arena Model Assistant 的既有目录格式。这里仅复用数据结构与字段约定，未复制其代码。
