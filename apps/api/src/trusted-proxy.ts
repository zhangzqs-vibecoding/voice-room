import { isIP } from 'node:net';

interface CidrRange {
  address: bigint;
  bits: number;
  prefix: number;
}

const invalid = (): never => {
  throw new Error('TRUSTED_PROXY_CIDRS contains an invalid IP or CIDR');
};

const ipv4ToBigInt = (address: string): bigint => address.split('.').reduce((value, octet) => (value << 8n) + BigInt(octet), 0n);

const ipv6ToBigInt = (address: string): bigint => {
  const [head, tail] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const dottedPart = tailParts.at(-1);
  if (dottedPart && isIP(dottedPart) === 4) {
    tailParts.splice(-1, 1, ...[24, 16, 8, 0].map((shift) => ((ipv4ToBigInt(dottedPart) >> BigInt(shift)) & 0xffn).toString(16)));
  }
  const parts = [...headParts, ...Array.from({ length: 8 - headParts.length - tailParts.length }, () => '0'), ...tailParts];
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part || '0'}`), 0n);
};

const parseRange = (value: string): CidrRange => {
  const [address, prefixText, ...rest] = value.split('/');
  if (!address || rest.length > 0 || (prefixText !== undefined && !/^\d+$/.test(prefixText))) invalid();
  const version = isIP(address);
  if (version === 0) invalid();
  const bits = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (prefix <= 0 || prefix > bits) invalid();
  return { address: version === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address), bits, prefix };
};

export const parseTrustedProxyCidrs = (value: string | undefined): string[] => {
  if (value === undefined || value.trim() === '') return [];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) invalid();
  entries.forEach(parseRange);
  return entries;
};

export const compileTrustedProxy = (entries: readonly string[]): ((address: string) => boolean) => {
  const ranges = entries.map(parseRange);
  return (address: string): boolean => {
    const version = isIP(address);
    if (version === 0) return false;
    const bits = version === 4 ? 32 : 128;
    const numericAddress = version === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
    return ranges.some((range) => range.bits === bits && (range.prefix === 0 || (numericAddress >> BigInt(bits - range.prefix)) === (range.address >> BigInt(bits - range.prefix))));
  };
};
