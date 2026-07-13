export interface SelectedImportFiles {
  files: File[];
  relativePaths: string[];
}

interface BrowserFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface BrowserFileSystemFileEntry extends BrowserFileSystemEntry {
  isFile: true;
  file(success: (file: File) => void, failure?: (error: DOMException) => void): void;
}

interface BrowserFileSystemDirectoryEntry extends BrowserFileSystemEntry {
  isDirectory: true;
  createReader(): BrowserFileSystemDirectoryReader;
}

interface BrowserFileSystemDirectoryReader {
  readEntries(
    success: (entries: BrowserFileSystemEntry[]) => void,
    failure?: (error: DOMException) => void,
  ): void;
}

interface CollectedFile {
  file: File;
  relativePath: string;
}

/**
 * Collects files from a browser drop event. Chromium exposes dropped folders via
 * `webkitGetAsEntry`; other browsers fall back to the normal flat file list.
 */
export async function collectDroppedImportFiles(
  dataTransfer: DataTransfer,
): Promise<SelectedImportFiles> {
  const itemEntries = Array.from(dataTransfer.items ?? [])
    .map(getEntry)
    .filter((entry): entry is BrowserFileSystemEntry => entry !== null);

  const collected =
    itemEntries.length > 0
      ? (await Promise.all(itemEntries.map((entry) => collectEntry(entry)))).flat()
      : Array.from(dataTransfer.files ?? []).map((file) => ({
          file,
          relativePath: relativePathForFile(file),
        }));

  return {
    files: collected.map((item) => item.file),
    relativePaths: collected.map((item) => item.relativePath),
  };
}

export function relativePathForFile(file: File): string {
  return (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

async function collectEntry(
  entry: BrowserFileSystemEntry,
  parentPath = '',
): Promise<CollectedFile[]> {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readFileEntry(entry as BrowserFileSystemFileEntry);
    return [{ file, relativePath: path }];
  }
  if (entry.isDirectory) {
    const children = await readDirectoryEntries(entry as BrowserFileSystemDirectoryEntry);
    const nested = await Promise.all(children.map((child) => collectEntry(child, path)));
    return nested.flat();
  }
  return [];
}

function getEntry(item: DataTransferItem): BrowserFileSystemEntry | null {
  const withEntry = item as unknown as {
    webkitGetAsEntry?: () => BrowserFileSystemEntry | null;
  };
  return withEntry.webkitGetAsEntry?.() ?? null;
}

function readFileEntry(entry: BrowserFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectoryEntries(
  entry: BrowserFileSystemDirectoryEntry,
): Promise<BrowserFileSystemEntry[]> {
  const reader = entry.createReader();
  const out: BrowserFileSystemEntry[] = [];
  for (;;) {
    const chunk = await new Promise<BrowserFileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (chunk.length === 0) return out;
    out.push(...chunk);
  }
}
