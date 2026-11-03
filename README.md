# Codex ↔ DSH Bridge

把 **Codex 的计划与代码审阅**，和 **DeepSeek Harness（DSH）的持续上下文、工具执行及经验整理**连接起来的本地插件。双方沿同一任务版本交换技术资料和验收证据，留下下一位 Agent 能接续的记录。

**MIT 开源 · 本地 SQLite · 明确绑定 · 事件驱动 · 不附带用户数据**

这是独立社区项目，不是 OpenAI 或 DeepSeek 官方产品。当前公开版 **0.3.0**；DSH 兼容范围暂锁定 `0.2.1-rc.2`，需要 Node.js 24+。不承诺其他版本直接兼容。Windows 桌面自动唤醒属于实验适配；手动 MCP/CLI 收发不依赖这个适配器。首次使用请读[安装说明](docs/INSTALL.md)和[验证范围](docs/VALIDATION.md)。

## 为什么这样协作

- **Codex 审阅核心**：检查计划是否可实现，审查代码及边界条件，核对测试与实际证据。用户授权后承担代码修改和最终验收判断。
- **DSH 执行与学习侧**：在用户选择的原会话中整理需求、提出问题、执行获准的环境验证，将结果和经验回传。
- **共同的证据链**：计划、精确版本、资料哈希、消息关联和回执分别保留，避免把“对方说完成”当作真实验收。

这里的“学习”是积累可追溯的知识与流程经验，不是修改模型权重。审阅者也可能犯错；质量仍依赖测试、真实验证和人的判断。

## 能做到什么

| 能力 | 实现与边界 |
| --- | --- |
| 双向收发 | Codex 提供 MCP/同源 CLI；DSH 插件提供 `codex_bridge_*` 工具，按调用会话身份确定路由 |
| 精确绑定 | 一对一固定会话 ID；一个绑定可以有多个 `workstream`，不会按同名聊天猜配 |
| 持久消息 | SQLite 保存消息、关联回复、回执、租约和任务版本；离线保留，恢复后继续核对 |
| 当前任务优先 | 显式任务修订及 `supersedes`；保留旧证据但禁止执行已替代任务 |
| 重复与超时处理 | 同 ID/同内容幂等；超时标记 `unknown`，先核对真实回执再决定后续 |
| DSH 原会话投递 | 通过持有会话的宿主 `sessionController.prompt(mode=queue)` 排到下一轮 |
| 可选桌面接续 | 文件事件触发原生队列投递及唤醒请求；不靠定时模型保活，不更换聊天模型 |
| 资料检查 | 文本资料路径约束、大小与 SHA256 核对、有限敏感模式筛查；仍需人工/Agent 脱敏审阅 |
| 恢复交接 | 通用 Skill、任务笔记模板、验证分层和回滚流程 |

`queued / accepted / started / replied / completed` 是消息协议状态，**不自动等同于业务任务完成**。没有实际验收证据时，必须继续记为待验收。

## 最短上手路径

1. 克隆仓库，执行 `node --test test/*.test.mjs`，确认使用 Node 24+。
2. 依[安装说明](docs/INSTALL.md)把插件装进实际使用的 DSH profile，并配置本地 Codex MCP。
3. 明确选择双方已有会话，填本机绑定；仓库中的 ID 全是合成示例。
4. 先完成一轮 `Codex → DSH → Codex → DSH` 握手，核对每条消息 ID。
5. 按[Agent 工作流程](docs/WORKFLOW.md)推进；通过后再自行选择是否启用实验桌面唤醒。

## 推荐搭配记忆插件

建议使用能保存**来源、版本、证据、审阅状态、纠错及撤回记录**的 DSH 记忆插件。把经过 Codex 审阅且经实际验证的经验存为“在特定条件下适用的经验”，在下一次项目规划时检索；错误经验应能纠正、撤回和过期。

这样可以让 DSH 逐渐形成先检查计划、提供证据、接受审阅、复用有效做法的工作习惯。桥本身**没有内置记忆插件或自动蒸馏任务**，也不保证这种倾向一定产生。详细契约与可复制模板见[记忆协作建议](docs/MEMORY.md)。

## 明确不做

- 不镜像私人聊天、不收集人格提示词、不迁移账号密钥，不把本机运行数据库提交到 GitHub。
- 不自行扩大用户授权，不自动批准生产部署、公开发布、收费调用、服务重启或删除数据。
- 不替用户修改聊天模型、原生 Plan/Goal 模式、暂停状态或权限设置。
- 不承诺零泄漏、业务严格一次执行、实时延迟上界、离线持续工作或无人监督的完美项目。
- 不用历史资料冒充最新现场，不用收发成功冒充功能验收，不让两个 Agent 无限互发确认。

这些是项目的默认行为约定，不额外限制 MIT 授予的使用、修改和分发权利。更多技术限制见[能力边界](docs/LIMITATIONS.md)；安全问题见 [SECURITY.md](SECURITY.md)。

## 开发与结构

`lib/store.mjs` 管理协议和 SQLite；`lib/plugin.mjs` 接 DSH 原生宿主；`bin/mcp.mjs` 与 `bin/bridge.mjs` 提供 Codex 入口；`lib/event-runtime.mjs` 是可选桌面事件适配；`test/` 只用合成数据。无安装脚本，不需要数据库服务。保留 `private: true` 防止误发 npm；GitHub 源码与本地 tarball 仍可安装。

贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。许可证：[MIT](LICENSE)。

[工程研究报告](docs/RESEARCH_REPORT.md)说明设计方法、可复现证据、失败与局限；[最新验证记录](docs/VALIDATION.md)区分源码修复和已发布安装包。

English summary: A local, evidence-oriented collaboration bridge between Codex and DeepSeek Harness. Explicit session bindings, durable SQLite messages, task revisions, MCP/CLI, and an optional experimental Windows desktop wake adapter. Optional reviewed memory is a workflow recommendation, not model training. No user conversations, credentials, or runtime databases are included.
