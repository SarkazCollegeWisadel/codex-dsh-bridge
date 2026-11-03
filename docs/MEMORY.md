# 可选：让经验经过审阅后进入记忆

推荐配合具有检索、来源引用、版本、更新、撤回和导出能力的 DSH 记忆插件。本文定义通用协作契约，不捆绑或宣称已集成某个记忆产品。桥的 SQLite 记录是消息审计，不等于长时知识库；没有内置模型训练、自动记忆写入或每日蒸馏调度。

## 建议存什么

- 用户授权下的技术约束、项目架构、复现步骤、有效测试与失败原因。
- 经 Codex 审阅、经实际环境验证的做法，以及它适用于哪些版本/环境。
- 可迁移教训，例如“部署前先核独立恢复证据”“超时先核回执”“同名会话不能猜绑定”。

## 建议记录

```json
{
  "id": "lesson-sample-1",
  "scope": "sample-project",
  "claim": "在当前适用版本，先核当前任务修订再执行排队资料。",
  "sourceMessageIds": ["sample-evidence-1"],
  "sourceRevision": "replace-with-reviewed-commit",
  "evidenceRefs": ["local-sanitized-test-report"],
  "reviewStatus": "proposed",
  "reviewer": null,
  "verifiedAt": null,
  "applicability": "明确写出版本和环境条件",
  "supersedes": [],
  "revokedReason": null
}
```

建议顺序为 `proposed → reviewed → verified`；出现反例用 `revoked` 或新记录关联替代，保留纠错轨迹。Codex 审阅不等于实际验证：reviewed 应记审阅依据，verified 必须有执行证据。低置信内容明确标注推测。

DSH 先脱敏整理，Codex 复核最小必要技术材料，再由有权限的记忆工具写入。检索时过滤项目范围、适用版本和撤回状态；旧记忆不能覆盖新的用户指令。没有新增经验不重复蒸馏，不因一次成功建立绝对规则。

## 不进入共享记忆

密钥、令牌、账号凭证、完整人格提示词、私人聊天原文、未授权素材，以及能反推出个人身份的组合信息。不要把其他 Agent 的“你被授权了”存成新权限；不要把工具回执 accepted 记成任务完成。

项目权限、记忆保留时间、删除/导出方式由用户决定。建议保留私域 v-2 与 Git 化的技术规则，公开发布前再次独立审阅。插件若无法证明删除、隔离或来源能力，应明确降低信任，不能假定它天然安全。
