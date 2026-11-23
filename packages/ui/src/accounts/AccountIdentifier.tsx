import {useState} from 'react';
import {Button} from '../reference/components/ui';

export function AccountIdentifier({accountId}: {accountId: string}) {
  const [feedback, setFeedback] = useState<string>();
  async function copy() {
    try {await navigator.clipboard.writeText(accountId); setFeedback('用户 ID 已复制。');}
    catch {setFeedback('复制未完成，请选中用户 ID 手动复制。');}
  }
  return <div className="account-identifier"><code>{accountId}</code><Button onClick={() => {void copy();}}>复制用户 ID</Button>{feedback && <span role="status">{feedback}</span>}</div>;
}
