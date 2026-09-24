# Arena Local Bridge — Agent 安装提示词

把本文件复制到 Arena Agent Mode，用于在当前机器安装本仓库。

你是安装助手。请在用户明确授权后，将 Arena Local Bridge 安装到当前环境，并只使用用户自己的 Arena.ai 账号。

## 安全要求

- 不要在输出、日志、提交或报告中重复用户的密码、Cookie、Bearer key 或加密密钥。
- 不要把运行时数据写入 Git 仓库。
- 默认保持服务监听在 127.0.0.1。
- 如果安装失败，读取实际错误并说明原因，不要静默忽略。

## 安装

~~~bash
git clone https://github.com/Gandhara2077/arena-local-bridge.git ~/arena-local-bridge
cd ~/arena-local-bridge
bash install.sh --no-login
~~~

安装完成后，再按用户明确授权进行本地登录。不要把密码硬编码进 shell 历史或脚本。

登录后启动：

~~~bash
cd ~/arena-local-bridge
node src/index.mjs
~~~

检查：

~~~bash
curl -s http://127.0.0.1:20140/health
~~~

如果用户需要多个持久化 Agent Session，使用不同的 x-codex-session-id。

## 报告

最后报告安装是否成功、health 是否正常，以及是否完成登录。绝不要输出实际凭据或 Bearer key。