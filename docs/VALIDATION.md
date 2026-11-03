# 公开版验证记录

## 2026-11-03 后续源码修复：SHA256 字段误报

当前 main 在 0.3.0 源码基线上修复了完整 JSON 的 `sha256` / `*_sha256` 字段被手机号规则误拒的问题。仅该字段的完整 64 位十六进制值不参与手机号判断；邮箱与密钥模式仍检查原文。重复键不经重序列化抹除，原资料字节与 SHA 不变。声明为摘要仍不是真实性或脱敏证明。

本轮实际执行公开源码 `node --test test/*.test.mjs`：**68 通过、0 失败、0 跳过**（原 60 项 + 8 项定向检查），Windows / Node.js 24.21.0。插件 API 未改，未重跑 SDK 探针；下文 SDK 结果仍属原 0.3.0。现有 0.3.0 tarball/发布附件未重打包，获取此修复需使用当前 main 源码；未声称任何现用宿主已经加载补丁。

日期：2026-11-03；候选版本：0.3.0；本次执行环境：Windows，Node.js 24 系列。

## 已验证

- `node --test test/*.test.mjs`：**60 通过、0 失败、0 跳过**。覆盖 SQLite 持久化、双向关联、固定身份、并发幂等、离线/归档/忙碌、超时 unknown、任务替代、旧证据保留、编辑过的 DSH 排队项、真实 stdio MCP、CLI 并发和新增路径/默认禁用测试。
- `scripts/native-probe.cjs`：使用真实 DSH `0.2.1-rc.2` 的 Cordis / SystemPrompt / ToolRuntime，在临时独立 profile 中加载公开插件源码；六个工具注册，guide/status/current/ack/send 执行，未绑定会话拒绝，合成宿主事件排队/忙碌排队/策略恢复和 dispose 通过。
- SDK 探针没有挂载模型，网络 fetch 尝试数 0；sessionController/workspaceRegistry 是合成适配，不是正在使用的真实聊天。
- 包清单审阅：只发布源码、文档、示例、通用 Skill 和许可；不包含数据库、私域配置、备份或测试运行产物。测试和 SDK 探针保留在 Git 源码中，未放入运行包。

## 未声称完成

本次没有替换现有运行插件，没有测试公开版在新机器上的完整 DSH 安装、真实业务会话往返、Codex 桌面唤醒、Linux/macOS 适配或任何业务验收。旧本机部署的成功不能替代新版现场验证。没有第三方安全审计，没有 npm 发布。

## 可重复检查

```sh
node --test test/*.test.mjs
npm pack --dry-run --ignore-scripts
git diff --check
```

可选 SDK 探针需要把 `DSH_SDK_ANCHOR` 设为安装中可解析官方 SDK 的 package.json 绝对路径，再运行 `scripts/native-probe.cjs`。普通 Node 无法直接解析某些 Desktop 的 `app.asar`；这类安装需使用其支持 ASAR 的 Electron 可执行文件，以**仅该进程**的 `ELECTRON_RUN_AS_NODE=1` 运行。它创建空白临时 profile，不复用生产 profile，也不启动桌面应用。缺少对应 SDK 时应报告未验证，不安装未知依赖来假装通过。

公开整理时遇到两项探针配置问题并修正：普通 Node 不能加载 ASAR SDK；全新临时 home 尚无 profile。最终探针改为兼容的 SDK 执行入口和独立最小 profile 后通过。没有借用生产 profile 绕过问题。

## 读者的真实验收

按 INSTALL 完成固定 ID 握手，验证插件运行版本及 `Codex → DSH → Codex → DSH` 四段关联。可选事件适配要新增一条 DSH 资料，观察原生投递回执、目标 ack 与回复；仅启动 worker 或记录 wake-requested 不算唤醒成功。用合成任务检查重复 ID、离线恢复、用户暂停及旧版本拒绝，避免用生产任务做故障注入。
