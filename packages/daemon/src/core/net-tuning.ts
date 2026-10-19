import dns from 'node:dns';
import net from 'node:net';

/**
 * How long each connection attempt of Node's happy eyeballs (`autoSelectFamily`) waits before the next address is
 * tried (s23f2). Node's 250 ms turned a slow connect into a failure: TypeSafe has two A and two AAAA records, a host
 * without an IPv6 route fails the AAAA ones at once, and two IPv4 attempts each slower than 250 ms ended as an
 * AggregateError with code ETIMEDOUT. 1 s is Linux's first SYN retransmission timeout, so it rides out a SYN-ACK that
 * is late, not one that is lost. Feishu has only A records and its last attempt has no timer, so it never failed this
 * way; for it a larger value is a cost: one lost SYN to the first address now waits about 1 s, not 250 ms, before
 * the second is tried.
 */
export const AUTO_SELECT_ATTEMPT_MS = 1_000;

/**
 * Sets the process-wide connection defaults, before any connection is made. Every daemon process runs it: the CLI
 * entry calls it first, and the supervisor starts each bot with that same entry. Both outgoing stacks take the global
 * defaults: the Feishu SDK (axios with no agent of its own, so `https.globalAgent` and `net.connect`) and the
 * judgement's `fetch` (Node's undici, which passes no `autoSelectFamily` options of its own).
 *
 * `ipv4first` changes nothing where the resolver already lists IPv4 first (glibc on a host without IPv6). It is for
 * a dual-stack Mac, which may list IPv6 first: with IPv4 tried first, a broken IPv6 never costs the larger attempt
 * timeout, and IPv6 is still tried when IPv4 does not connect.
 */
export function tuneNetworkDefaults(): void {
  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamilyAttemptTimeout(AUTO_SELECT_ATTEMPT_MS);
}
