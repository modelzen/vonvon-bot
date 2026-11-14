import {credentialField} from './credential-shapes.mjs';

const privateText = /(?:(?:ou|oc|cli)_[\w-]{4,}|\bBearer\s+\S+|(?:password|api[_ -]?key|access[_ -]?token|密码|令牌|密钥)\s*[:=：]\s*\S+)/iu;
const localPath = /(?:[/\\](?:Users|home|root|private|var|tmp|etc|mnt|Volumes)[/\\]|~[\\/]|[a-z]:[\\/]|\\\\[a-z0-9])/iu;
// A route such as https://docs.example/home/start is public; query strings and adjacent prose still need checking.
const webPath = /https?:\/\/(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::\d+)?(?:\/[\p{L}\p{N}._~%/+\-]*)?/giu;

export function hasAuthoringLocalPath(text) {
  return localPath.test(text.replace(webPath, ' '));
}
export function safeEditValue(value) {
  if (typeof value === 'string') return !hasAuthoringLocalPath(value) && !privateText.test(value) && !credentialField({public:{name:value}});
  return !value || typeof value !== 'object' || Object.values(value).every(safeEditValue);
}
// Provider input has a tighter budget and excludes URLs entirely.
export function safeDraftModelText(text) {
  return typeof text === 'string' && [...text].length <= 2000 && !/https?:\/\//iu.test(text) && safeEditValue(text);
}
