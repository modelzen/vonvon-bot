# 决策 Provider 集中配置

## 做什么

按 owner 2026-10-23 本地试用需求，在决策模型页集中配置每个 Provider 的模型和 Effort；创建智能群、群详情、切换智能模式时只选决策 Provider。依赖当前 dev 的决策模型界面与本地密钥粘贴修复。

## 范围

Codex、Claude、TypeSafe。决策 Provider 与执行 Provider 独立。旧完整群设置保留，用户主动改选 Provider 才转换；不自动迁移用户数据，不新增命令行教程。

## 现在的代码

`SecretsPanel` 仅管理 TypeSafe 密钥；`DecisionFields` 与 `JoinGroupDialog` 逐群保存完整模型。`host-settings` 只有执行程序设置。`judge/model` 与 `judge/judge` 负责最终选择和调用。

## 怎么改

1. 协议新增 `{kind:"provider",provider}`，原 llm/decision 输入兼容；host 新 judge 分区保存 `byProvider` 模型与 Effort。
2. 机器级 `judge-models.json` 用版本、互斥锁、revision/CAS 和原子写；stored 仅覆盖项，effective 含推荐默认值。读不到或损坏时明确失败。
3. 运行中的 Bot 每次判断读取新引用的全局模型，按对应 Provider 的模型目录处理 Effort。未支持的新类型不能静默退回其它 Provider。旧完整配置继续原样运行。
4. 全局页复用设置编辑器的保存、冲突与草稿机制，使用现有不依赖 Bot 的实时模型目录。Provider 不能用时显示配置入口，目录读取失败保留原值。
5. 群选择只产生 Provider 引用，缺登录或密钥阻止新建；规则群切智能仍先存决策配置、成功后切模式。密钥使用范围包含新 Provider 引用。

## 测试

新增 host CAS、热读/损坏、跨 Provider 调用参数、目录及 Effort 校验测试；扩协议往返与旧输入兼容。UI 覆盖全局编辑、目录不可用保留值、建群 payload 只有 Provider、旧群不自动覆盖、切智能失败保草稿。

## Codex 的自测

Mac 本机隔离 HOME、VONVON_HOME 和 Electron userData，构建实际 UI 与 daemon。验证全局模型配置保存并重新读取、Provider 状态和智能群选择。没有指定测试群，不发送飞书消息，不使用 owner 的真实密钥；真实建群沿用协议与集成测试，owner 本地试用另验收。

## 文档

更新 product 3.1 / 3.4 和创建群设置表，以及 v1-plan 记录。源代码验证和 owner 验收分开记录。

## 验收要点

模型和 Effort 在全局配置、群只选 Provider；下一次判断使用新参数；旧配置保持；失败不改 Provider；测试不保存真实密钥。diff 不含真实 id、密钥或本机路径。

## 风险和行数

风险为多进程热读、模型目录漂移、CAS、旧配置兼容。目标为独立可审查的一片，不含生成文件总改动不超过 1500 行；超过先拆分。
