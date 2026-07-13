import JSZip from 'jszip';
import type { UploadedFile } from '../documents/documents.service';
import { prepareBulkImportFiles } from './zip-import';

const file = (name: string, content = name, mimetype = 'application/pdf'): UploadedFile => ({
  originalname: name,
  mimetype,
  size: Buffer.byteLength(content),
  buffer: Buffer.from(content),
});

async function zipFile(entries: Record<string, string>): Promise<UploadedFile> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return {
    originalname: 'clinic-policies.zip',
    mimetype: 'application/zip',
    size: buffer.length,
    buffer,
  };
}

describe('prepareBulkImportFiles', () => {
  it('extracts supported ZIP entries and maps folders to category paths', async () => {
    const prepared = await prepareBulkImportFiles([
      await zipFile({
        'Policies/Clinical/Seclusion Policy.pdf': '%PDF-1.4',
        'Job Descriptions/RN.docx': 'docx',
      }),
    ]);

    expect(prepared.items).toHaveLength(2);
    const seclusion = prepared.items.find(
      (item) => item.displayPath === 'Policies/Clinical/Seclusion Policy.pdf',
    );
    const rn = prepared.items.find((item) => item.displayPath === 'Job Descriptions/RN.docx');
    expect(seclusion).toMatchObject({
      kind: 'file',
      title: 'Seclusion Policy',
      categoryPath: 'Policies/Clinical',
      displayPath: 'Policies/Clinical/Seclusion Policy.pdf',
    });
    expect(seclusion?.kind === 'file' ? seclusion.file.originalname : null).toBe(
      'Seclusion Policy.pdf',
    );
    expect(rn).toMatchObject({
      kind: 'file',
      title: 'RN',
      categoryPath: 'Job Descriptions',
      displayPath: 'Job Descriptions/RN.docx',
    });
  });

  it('ignores hidden and macOS metadata entries inside ZIP archives', async () => {
    const prepared = await prepareBulkImportFiles([
      await zipFile({
        '__MACOSX/._policy.pdf': 'metadata',
        '.DS_Store': 'metadata',
        'Policies/.hidden.pdf': 'hidden',
        'Policies/Visible.pdf': '%PDF-1.4',
      }),
    ]);

    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]).toMatchObject({ kind: 'file', displayPath: 'Policies/Visible.pdf' });
  });

  it('records an error for unsafe ZIP entry paths instead of importing them', async () => {
    const zip = new JSZip();
    zip.file('../escape.pdf', '%PDF-1.4');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const prepared = await prepareBulkImportFiles([
      {
        originalname: 'unsafe.zip',
        mimetype: 'application/zip',
        size: buffer.length,
        buffer,
      },
    ]);

    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]).toMatchObject({
      kind: 'error',
      fileName: '../escape.pdf',
      message: expect.stringMatching(/unsafe ZIP entry path/i),
    });
  });

  it('records an error for unsupported ZIP entry types', async () => {
    const prepared = await prepareBulkImportFiles([
      await zipFile({ 'Policies/run-me.exe': 'nope' }),
    ]);

    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]).toMatchObject({
      kind: 'error',
      fileName: 'run-me.exe',
      categoryPath: 'Policies',
      message: expect.stringMatching(/unsupported file type/i),
    });
  });

  it('rejects ZIP archives that expand beyond the 200 item cap', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 201; i += 1) {
      entries[`Policies/file-${i}.txt`] = `content-${i}`;
    }

    await expect(prepareBulkImportFiles([await zipFile(entries)])).rejects.toThrow(
      /maximum is 200/i,
    );
  });

  it('maps browser folder relative paths to category paths for direct files', async () => {
    const prepared = await prepareBulkImportFiles(
      [file('Treatment Plan.pdf')],
      ['Policies/Clinical/Treatment Plan.pdf'],
    );

    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]).toMatchObject({
      kind: 'file',
      title: 'Treatment Plan',
      categoryPath: 'Policies/Clinical',
      displayPath: 'Policies/Clinical/Treatment Plan.pdf',
    });
  });
});
