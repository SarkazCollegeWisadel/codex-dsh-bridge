---
name: dsh-codex-bridge
description: Exchange explicitly authorized technical tasks and sanitized evidence between an existing Codex chat and a fixed DeepSeek Harness session using the local bridge; recover task revisions and review evidence without importing private histories.
---

# Codex ↔ DSH 协作

用户要求接入 DSH、收取已绑定资料或接续桥接项目时使用。先找到本机已安装的 MCP/CLI 和数据目录，不猜路径、账号、会话或授权。

1. 读本项目接续笔记及仓库 docs/WORKFLOW.md；调用 bridge_status，再 bridge_current(routeKey)。
2. 新绑定必须取得用户明确选定的双方 ID/workspace，调用 bridge_bind；不能按标题猜。不要因已有 route 就自行扩展其业务权限。
3. receive 按 messageId 核任务版本/actionable；有效时 ack started 并核结果。已替代/已完成的消息不执行、不再互发确认。
4. Codex 审阅计划、代码、实际证据；DSH 从原会话整理脱敏技术依据并做获准验证。保持一个代码主写者，生产执行先核当前版本、Git、v-2 和独立恢复证据。
5. send 回复带原 inReplyTo/workstream，记录实际文件/提交/哈希、测试结果、失败与未测项。纯终止通知用 delivery=receipt，不自动唤醒。
6. 只有验收证据满足标准才关闭业务；queued/accepted 不能当完成。unknown 先核原生队列/宿主回执，不盲重发。
7. 实质进展更新笔记，分别记代码、测试、安装、运行版本和真实验收。可选记忆仅写来源清晰且经审阅的技术经验，用户权限不由记忆授予。

MCP：bridge_status / bridge_current / bridge_bind / bridge_send / bridge_receive / bridge_ack。
CLI：node <installed-package>/bin/bridge.mjs status|current|bind|send|receive|ack --json-file <local-input.json>，DSH_CODEX_BRIDGE_ROOT 指向同一私域目录。

不要读取私人聊天、具体人格提示词或密钥。不要创建定时模型保活、改变模型/Plan/Goal/权限或忽略暂停；等待某项输入时可继续独立已授权工作。两轮无新增证据则保存阻碍。实验桌面适配故障时保留队列，不接管桌面聊天的执行所有权。
