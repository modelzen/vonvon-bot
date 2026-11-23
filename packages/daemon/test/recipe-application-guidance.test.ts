import {expect,it} from 'vitest';
import {groupIdSchema} from '@vonvon/protocol';
import {isSetupSkillName,recipeHandoffText} from '../src/recipe/application-guidance';
import {recipeGroupLinks} from '../src/recipe/group-links';

it('names the exact recipe and offers a discussion before creating or changing a group',()=>{
  const text=recipeHandoffText({name:'周会助理',version:'2.4.1',hasSetup:true});
  expect(text).toContain('「周会助理」· 2.4.1');
  expect(text).toContain('新建一个群聊');
  expect(text).toContain('用到已有群聊');
  expect(text).toContain('等你确认方案后再创建或配置');
  expect(text).toContain('Setup 初始化技能');
  expect(recipeHandoffText({name:'读书伙伴',version:'1.0',hasSetup:false})).not.toContain('Setup');
});

it('keeps user-authored recipe titles from injecting card markup or links',()=>{
  const text=recipeHandoffText({name:'[任意链接](https://example.com)\n<at id=all>**',version:'`2`',hasSetup:false});
  expect(text).not.toContain('[任意链接]');
  expect(text).not.toContain('<at');
  expect(text).not.toContain('`2`');
  expect(text).toContain('&#91;任意链接&#93;');
});

it('recognizes Setup anywhere in the name without declaring a mandatory naming convention',()=>{
  for(const name of ['Setup','team-setup','setup-team','team:setup','setup_team','assetup','MySETUPWizard']) expect(isSetupSkillName(name)).toBe(true);
  expect(isSetupSkillName('feedback')).toBe(false);
});

it('returns links for the exact Bot and group with tenant and App channel isolation',()=>{
  const groupId=groupIdSchema.parse('oc_target');
  expect(recipeGroupLinks({appId:'cli_bot',tenant:'feishu'},groupId,'vonvon')).toEqual({
    chat:'https://applink.feishu.cn/client/chat/open?openChatId=oc_target',app:'vonvon://groups/cli_bot/oc_target',
  });
  expect(recipeGroupLinks({appId:'cli_bot',tenant:'lark'},groupId,'vonvon-preview')).toEqual({
    chat:'https://applink.larksuite.com/client/chat/open?openChatId=oc_target',app:'vonvon-preview://groups/cli_bot/oc_target',
  });
  expect(recipeGroupLinks({appId:'cli_bot',tenant:'feishu'},groupId,'https')).toHaveProperty('app','vonvon://groups/cli_bot/oc_target');
});
