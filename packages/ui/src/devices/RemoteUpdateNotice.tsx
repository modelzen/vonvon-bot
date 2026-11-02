import {useEffect, useState} from 'react';
import {useShellCapabilities} from '../client-context';
import {InlineNotice} from '../reference/components/ui';

/** U4: while another device updates this computer's Vonvon Bot, one line on top of the page says who and what happens
 * next. It cannot be closed: it goes when the update ends here, or the app restarts. */
export function RemoteUpdateNotice() {
  const subscribe = useShellCapabilities()?.onRemoteUpdate;
  const [text, setText] = useState<string>();
  useEffect(() => subscribe?.(setText), [subscribe]);
  return <RemoteUpdateNoticeView text={text}/>;
}

export function RemoteUpdateNoticeView({text}: {text: string | undefined}) {
  if (!text) return null;
  return <InlineNotice title="正在远程更新这台电脑" tone="info">{text}</InlineNotice>;
}
