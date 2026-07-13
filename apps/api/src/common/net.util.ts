/**
 * Small network-safety helpers shared by the S3 gateway (local-endpoint
 * detection) and the OnlyOffice download guard (SSRF allow-listing).
 */

/** The hostname of a URL, lower-cased and de-bracketed, or null when unparseable. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * True when `host` is a loopback, link-local, or RFC-1918 private address (or a
 * loopback alias like `localhost` / `host.docker.internal`). Used to (a) decide
 * whether a MinIO credential default is safe (a local endpoint) and (b) reject
 * SSRF targets — cloud metadata `169.254.169.254`, internal `10./172.16-31./192.168.`
 * hosts — that are not explicitly allow-listed.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true; // empty host is not routable — treat as unsafe/local
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'host.docker.internal') return true;
  // IPv6 loopback / unspecified / unique-local / link-local.
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127) return true; // this-host / loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
  }
  return false;
}
