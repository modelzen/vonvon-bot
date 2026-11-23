import type {Buffer} from 'node:buffer';

export function staticLogoFormat(bytes: Buffer, normalized?: boolean): 'png' | 'jpeg' | 'webp';
