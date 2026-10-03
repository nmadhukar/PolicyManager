import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
export interface McpFile { fileName: string; mimeType: string; contentBase64: string }

/** Check encoded size BEFORE decoding: base64 can otherwise allocate attacker-controlled buffers. */
export function buildMultipart(mode: 'version' | 'manifest' | 'bulk', files: Record<string, any>, body: Record<string, any>, maxBytes = MAX_FILE_BYTES): FormData {
  const pending: { field: string; file: McpFile }[] = [];
  const add = (field: string, file: McpFile) => {
    if (!file || typeof file !== 'object' || Object.keys(file).some((key) => !['fileName', 'mimeType', 'contentBase64'].includes(key))) throw new BadRequestException('Invalid MCP file object');
    if (typeof file.fileName !== 'string' || !file.fileName || file.fileName.length > 255 || /[\/\\\x00-\x1f]/.test(file.fileName)) throw new BadRequestException('File name must be a filename, not a path');
    if (typeof file.mimeType !== 'string' || !file.mimeType || file.mimeType.length > 150 || /[\r\n]/.test(file.mimeType)) throw new BadRequestException('Invalid MIME type');
    const encoded = file.contentBase64;
    const padding = typeof encoded === 'string' ? (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) : 0;
    // Use linear character checks: a repeated-group regex can exhaust the JS
    // regexp stack on a valid 50 MiB upload before the size guard is reached.
    if (typeof encoded !== 'string' || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) || (encoded.includes('=') && encoded.indexOf('=') !== encoded.length - padding)) throw new BadRequestException('File content must be standard padded base64');
    pending.push({ field, file });
  };
  if (mode === 'version') add('file', files.file);
  else {
    if (mode === 'manifest') add('manifest', files.manifest);
    if (!Array.isArray(files.files ?? []) || (files.files?.length ?? 0) > 200) throw new BadRequestException('At most 200 import files are supported');
    for (const file of files.files ?? []) add('files', file);
  }
  let total = 0;
  for (const { file } of pending) {
    const size = file.contentBase64.length / 4 * 3 - (file.contentBase64.endsWith('==') ? 2 : file.contentBase64.endsWith('=') ? 1 : 0);
    total += size;
    if (size > MAX_FILE_BYTES || total > Math.min(maxBytes, MAX_FILE_BYTES)) throw new PayloadTooLargeException('MCP decoded file limit exceeded; split the batch');
  }
  const form = new FormData();
  for (const { field, file } of pending) {
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.toString('base64') !== file.contentBase64) throw new BadRequestException('Noncanonical base64 file content');
    form.append(field, new Blob([new Uint8Array(bytes)], { type: file.mimeType }), file.fileName);
  }
  for (const [key, value] of Object.entries(body)) {
    form.append(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  return form;
}
