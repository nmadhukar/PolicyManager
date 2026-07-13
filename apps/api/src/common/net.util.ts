/**
 * Small network-safety helpers shared by server-to-server integrations such as
 * OnlyOffice save-callback downloads.
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
 * True when `host` is a loopback, link-local, or RFC-1918 private address, or a
 * loopback alias like `localhost` / `host.docker.internal`.
 *
 * Use this for network-safety checks such as rejecting SSRF targets that are not
 * explicitly allow-listed. S3 local-credential defaults use a narrower
 * local-host-only check in `S3Service`.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true; // Empty host is not routable; treat as unsafe/local.
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'host.docker.internal') return true;
  // IPv6 loopback / unspecified / unique-local / link-local.
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127) return true; // This-host / loopback.
    if (a === 10) return true; // 10.0.0.0/8.
    if (a === 169 && b === 254) return true; // Link-local / cloud metadata.
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12.
    if (a === 192 && b === 168) return true; // 192.168.0.0/16.
  }
  return false;
}
