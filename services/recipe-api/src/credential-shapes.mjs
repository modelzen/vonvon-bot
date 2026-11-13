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
  const sensitive = value => typeof value === 'string' && (privateKey.test(value) || tokens.test(value));
  for (const [group, field] of fields) {
    if (sensitive(draft?.[group]?.[field])) return group + '.' + field;
  }
  const steps = draft?.config?.setup?.steps;
  if (Array.isArray(steps)) {
    for (const [index, step] of steps.entries()) {
      for (const field of ['title', 'instructions', 'check']) {
        if (sensitive(step?.[field])) return 'config.setup.steps.' + index + '.' + field;
      }
    }
  }
  return null;
}
