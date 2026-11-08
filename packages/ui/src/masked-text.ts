/** now-share: a masked name is U+3000 for each of its characters, as wide as a CJK one and never collapsed. Where a
 * name is printed, `data-masked` marks it, and the share card paints it as mosaic; nothing else ever gets one. */
const MASK = '\u3000';
export const maskText = (text: string) => MASK.repeat(Math.max(1, [...text].length));
export const maskedMark = (text: string) => text.length > 0 && [...text].every(char => char === MASK) || undefined;
