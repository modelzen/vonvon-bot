import {expect, it} from 'vitest';
import {groupCommands} from '../src/GroupUsage';

it('keeps conversation-only commands inside topics for multi-session groups', () => {
  const main=groupCommands('threads',false), topic=groupCommands('threads',true);
  expect(main.common.map(([command])=>command)).not.toContain('/model');
  expect(main.admin.map(([command])=>command)).toContain('/resume');
  expect(topic.common.map(([command])=>command)).toEqual(['/goal <目标>','/model','/context','/compact','/help']);
  expect(topic.admin).toEqual([]);
});
it('exposes shared and smart main-session controls while keeping administrator commands separate', () => {
  for (const kind of ['shared','smart'] as const) {
    const commands=groupCommands(kind,false);
    expect(commands.common.map(([command])=>command)).toContain('/context');
    expect(commands.admin.map(([command])=>command)).toEqual(['/new','/resume','/settings']);
    expect(groupCommands(kind,true).admin).toEqual([]);
  }
});
