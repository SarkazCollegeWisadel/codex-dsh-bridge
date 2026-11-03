# 安装与第一次握手

## 前提与版本

需要现有 Codex、DSH 和 Node.js 24+。本包的 DSH peer 固定为 `@deepseek-ai/dsh-tools@0.2.1-rc.2`、`@deepseek-ai/schemastery@3.18.5`；主机应提供这些 peer。版本不符先在隔离 profile 验证，不绕过兼容检查。不要启动第二个 DSH 宿主去占用正在使用的会话。

本次开源整理没有改动运行中的私人安装。公共版新增的路径默认值等变更通过合成回归；读者机器上的真实插件加载与往返仍须自行验收。

## 1. 获取并检查

```sh
git clone https://github.com/SarkazCollegeWisadel/codex-dsh-bridge.git
cd codex-dsh-bridge
node --version
node --test test/*.test.mjs
```

首次部署请固定经过审阅的 commit。源码是可直接执行的 ESM，无编译或安装脚本；核心测试不需要 `npm install`。插件入口仅在 DSH 宿主提供 peer 时使用。

## 2. DSH 安装

先保存当前 profile 的 Git/私域 `v-2` 备份，并在隔离位置验证恢复。根据 [DSH 官方 bundle 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)，可从本地 checkout 安装；以下 `desktop` 必须换成实际使用的 profile：

```sh
dsh plugin --profile desktop add /absolute/path/to/codex-dsh-bridge
```

Windows 使用实际绝对路径，例如 `C:/tools/codex-dsh-bridge`。也可在 checkout 内 `npm pack --ignore-scripts` 后安装生成的 `.tgz`。先检查包内容，勿打包运行数据。GitHub 安装可固定提交：`dsh plugin --profile desktop add github:SarkazCollegeWisadel/codex-dsh-bridge#<reviewed-commit>`；该路径的宿主安装仍需现场验证。

默认数据目录是当前用户主目录下 `.codex-dsh-bridge`，与代码目录分离。可在启动 DSH 前设置 `DSH_CODEX_BRIDGE_ROOT`，或通过 DSH 插件配置 `root` 选择自己的私域绝对目录。**两端必须指向同一个目录**；桌面从其他入口启动时可能不继承终端环境变量，需用插件配置显式指定并现场核对。不要只因安装包版本更新就宣称宿主已经加载新版。需要重载/重启时遵守用户授权与正在执行的任务。

## 3. Codex MCP

依据 [OpenAI MCP 配置文档](https://developers.openai.com/codex/mcp)，本地 stdio 服务可配置 command、args 和 env。将下例替换为自己的路径，合并入 Codex 配置；不要覆盖原配置或提交含其他服务密钥的配置文件：

```toml
[mcp_servers.dsh_bridge]
command = "C:/runtime/node.exe"
args = ["C:/tools/codex-dsh-bridge/bin/mcp.mjs"]

[mcp_servers.dsh_bridge.env]
DSH_CODEX_BRIDGE_ROOT = "C:/bridge-data"
```

也可用 `codex mcp add dsh_bridge --env DSH_CODEX_BRIDGE_ROOT=/absolute/private/data -- node /absolute/path/to/codex-dsh-bridge/bin/mcp.mjs`。按当前客户端方式重新连接 MCP，检查 `bridge_status`。此配置不需要桥自己的 API key；模型使用的账号、费用和权限仍由各自应用管理。

通用 Skill 在 `skills/dsh-codex-bridge/SKILL.md`，可按客户端的本地 Skill 安装方式放入其 skills 目录。若已存在同名定制 Skill，先比较并备份，不能直接覆盖已有项目权限和接续记录。也可先让 Agent 阅读仓库中的该文件与 WORKFLOW，再手动调用 MCP。

手工 CLI 需设置同一环境变量。PowerShell 示例：

```powershell
$env:DSH_CODEX_BRIDGE_ROOT = 'C:/bridge-data'
node ./bin/bridge.mjs status
```

## 4. 明确绑定、握手、授权工作分支

复制 `examples/bind.example.json` 为不入库的 `examples/bind.local.json`，替换双方真实 ID、workspace ID 和绝对项目路径；确认它们是用户选择的已有会话。不要依标题自动选择。

```sh
node bin/bridge.mjs bind --json-file examples/bind.local.json
node bin/bridge.mjs send --json-file examples/handshake.example.json
```

示例 route 为 `sample`；修改绑定 key 时也改消息 route。DSH 原会话接到后调用 `codex_bridge_current`、`codex_bridge_receive`，确认 messageId/工作分支，`codex_bridge_ack(state=started)`，再 `codex_bridge_send(kind=evidence, classification=technical, workstream=bridge, inReplyTo=<原ID>, body=<核对结果>)`。Codex 用 `bridge_receive` 取回、核对、ack started，再关联回送 review。最后一端用有证据的 completed 结束，别无限互相确认。

握手 `bridge` 分支可以投递；普通业务默认无策略时保留队列。将用户授权的路由写入 `examples/policy.local.json`（参考 policy 示例），运行：

```sh
node bin/event-worker.mjs configure --json-file examples/policy.local.json
```

configure 将当前精确 ID/绑定 revision 写入策略。新配置 `enabled=false`，**不会自动启用 Codex 桌面唤醒**；`businessPaused=false` 则允许该路由 DSH 端业务排队。保持暂停时设 true；握手仍可通行，但不得顺带恢复业务。手动 MCP/CLI 读取回信可一直使用。

## 5. 可选实验 Windows 桌面适配

须已经完成手动往返，且用户明确允许对应聊天事件接续。适配依赖当前 Codex 桌面的实验性 `thread/queue/*` RPC、桌面管道及 `codex://threads/wake/` URI；这些不构成稳定公共兼容承诺。默认尝试 Windows 本地安装路径，版本不唯一时需设置 `CODEX_APP_RUNTIME_CLI_PATH` 为实际对应的可执行文件。自定义 Codex 数据目录可用 `CODEX_HOME`。

```sh
node bin/event-worker.mjs start
node bin/event-worker.mjs status
# 只停止 Codex 自动事件投递，不删除队列，也不等于暂停所有 DSH 业务：
node bin/event-worker.mjs stop
```

start 只表示启动请求。必须实际发送新的 DSH 技术证据，确认原生队列回执、目标聊天 ack 和关联回复，才算本机自动唤醒验收；`scheduledModelWakeups=0` 不能替代这个证明。遇兼容问题先停止适配，继续持久队列与手动 MCP 收发，不另开 agent 执行目标聊天。

## 恢复与升级

先读本机接续笔记，再 status/current/receive；超时先查回执。`unknown` 由操作者核对真实原生队列/宿主回执后通过 CLI reconcile，不能凭等待时长转回 queued。业务暂停和 route disabled 是不同控制；停 worker 也不会关闭 DSH relay。

升级前保存代码 Git、旧包/配置私域 v-2、SQLite 一致性备份，并在隔离路径实际恢复验证。正在写入的 SQLite 不可只复制主 `.sqlite` 文件。回滚代码不覆盖后续消息、现有聊天、队列、业务状态；不可拿旧数据库整体还原到正在运行的新版数据上。

`bin/successor.mjs` 是高级人工维护工具，只用于已验证的 DSH seeded 后继关系；读取两条指定会话的头部元数据和 workspace 元数据，不解析历史消息。它不创建/恢复/取消归档聊天，不按同名自动迁移。其备份包含私域 ID，不得上传。没有明确迁移授权和独立恢复验证时，不运行 apply。
