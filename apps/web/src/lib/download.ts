/**
 * Triggers a browser download for a URL using a hidden anchor. Preferred over
 * `window.open` for links fetched *after* an async step (e.g. a presigned URL
 * from a mutation): popup blockers only allow `window.open` synchronously inside
 * a user gesture, so a post-await `window.open` is silently blocked.
 */
export function triggerUrlDownload(url: string, fileName?: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (fileName) a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Triggers a browser download for an in-memory Blob (revokes the URL after). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke a little later so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
