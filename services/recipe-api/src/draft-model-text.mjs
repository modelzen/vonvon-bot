import {credentialField} from './credential-shapes.mjs';

const privateInput = /(?:[/\\](?:Users|home|root|private|var|tmp|etc|mnt|Volumes)[/\\]|[A-Za-z]:[\\/]|~[/\\]|https?:\/\/|(?:ou|oc|cli)_[\w-]{4,}|\bBearer\s+\S+|(?:password|api[_ -]?key|access[_ -]?token|密码|令牌|密钥)\s*[:=：]\s*\S+)/iu;

export function safeDraftModelText(text) {
  return typeof text === 'string' && [...text].length <= 2000 && !privateInput.test(text) && !credentialField({public:{name:text}});
}
