'use strict';
// SSRF protection: URL validation, private/reserved IP blocking (IPv4 + IPv6),
// and DNS-resolution revalidation. Every fetch must pass through
// assertSafeUrl() and every redirect hop must be revalidated.
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const config = require('./config');

class UnsafeUrlError extends Error {
  constructor(reason) {
    super(`Blocked unsafe URL: ${reason}`);
    this.code = 'UNSAFE_URL';
  }
}

const ALLOWED_PORTS = new Set([80, 443]);

// Only allow fully-formed http(s) URLs with a hostname, no embedded credentials,
// no non-default ports outside 80/443, and no unusual protocols.
function parseHttpUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new UnsafeUrlError('invalid input');
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('unparseable URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UnsafeUrlError(`scheme "${u.protocol}" not allowed`);
  }
  if (u.username || u.password) throw new UnsafeUrlError('URL credentials not allowed');
  if (u.hostname.length === 0) throw new UnsafeUrlError('missing hostname');
  if (u.port && !config.ssrf.allowPrivateIps) {
    const p = Number(u.port);
    if (!Number.isInteger(p) || !ALLOWED_PORTS.has(p)) {
      throw new UnsafeUrlError(`port ${u.port} not allowed (only 80/443)`);
    }
  }
  // Reject obviously internal-looking hostnames before DNS.
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new UnsafeUrlError('internal hostname');
  }
  return u;
}

function isPrivateIpv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0) return true;                                    // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                   // 10.0.0.0/8 private
  if (a === 127) return true;                                  // loopback
  if (a === 169 && b === 254) return true;                     // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;                     // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;            // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true;                       // 192.0.0.0/24 + 192.0.2.0/24 reserved
  if (a === 198 && (b === 18 || b === 19)) return true;         // benchmarking
  if (a >= 224) return true;                                   // multicast + reserved
  if (a === 255) return true;                                   // broadcast
  return false;
}

function isPrivateIpv6(ip) {
  let raw = ip.toLowerCase();
  if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);
  if (!raw.includes(':')) return false;
  const [head, tail] = raw.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups];
  if (raw.includes('::')) {
    for (let i = 0; i < missing; i++) groups.push('0');
    groups.push(...tailGroups);
  } else {
    groups.length = 0;
    groups.push(...raw.split(':'));
  }
  if (groups.length !== 8) return true; // malformed -> block
  const nums = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return true;
    nums.push(parseInt(g, 16));
  }
  const h0 = nums[0], h1 = nums[1];
  const zero = (from, to) => { for (let i = from; i <= to; i++) if (nums[i] !== 0) return false; return true; };
  if (zero(0, 7)) return true;                                        // ::/128 unspecified
  if (zero(0, 6) && nums[7] === 1) return true;                        // ::1 loopback
  if (zero(0, 4) && nums[5] === 0xffff) return true;                   // ::ffff:0:0/96 IPv4-mapped
  if (h0 === 0x64 && h1 === 0xff9b && zero(2, 6)) return true;         // 64:ff9b::/96 NAT64
  if ((h0 & 0xffc0) === 0xfe80) return true;                          // fe80::/10 link-local
  if ((h0 & 0xfe00) === 0xfc00) return true;                          // fc00::/7 unique local
  if ((h0 & 0xff00) === 0xff00) return true;                          // ff00::/8 multicast
  if (h0 === 0x100 && zero(1, 6)) return true;                        // 100::/64 discard-only
  if (h0 === 0x2001 && h1 === 0xdb8) return true;                     // 2001:db8::/32 documentation
  if (zero(0, 5) && (nums[6] !== 0 || nums[7] !== 0)) return true;    // other embedded/derived loopback forms
  return false;
}

function isPrivateAddress(ip) {
  if (ip.includes(':')) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
}

// Resolve the hostname and verify every resulting address is safe.
// Returns the list of resolved addresses (for network-level pinning by callers).
async function resolveAndCheck(urlObj) {
  const host = urlObj.hostname.replace(/^\[|\]$/g, '');
  // Literal IP?
  if (net.isIPv4(host)) {
    if (!config.ssrf.allowPrivateIps && isPrivateIpv4(host)) {
      throw new UnsafeUrlError('literal private/reserved IPv4 address');
    }
    return [host];
  }
  if (net.isIPv6(host)) {
    if (!config.ssrf.allowPrivateIps && isPrivateIpv6(host)) {
      throw new UnsafeUrlError('literal private/reserved IPv6 address');
    }
    return [host];
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(`DNS resolution failed for ${host}`);
  }
  if (addrs.length === 0) throw new UnsafeUrlError(`no DNS records for ${host}`);
  for (const a of addrs) {
    if (!config.ssrf.allowPrivateIps && isPrivateAddress(a.address)) {
      throw new UnsafeUrlError(`${host} resolves to private/reserved address ${a.address}`);
    }
  }
  return addrs.map((a) => a.address);
}

// Full validation pipeline. Throws UnsafeUrlError on anything disallowed.
async function assertSafeUrl(raw) {
  const u = parseHttpUrl(raw);
  await resolveAndCheck(u);
  return u;
}

// Normalize for duplicate detection: strip hash, sort nothing else, lowercase host,
// default ports removed by URL serialization.
function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  return u.toString();
}

function domainOf(raw) {
  try {
    const u = new URL(raw);
    let host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (u.port && u.port !== '80' && u.port !== '443') host += ':' + u.port;
    return host;
  } catch {
    return null;
  }
}

module.exports = { UnsafeUrlError, parseHttpUrl, assertSafeUrl, resolveAndCheck, isPrivateAddress, isPrivateIpv4, isPrivateIpv6, normalizeUrl, domainOf };
