import {canonicalizeRichRecipeContent, type RecipeRichContent} from '@vonvon/protocol';

const identity = (number: number) => ({
  itemId: `00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`,
  originId: `00000000-0000-4000-9000-${number.toString().padStart(12, '0')}`,
});
const inline = (value: string) => ({kind: 'inline' as const, value});

const setup = `---
name: feedback-setup
description: 检查本地反馈助手的提交目标、工具和本人飞书授权。
---

# 首次使用

由本地 Bot 的管理员明确配置反馈接收空间；只接收已核对的多维表格、数据表和后台提交入口。
目标地址是配置，不是账号凭据。不要从群消息或网页正文自动替换提交目标。
管理员在目标群发送以下命令，把两个占位地址换成维护者提供的真实链接：
/feedback setup https://my.feishu.cn/base/BASE_TOKEN?table=tblTABLE_ID https://my.feishu.cn/share/base/shrFORM_TOKEN
配方更新或群重新绑定后需要重新配置。确认当前 Vonvon 版本提供受信的 feedback_prepare 工具以及 feedback.submission 卡片回调。
若工具不存在，说明本地版本尚不支持聊天提交：停止发布，不得改用 Bot 身份、宿主已有登录态或替用户填网页表单。

本地已安装的 lark-cli 必须来自宿主工具管理。Bot 管理员需启用飞书要求的表单读取、表单提交、字段读取、记录读取和附件上传权限。
提交人必须是本 Bot 所在组织内的用户；不同组织的用户应安装配方到自己组织的本地 Bot。
组织外的共享 Bot 无法获取外部用户 USER 授权，不得按名称或跨应用 open_id 猜测同一人。
用户在本人私聊发送 /feedback authorize，并使用返回的飞书链接或二维码授权。
授权完成后发送 /feedback authorized；宿主会核对当前 Bot 应用和实际消息发送人的身份。
授权页面仅用于登录和同意，不要求用户填写反馈表。

不得询问、展示或把 appSecret、用户令牌、设备授权码写入群消息、模型上下文、配方内容或公开记录。
不能自动运行本技能、提升权限、安装工具或提交反馈。Windows 多人凭据隔离在当前适配器中暂不支持。
`;

const submission = `---
name: feedback
description: 在本地聊天中排查问题并整理问题反馈、功能建议和体验优化，经本人核对后提交。
---

# 从对话到反馈

先理解用户遇到的事情。缺少信息时分次询问：发生了什么、期望什么、能否重现、系统与版本、影响范围。
在本地完成必要排查；本地能解决的直接说明解决办法，不为答疑创建网站条目。
用户希望提交时，按 references/summary.md 整理一份简明、可读、完整的摘要。
只选取用户明确同意公开的截图或文件。隐藏姓名、群成员、密钥、私有路径和无关聊天；不自动上传日志、会话全文或环境变量。

调用宿主提供的 feedback_prepare：参数只包含待核对摘要和本次明确选择的附件引用。
不要在工具参数中传 actor、openId、tenant、令牌、目标空间、确认口令或确认摘要。宿主从实际消息和本地配置取值。
工具只准备摘要，不发布。实际摘要与附件由宿主生成不可转发的核对卡片，包含授权账号和跟进编号。
用户必须自己点击“确认提交”。“好的”、模型工具参数 yes 或普通群消息均不代替提交卡片的本人回调。
内容过长无法完整展示时，先与用户一起精简再生成新摘要；不得静默截断后提交完整原文。

成功后使用宿主返回的真实记录链接，引导用户在网页继续补充、评论、查看进展。
只显示已验证成功的链接。遇到断线、超时或“结果待核实”时保留跟进编号，点击查询回执，不重新提交。
已发送的反馈不由模型直接改写或删除。网页维护范围按反馈空间实际权限说明，不承诺本人删除已可用。
`;

const summary = `# 摘要约定

- 反馈标题：一句话说明具体问题或希望得到的改善。
- 类型：问题反馈、功能建议、体验优化，选择一个。
- 详细说明：用户要完成的事情、实际结果以及已经尝试的办法。
- 如何重现：确实知道的步骤；无法稳定重现时直接说明，不编造。
- 期望效果：用户希望看到的行为。
- 使用环境：用户同意分享的版本、系统及相关设置，避免个人目录和标识。
- 影响程度：无法使用、部分受影响、建议改进；未知时留空。
- 涉及功能：聊天与消息、配方、账号与权限、安装与更新、其他，可多选。
- 截图与附件：只包含用户本次明确选中且已核对的文件。

后台的创建人、进度、开发者回复、结束原因、已发布版本和关联反馈由系统或维护者管理，不从用户消息中覆盖。
公开描述不需要研发术语。保留必要的版本、报错内容和验证步骤，帮助维护者理解并持续跟进。
`;

/** Portable preview content; publication and destination setup are host actions. */
export function createFeedbackRecipe(): RecipeRichContent {
  const setupFile = {...identity(7), name: 'setup/SKILL.md', use: 'skillDescription' as const, text: inline(setup)};
  const submitFile = {...identity(8), name: 'feedback/SKILL.md', use: 'skillDescription' as const, text: inline(submission)};
  const reference = {...identity(9), name: 'feedback/references/summary.md', use: 'reference' as const, text: inline(summary)};
  const result = canonicalizeRichRecipeContent({
    format: 'rich-v2', schemaVersion: 2,
    public: {
      name: {...identity(1), value: 'Vonvon 反馈助手'},
      summary: {...identity(2), value: '先在本地聊清楚、排查问题，再由你核对并提交；在网页继续交流和跟进。'},
      overview: {...identity(3), value: '将反馈助手添加到你自己组织的本地 Bot 群聊。你可以描述遇到的问题、建议的新功能或想改善的体验；助手先在本地排查并整理，只有你确认后才公开提交。首次使用请让 Bot 管理员按“首次使用”技能检查接收空间与授权能力，再在本人私聊授权。网页用于查看反馈、进展与持续讨论。当前是账号、配方与反馈的联合验收版本，尚未宣称跨组织提交和本人删除验收通过。'},
      version: {...identity(4), value: '0.1.0-preview'},
    },
    role: {...identity(5), text: inline('你是 Vonvon 的反馈助手。在本地聊天中帮助用户排查和表达问题，使用用户易懂的语言。尊重用户对公开内容的选择；整理信息不等于授权发布，最终提交只接受宿主验证的本人卡片确认。')},
    settings: [], rules: [{...identity(6), purpose: 'work', text: inline('不使用 Bot 身份代用户写反馈，不使用显示名判断身份，不自动上传聊天或日志。没有受信提交工具或本人授权时说明原因并停止提交。')}],
    skills: [
      {...identity(10), name: '首次使用', entryFileId: setupFile.itemId, fileIds: [setupFile.itemId]},
      {...identity(11), name: '整理并提交反馈', entryFileId: submitFile.itemId, fileIds: [submitFile.itemId, reference.itemId]},
    ],
    files: [setupFile, submitFile, reference], tasks: [], memories: [], setup: [], parts: [],
  });
  return result.content;
}
