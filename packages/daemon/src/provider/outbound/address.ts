import { isIP } from 'node:net';

export type AddressVerdict =
  | { allowed: true; address: string; family: 4 | 6 }
  | { allowed: false; reason: 'invalid' | 'unspecified' | 'loopback' | 'private' | 'link-local' | 'mapped' | 'carrier-grade' };

type DeniedRange = readonly [network: bigint, prefixLength: number, reason: Extract<AddressVerdict, { allowed: false }>['reason']];

const IPV4_DENIED: readonly DeniedRange[] = [
  [0x00000000n, 32, 'unspecified'],
  [0x7f000000n, 8, 'loopback'],
  [0x0a000000n, 8, 'private'],
  [0xac100000n, 12, 'private'],
  [0xc0a80000n, 16, 'private'],
  [0xa9fe0000n, 16, 'link-local'],
  [0x64400000n, 10, 'carrier-grade'],
];

const IPV6_DENIED: readonly DeniedRange[] = [
  [0n, 128, 'unspecified'],
  [1n, 128, 'loopback'],
  [0xfc000000000000000000000000000000n, 7, 'private'],
  [0xfe800000000000000000000000000000n, 10, 'link-local'],
  [0x00000000000000000000ffff00000000n, 96, 'mapped'],
];

function decodeIPv4(address: string): bigint {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function decodeIPv6(address: string): bigint {
  const [left = '', right = ''] = address.split('::');
  const words = (part: string): bigint[] => part.split(':').filter(Boolean).flatMap(word => {
    if (!word.includes('.')) return [BigInt(`0x${word}`)];
    const ipv4 = decodeIPv4(word);
    return [ipv4 >> 16n, ipv4 & 0xffffn];
  });
  const head = words(left);
  const tail = words(right);
  const expanded = [...head, ...Array<bigint>(8 - head.length - tail.length).fill(0n), ...tail];
  return expanded.reduce((value, word) => (value << 16n) | word, 0n);
}

export function classifyAddress(address: string): AddressVerdict {
  if (address.includes('%')) return { allowed: false, reason: 'invalid' };
  const family = isIP(address);
  if (family !== 4 && family !== 6) return { allowed: false, reason: 'invalid' };

  const value = family === 4 ? decodeIPv4(address) : decodeIPv6(address);
  const width = family === 4 ? 32 : 128;
  const ranges = family === 4 ? IPV4_DENIED : IPV6_DENIED;
  for (const [network, prefixLength, reason] of ranges) {
    const shift = BigInt(width - prefixLength);
    if ((value >> shift) === (network >> shift)) return { allowed: false, reason };
  }
  return { allowed: true, address, family };
}
