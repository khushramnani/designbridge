// SSRF egress guard (TECHNICAL-SPEC §7, NFR-4). The worker renders attacker-controlled URLs, so
// before navigating we require https and resolve the host, rejecting any address in a private,
// loopback, link-local, or cloud-metadata range. `lookup` is injected so this is unit-testable.

export type DnsLookup = (host: string) => Promise<string[]>;

export class BlockedUrlError extends Error {
  constructor(
    message: string,
    readonly code = "nav_blocked",
  ) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/** True if an IP literal is in a range we must never fetch (SSRF). Handles IPv4 + common IPv6. */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip) ?? parseIpv4MappedV6(ip);
  if (v4 !== null) return isBlockedV4(v4);
  return isBlockedV6(ip);
}

function isBlockedV4(n: number): boolean {
  const inRange = (base: string, prefix: number) => {
    const b = parseIpv4(base)!;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange("0.0.0.0", 8) ||
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) || // link-local incl. 169.254.169.254 metadata
    inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) ||
    inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) ||
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved
  );
}

function isBlockedV6(ip: string): boolean {
  const x = ip.toLowerCase().split("%")[0]!; // strip zone id
  if (x === "::1" || x === "::") return true;
  if (x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (x.startsWith("fc") || x.startsWith("fd")) return true; // fc00::/7 unique-local
  if (x.startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

function parseIpv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function parseIpv4MappedV6(ip: string): number | null {
  const m = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip.trim());
  return m ? parseIpv4(m[1]!) : null;
}

/** Reject non-https URLs and any host that resolves to a blocked address. */
export async function assertSafeUrl(rawUrl: string, lookup: DnsLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("malformed URL");
  }
  if (url.protocol !== "https:") {
    throw new BlockedUrlError(`protocol not allowed: ${url.protocol} (https only)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // a literal IP host is checked directly; otherwise resolve and check every answer
  if (isBlockedIp(host)) throw new BlockedUrlError(`blocked host address: ${host}`);
  const addrs = isIpLiteral(host) ? [host] : await lookup(host);
  if (addrs.length === 0) throw new BlockedUrlError(`host did not resolve: ${host}`);
  for (const addr of addrs) {
    if (isBlockedIp(addr)) throw new BlockedUrlError(`host resolves to blocked address: ${addr}`);
  }
  return url;
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || host.includes(":");
}
