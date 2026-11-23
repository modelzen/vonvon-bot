import {expect,it} from 'vitest';
import {parseGroupConfigurationLink} from '../src/group-navigation';

it.each(['vonvon','vonvon-preview'])('recognizes only the exact %s group configuration route',scheme=>{
  expect(parseGroupConfigurationLink(`${scheme}://groups/cli_bot/oc_group`)).toEqual({scheme,botAppId:'cli_bot',groupId:'oc_group'});
});

it.each([undefined,0,'file:///tmp/group','javascript:alert(1)','other://groups/cli_bot/oc_group',
  'vonvon://run/cli_bot/oc_group','vonvon://groups/cli_bot/oc_group/','vonvon://groups/cli_bot/oc_group?command=run',
  'vonvon://groups/cli_bot/oc_group#anything','vonvon://groups/cli_bot/oc_group\n','vonvon://groups/cli_bot/oc_%67roup',
  'vonvon://groups/not_a_bot/oc_group','vonvon://groups/cli_bot/not_a_group',
  'vonvon://user:pass@groups/cli_bot/oc_group'])('rejects an unknown or modified group route (%s)',raw=>{
  expect(parseGroupConfigurationLink(raw)).toBeUndefined();
});
