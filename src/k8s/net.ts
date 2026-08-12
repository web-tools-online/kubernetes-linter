/**
 * IP address and CIDR formats, as the apiserver reads them.
 *
 * Kubernetes parses these with Go's net/netip, which since Go 1.17 rejects the
 * forms C's inet_aton used to accept — a leading zero in an octet is an error
 * rather than an octal escape, and there are no three-part or single-integer
 * addresses. The parsers here match that, since a manifest carrying "010.1.1.1"
 * is rejected by the apiserver rather than read as 8.1.1.1.
 */

import type { FormatCheck } from './names.js';

export interface IPCheck extends FormatCheck {
  /** 4 or 6, when the value parsed. */
  family?: 4 | 6;
  /**
   * The parsed address as numeric groups, when the value parsed: four bytes
   * (0-255) for IPv4, eight 16-bit groups (0-65535) for IPv6 with any "::"
   * elision expanded. Used for CIDR containment.
   */
  groups?: number[];
}

export interface CIDRCheck extends IPCheck {
  /** The prefix length, when the value parsed. */
  bits?: number;
}

export function isIPAddress(value: string): IPCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };
  return value.includes(':') ? parseIPv6(value) : parseIPv4(value);
}

/** A CIDR block: an address and a prefix length its family allows. */
export function isCIDR(value: string): CIDRCheck {
  const slash = value.indexOf('/');
  if (slash === -1) {
    return { ok: false, reason: 'must include a prefix length, such as "10.0.0.0/8"' };
  }

  const address = isIPAddress(value.slice(0, slash));
  if (!address.ok) return { ok: false, reason: `has an address part that ${address.reason}` };

  const bitsText = value.slice(slash + 1);
  const max = address.family === 4 ? 32 : 128;
  if (!/^\d+$/.test(bitsText) || Number(bitsText) > max) {
    return {
      ok: false,
      reason: `must have a prefix length between 0 and ${max} for an IPv${address.family} block`,
    };
  }
  return { ok: true, family: address.family, groups: address.groups, bits: Number(bitsText) };
}

/**
 * Does `address` fall within `network`'s first `bits` bits? Mirrors Go's
 * `net.IPNet.Contains`: only the prefix is compared, so bits set beyond it —
 * on either side — are ignored rather than requiring `network` to already be
 * in canonical masked form. `false` for a family mismatch, an address that
 * failed to parse, or a `network` that is not a successfully parsed CIDR.
 */
export function cidrContains(network: CIDRCheck, address: IPCheck): boolean {
  if (!network.ok || network.family === undefined || network.bits === undefined || !network.groups) {
    return false;
  }
  if (!address.ok || address.family !== network.family || !address.groups) return false;

  const unitBits = network.family === 4 ? 8 : 16;
  let remaining = network.bits;
  for (let index = 0; index < network.groups.length && remaining > 0; index++) {
    const width = Math.min(unitBits, remaining);
    const mask = ((1 << width) - 1) << (unitBits - width);
    if (((address.groups[index] ?? 0) & mask) !== ((network.groups[index] ?? 0) & mask)) return false;
    remaining -= width;
  }
  return true;
}

/**
 * The canonical network form of a parsed CIDR block: its address with every
 * bit beyond the prefix length cleared, the fix value for a block that has
 * host bits set.
 */
export function maskCIDR(cidr: CIDRCheck): string {
  const { family, groups, bits } = cidr;
  if (!cidr.ok || family === undefined || groups === undefined || bits === undefined) {
    return '';
  }
  const unitBits = family === 4 ? 8 : 16;
  const masked = groups.map((value, index) => {
    const start = index * unitBits;
    if (start >= bits) return 0;
    const width = Math.min(unitBits, bits - start);
    const mask = ((1 << width) - 1) << (unitBits - width);
    return value & mask;
  });
  const address = family === 4 ? masked.join('.') : formatIPv6(masked);
  return `${address}/${bits}`;
}

/**
 * Addresses the apiserver refuses in externalIPs, mirroring
 * validateNonSpecialIP: an address that only means something to the node
 * itself can never be one a client outside it reaches the Service on.
 */
export function isSpecialIP(value: string): string | undefined {
  const parsed = isIPAddress(value);
  if (!parsed.ok) return undefined;

  if (parsed.family === 4) {
    const octets = value.split('.').map(Number);
    if (value === '0.0.0.0') return 'is the unspecified address';
    if (octets[0] === 127) return 'is a loopback address';
    if (octets[0] === 169 && octets[1] === 254) return 'is a link-local address';
    if (octets[0] === 224 && octets[1] === 0 && octets[2] === 0) return 'is a link-local multicast address';
    return undefined;
  }

  const lower = value.toLowerCase();
  if (/^0*:(0*:)*0*$/.test(lower)) return 'is the unspecified address';
  if (/^(0*:)*0*:0*1$/.test(lower)) return 'is a loopback address';
  // fe80::/10 is link-local unicast, ff02::/16 link-local multicast.
  if (/^fe[89ab]/.test(lower)) return 'is a link-local address';
  if (/^ff0*2:/.test(lower)) return 'is a link-local multicast address';
  return undefined;
}

function parseIPv4(value: string): IPCheck {
  const octets = value.split('.');
  if (octets.length !== 4) {
    return { ok: false, reason: 'must be four dot-separated numbers, such as "10.0.0.1"' };
  }
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) {
      return { ok: false, reason: 'must be four dot-separated numbers, such as "10.0.0.1"' };
    }
    if (octet.length > 1 && octet.startsWith('0')) {
      return { ok: false, reason: 'must not have a leading zero in an octet' };
    }
    if (Number(octet) > 255) return { ok: false, reason: 'has an octet above 255' };
  }
  return { ok: true, family: 4, groups: octets.map(Number) };
}

function parseIPv6(value: string): IPCheck {
  const halves = value.split('::');
  if (halves.length > 2) {
    return { ok: false, reason: 'must not contain "::" more than once' };
  }

  // A trailing dotted-quad ("::ffff:10.0.0.1") stands in for the last two
  // groups; it is tracked separately from `sides` so the "how many zero
  // groups does '::' stand for" arithmetic below only counts hex groups.
  const sides: number[][] = [];
  let expected = 8;
  let embedded: number[] = [];
  for (const [index, half] of halves.entries()) {
    const parts = half.length === 0 ? [] : half.split(':');
    const last = parts[parts.length - 1];
    if (index === halves.length - 1 && last !== undefined && last.includes('.')) {
      const parsedV4 = parseIPv4(last);
      if (!parsedV4.ok) return { ok: false, reason: `has an embedded IPv4 address that ${parsedV4.reason}` };
      parts.pop();
      expected -= 2;
      const [a, b, c, d] = parsedV4.groups!;
      embedded = [(a! << 8) | b!, (c! << 8) | d!];
    }

    for (const group of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        return { ok: false, reason: 'must be groups of up to four hexadecimal digits separated by ":"' };
      }
    }

    sides.push(parts.map((group) => parseInt(group, 16)));
  }

  let groups: number[];
  if (halves.length === 2) {
    const [left, right] = sides as [number[], number[]];
    const zeros = expected - (left.length + right.length);
    if (zeros < 1) {
      return { ok: false, reason: '"::" must stand for at least one group of zeros' };
    }
    groups = [...left, ...new Array(zeros).fill(0), ...right, ...embedded];
  } else {
    const only = sides[0]!;
    if (only.length !== expected) {
      return { ok: false, reason: `must have ${expected} groups, or use "::" to elide a run of zeros` };
    }
    groups = [...only, ...embedded];
  }

  return { ok: true, family: 6, groups };
}

/** Render 16-bit groups back to text, eliding the longest run of zeros with "::". */
function formatIPv6(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= groups.length; index++) {
    const isZero = index < groups.length && groups[index] === 0;
    if (isZero) {
      if (runStart === -1) runStart = index;
      continue;
    }
    if (runStart !== -1) {
      const length = index - runStart;
      if (length > bestLength) {
        bestLength = length;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }

  if (bestLength < 2) return groups.map((group) => group.toString(16)).join(':');

  const before = groups.slice(0, bestStart).map((group) => group.toString(16));
  const after = groups.slice(bestStart + bestLength).map((group) => group.toString(16));
  return `${before.join(':')}::${after.join(':')}`;
}
