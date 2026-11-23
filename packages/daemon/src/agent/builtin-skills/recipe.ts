import type {BuiltinSkill} from './package';
import {recipeSetupAuthoringGuidance} from '../../recipe/setup-authoring-guidance';

export const recipeSkill: BuiltinSkill = {
  name: 'vonvon-recipe',
  title: '创作配方',
  description: '帮助作者从已有群聊或项目整理、创建和分享配方，检查依赖并按需准备 Setup Skill。用户说创建配方、从群聊分享配置、检查配方依赖或准备初始化技能时，先读本 skill。获取和应用他人配方时读 vonvon-config。',
  body: `## 从现有群聊开始
先确认作者想分享哪个群、配方的用途和面向的使用者。读 vonvon-config，通过现有命令核对目标群的工作目录、角色、规则、技能和 MCP 配置；只读本次相关的项目说明与依赖声明。群配置的读取和修改沿用该 skill 的正常权限与修订规则。

## 按需整理 Setup Skill
${recipeSetupAuthoringGuidance}
作者同意创建时，先展示准备覆盖的依赖、步骤和建议名称，再按目标群实际 Provider 的技能目录创建 SKILL.md 及必要参考文件。保留作者的选择和已有文件；目录、依赖用途或运行方法不清楚时先核实。完成后读回检查说明和步骤是否可用，说明哪些步骤已验证、哪些仍需在使用者自己的环境完成。

## 进入配方创作
准备好后，引导作者在 App 点“创作配方”或在本人私聊发送 /recipe create，选择准确的来源群，再选择实际要分享的技能及配套文件。已进入来源选择的，完成本地准备后重新读取来源列表再选择。不要把尚未包含的技能说成已发布；私人草稿、完整预览和发布沿用现有确认流程。配方介绍应包含 Setup 的真实名称、执行时机和可复制的目标群运行示例。`,
};
