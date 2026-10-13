import { describe, expect, it } from 'vitest';
import { classifyAddress } from '../../src/provider/outbound/address';

describe('classifyAddress', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['127.0.0.0', 'loopback'], ['127.0.0.1', 'loopback'], ['127.255.255.255', 'loopback'],
    ['10.0.0.0', 'private'], ['10.255.255.255', 'private'],
    ['172.16.0.0', 'private'], ['172.31.255.255', 'private'],
    ['192.168.0.0', 'private'], ['192.168.255.255', 'private'],
    ['169.254.0.0', 'link-local'], ['169.254.255.255', 'link-local'],
    ['100.64.0.0', 'carrier-grade'], ['100.127.255.255', 'carrier-grade'],
    ['::', 'unspecified'], ['0:0:0:0:0:0:0:0', 'unspecified'],
    ['::1', 'loopback'], ['0:0:0:0:0:0:0:1', 'loopback'],
    ['fc00::', 'private'], ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'private'],
    ['FD12:3456:789A::1', 'private'],
    ['fe80::', 'link-local'], ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'link-local'],
    ['FE80:0000:0000:0000:0000:0000:0000:0001', 'link-local'],
    ['::ffff:0:0', 'mapped'], ['::ffff:ffff:ffff', 'mapped'],
    ['::ffff:127.0.0.1', 'mapped'], ['::ffff:10.0.0.1', 'mapped'],
    ['::ffff:8.8.8.8', 'mapped'], ['::ffff:0808:0808', 'mapped'],
    ['::FFFF:7F00:1', 'mapped'], ['0:0:0:0:0:ffff:808:808', 'mapped'],
    ['0000:0000:0000:0000:0000:FFFF:8.8.8.8', 'mapped'],
    ['::ffff:0.0.0.0', 'mapped'], ['::ffff:255.255.255.255', 'mapped'],
  ])('denies %s as %s', (address, reason) => {
    expect(classifyAddress(address)).toEqual({ allowed: false, reason });
  });

  it.each([
    '0.0.0.1', '0.255.255.255',
    '126.255.255.255', '128.0.0.0',
    '9.255.255.255', '11.0.0.0',
    '172.15.255.255', '172.32.0.0',
    '192.167.255.255', '192.169.0.0',
    '169.253.255.255', '169.255.0.0',
    '100.63.255.255', '100.128.0.0',
    '8.8.8.8', '1.1.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
  ])('allows IPv4 %s without adding special-use exclusions', address => {
    expect(classifyAddress(address)).toEqual({ allowed: true, address, family: 4 });
  });

  it.each([
    '::2', 'fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe00::',
    'fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fec0::',
    '::fffe:ffff:ffff', '::1:0:0:0',
    '2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888',
    '2001::', '2001:db8:1:2:3:4::5', '2001:db8:1:2:3:4:5::',
    '2001:0DB8:0000:0000:0000:0000:0000:ABCD', '2001:db8::abcd',
    '::8.8.8.8', '2001:db8::192.0.2.1', '2001:db8:0:0:0:0:192.0.2.1',
    '64:ff9b::192.168.1.1', 'ff02::1',
  ])('allows IPv6 %s and retains the validated spelling', address => {
    expect(classifyAddress(address)).toEqual({ allowed: true, address, family: 6 });
  });

  it.each([
    '', 'localhost', 'example.com', 'https://8.8.8.8',
    '127.1', '127.0.1', '2130706433', '0x7f000001', '0177.0.0.1',
    '01.2.3.4', '1.2.3', '1.2.3.4.5', '256.0.0.1', '-1.0.0.0', '+1.2.3.4',
    '8.8.8.8:443', ' 8.8.8.8', '8.8.8.8 ', '8.8.8.8\n', '8.8.8.8\0',
    '[::1]', '[2001:4860::8888]', '[::ffff:8.8.8.8]', '[::1]:443',
    'fe80::1%en0', '2001:db8::1%1', '::1%25eth0',
    ':', ':::', '1::2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9',
    '12345::1', 'gggg::1', '::ffff:256.0.0.1', '::ffff:008.8.8.8',
    '::ffff:8.8.8', '1:2:3:4:5:6:7:8::', '::1\n', '::1\0',
    '地址', '\ud800',
  ])('returns invalid for malformed external string %s', address => {
    expect(classifyAddress(address)).toEqual({ allowed: false, reason: 'invalid' });
  });

  it('returns invalid without throwing for long and arbitrary external strings', () => {
    const inputs = [
      'a'.repeat(100_000), ':'.repeat(100_000), '1.'.repeat(50_000),
      ...Array.from({ length: 256 }, (_, code) => `8.8.8.8${String.fromCharCode(code)}x`),
    ];
    for (const address of inputs) {
      expect(classifyAddress(address)).toEqual({ allowed: false, reason: 'invalid' });
    }
  });
});
