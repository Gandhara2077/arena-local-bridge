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

## 本仓库自有代码

除上一节列出的上游代码外，本仓库其余部分均为本项目自身代码，受 [LICENSE](LICENSE) 的 MIT 许可覆盖，不含来源不明或许可未定的第三方代码：

- **`src/probe/`** —— 模型识别探针。源码是 `src/probe/modules/*.js`，由 `bin/build-probe.mjs` 组装成单文件产物 `assets/arena-model-probe.inject.js`，运行时经 `addInitScript` 注入页面，随本仓库分发。
- **`src/archive.mjs`** —— 模型归档的读写与目录结构。
- 连抽采集、批量测试、运维界面等其余模块。
