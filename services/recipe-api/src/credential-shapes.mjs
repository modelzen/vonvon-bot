// Shared by the web editor before transmission and the API before persistence.
// These are recognisable credential formats, never a guarantee that text is public.
const boundary = '(?<![A-Za-z0-9_-])';
const tokens = new RegExp(boundary + '(?:' + [
  'sk-ant-[A-Za-z0-9_-]{8,}', 'sk-[A-Za-z0-9_-]{16,}',
  '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}', 'github_pat_[A-Za-z0-9_]{20,}',
  'xox[abp]-[A-Za-z0-9-]{8,}', 'AKIA[A-Z0-9]{16}(?![A-Za-z0-9])',
  'AIza[A-Za-z0-9_-]{30,}', 'eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}',
  'sb_secret_[A-Za-z0-9_-]{16,}',
].join('|') + ')');
const privateKey = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const fields = [['public','name'], ['public','summary'], ['public','overview'], ['public','version'], ['config','role']];

export function credentialField(draft) {
  for (const [group, field] of fields) {
    const value = draft?.[group]?.[field];
    if (typeof value === 'string' && (privateKey.test(value) || tokens.test(value))) return group + '.' + field;
  }
  return null;
}
