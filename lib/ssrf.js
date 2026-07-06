// SSRF guard. The shredder fetches arbitrary user-supplied URLs, so once it is
// public it must refuse to reach private, loopback, link-local (incl. cloud
// metadata at 169.254.169.254) and other reserved address space.
//
// The check is wired in as the DNS `lookup` option on every outbound request,
// so the exact address the socket connects to is the one we validate — closing
// the DNS-rebinding gap that a separate pre-flight lookup would leave open.
import dns from 'node:dns';
import net from 'node:net';

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (base, bits) => {
    const shift = 32 - bits;
    return (n >>> shift) === (ipv4ToInt(base) >>> shift);
  };
  // Focused on address space that can reach internal/cloud infrastructure.
  // (TEST-NET / benchmarking ranges are intentionally NOT blocked: they carry
  // no internal-service risk and some intercepting resolvers legitimately map
  // real hosts onto them.)
  return (
    inRange('0.0.0.0', 8) ||        // "this" network
    inRange('10.0.0.0', 8) ||       // RFC1918 private
    inRange('100.64.0.0', 10) ||    // CGNAT (used for internal cloud networking)
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local (incl. 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) ||    // RFC1918 private
    inRange('192.168.0.0', 16) ||   // RFC1918 private
    (n >>> 28) === 0xE ||           // 224.0.0.0/4 multicast
    (n >>> 28) === 0xF              // 240.0.0.0/4 reserved + 255.255.255.255
  );
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;                 // loopback / unspecified
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);     // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (s.startsWith('fe80')) return true;                      // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true;  // unique local fc00::/7
  if (s.startsWith('fec0')) return true;                      // deprecated site-local
  if (s.startsWith('ff')) return true;                        // multicast
  return false;
}

export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // unknown format → block
}

// Node's HTTP stack skips the `lookup` callback when the host is already a
// numeric IP literal, so safeLookup alone can't catch `http://127.0.0.1`.
// Call this on every request URL's hostname to close that gap.
export function hostIsBlockedLiteral(hostname) {
  const h = (hostname || '').replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return isBlockedAddress(h);
  return false; // not a literal → the DNS path (safeLookup) validates it
}

// Drop-in replacement for dns.lookup that rejects reserved addresses. Matches
// the (hostname, options, callback) signature Node's http agent expects.
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const addrs = Array.isArray(address) ? address.map((a) => a.address) : [address];
    for (const a of addrs) {
      if (isBlockedAddress(a)) {
        return callback(new Error('blocked: private or reserved address'));
      }
    }
    callback(null, address, family);
  });
}
