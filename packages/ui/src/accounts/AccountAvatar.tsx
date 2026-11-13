import type {AccountStatus} from '@vonvon/protocol';
import './accounts.css';

type Identity = Extract<AccountStatus, {kind: 'signedIn'}>;
export function AccountAvatar({identity, size = 'small'}: {identity: Identity; size?: 'small' | 'large'}) {
  const initials = Array.from(identity.displayName.trim()).slice(0, 2).join('').toLocaleUpperCase();
  const avatar = identity.avatarDataUrl;
  return <span className="account-avatar" data-size={size} aria-hidden="true">
    <span>{initials}</span>
    {avatar && /^data:image\/(?:png|jpeg|webp);base64,/.test(avatar) && <img key={avatar} src={avatar} alt="" onError={event => {event.currentTarget.hidden = true;}}/>}
  </span>;
}
