import { MessageCircle, MessageSquare } from 'lucide-react';
import type { Group } from '@vonvon/protocol';

export function GroupAvatar({ group, large = false, dm = false }: { group: Group; large?: boolean; dm?: boolean }) {
  const Icon = dm ? MessageCircle : MessageSquare;
  return <span className={`collaboration-avatar group${large ? ' large' : ''}`}>
    <Icon size={large ? 24 : 16} />
    {group.avatarDataUrl && <img key={group.avatarDataUrl} alt="" aria-hidden="true"
      className="collaboration-avatar-image" data-loaded="false" src={group.avatarDataUrl}
      onLoad={event => { event.currentTarget.dataset.loaded = 'true'; }}
      onError={event => { event.currentTarget.dataset.failed = 'true'; }} />}
  </span>;
}
