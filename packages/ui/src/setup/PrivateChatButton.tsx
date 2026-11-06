import {ArrowUpRight} from 'lucide-react';
import type {AdminSetupStatus, Agent} from '@vonvon/protocol';
import {useShellCapabilities} from '../client-context';
import {Button} from '../reference/components/ui';
import {botChatUrl, openExternalUrl} from '../url-actions';

/** Where 去飞书私聊 goes. Which client it opens depends on the tenant, known once the bot's status has been read. */
export function privateChatUrl(status: Pick<AdminSetupStatus, 'appId' | 'tenant'> | undefined): string | undefined {
  return status ? botChatUrl(status.appId, status.tenant) : undefined;
}

/** The other way into a new bot, next to the one to a group: the user picks (dm-agent, 第一次见面). */
export function PrivateChatButton({agent, status, onNotice}: {agent: Agent; status?: AdminSetupStatus; onNotice: (message: string, error: boolean) => void}) {
  const shell = useShellCapabilities();
  const url = privateChatUrl(status);
  return <Button size="sm" disabled={!url} title={`在飞书里和「${agent.name}」私聊`}
    onClick={() => { if (url) void openExternalUrl(url, 'bot-chat', shell).catch(error => onNotice(error instanceof Error ? error.message : '无法打开飞书。', true)); }}>
    去飞书私聊<ArrowUpRight size={13} aria-hidden="true"/>
  </Button>;
}
