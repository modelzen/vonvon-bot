import {fullCaseFold} from './unicode-full-case-fold.generated.js';

export function canonicalCaselessSegment(segment: string): string {
  let folded = '';
  for (const scalar of segment.normalize('NFD')) folded += fullCaseFold[scalar.codePointAt(0)!] ?? scalar;
  return folded.normalize('NFD');
}

const windowsDevice = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/;

export function isPortableDocumentName(name: string): boolean {
  if (!/\.(?:md|txt|rst)$/i.test(name) || /[\\:\u0000-\u001f<>"|?*]/u.test(name)) return false;
  return name.split('/').every(segment => {
    if (!segment || segment.startsWith('.') || /[. ]$/.test(segment)) return false;
    const stem = segment.split('.', 1)[0]!.replace(/ +$/, '').toUpperCase();
    return !windowsDevice.test(stem);
  });
}
