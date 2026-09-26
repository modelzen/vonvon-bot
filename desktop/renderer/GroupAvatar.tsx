import { MessageSquare } from 'lucide-react';
import type { Group } from '../shared/bridge';

export function GroupAvatar({ group, large = false }: { group: Group; large?: boolean }) {
  return <span className={`collaboration-avatar group${large ? ' large' : ''}`}>
    <MessageSquare size={large ? 24 : 16} />
    {group.avatarDataUrl && <img key={group.avatarDataUrl} alt="" aria-hidden="true"
      className="collaboration-avatar-image" data-loaded="false" src={group.avatarDataUrl}
      onLoad={event => { event.currentTarget.dataset.loaded = 'true'; }}
      onError={event => { event.currentTarget.dataset.failed = 'true'; }} />}
  </span>;
}
