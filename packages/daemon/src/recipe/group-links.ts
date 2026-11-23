import type { GroupId } from '@vonvon/protocol';
import type { BotIdentity } from '../config/bots';

export function recipeGroupLinks(bot: Pick<BotIdentity, 'appId' | 'tenant'>, groupId: GroupId, appScheme = process.env.VONVON_APP_SCHEME) {
  const scheme = appScheme === 'vonvon-preview' ? 'vonvon-preview' : 'vonvon';
  const domain = bot.tenant === 'lark' ? 'larksuite.com' : 'feishu.cn';
  return {
    chat: `https://applink.${domain}/client/chat/open?openChatId=${encodeURIComponent(groupId)}`,
    app: `${scheme}://groups/${encodeURIComponent(bot.appId)}/${encodeURIComponent(groupId)}`,
  };
}
