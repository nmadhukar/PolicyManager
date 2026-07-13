import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Document, Page, pdfjs } from 'react-pdf';
import { getViewUrl } from '../api/documents';
import { ErrorState, LoadingState } from './states';
import { useFocusTrap } from './useFocusTrap';

// Load the pdf.js worker from the bundled pdfjs-dist (versions are deduped with
// react-pdf, so the API + worker match). Vite resolves this URL at build time.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

/**
 * Read-only in-browser document viewer (AGENTS.md §10a). Renders the version's
 * PDF rendition (or a source PDF/image) from a short-lived presigned URL. There
 * is NO editing affordance here — view-only users only ever see this.
 */
export function DocumentViewer({
  documentId,
  version,
  onClose,
}: {
  documentId: string;
  version: { id: string; fileName: string };
  onClose: () => void;
}) {
  const [numPages, setNumPages] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus management + Escape-to-close (AGENTS.md §10c).
  useFocusTrap(true, dialogRef, onClose);

  const ticketQuery = useQuery({
    queryKey: ['view-url', documentId, version.id],
    queryFn: () => getViewUrl(documentId, version.id),
    // Presigned URLs are short-lived; don't cache stale ones.
    staleTime: 0,
    gcTime: 0,
  });
  const status = (ticketQuery.error as AxiosError | null)?.response?.status;

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 focus:outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${version.fileName}`}
      onMouseDown={onClose}
    >
      <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900 px-5 py-3 text-white">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{version.fileName}</div>
          <div className="text-xs text-slate-400">Read-only preview</div>
        </div>
        <button
          className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div
        className="flex-1 overflow-auto p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {ticketQuery.isLoading && (
          <div className="mx-auto max-w-3xl">
            <LoadingState label="Preparing preview…" />
          </div>
        )}
        {status === 404 && (
          <div className="mx-auto max-w-3xl">
            <ErrorState
              title="No preview available"
              description="This version has no viewable rendition yet. Download the original, or regenerate the rendition from the version list."
            />
          </div>
        )}
        {ticketQuery.isError && status !== 404 && (
          <div className="mx-auto max-w-3xl">
            <ErrorState
              description="We couldn't load the preview."
              onRetry={() => void ticketQuery.refetch()}
            />
          </div>
        )}
        {ticketQuery.data &&
          (ticketQuery.data.mimeType.startsWith('image/') ? (
            <img
              src={ticketQuery.data.url}
              alt={version.fileName}
              className="mx-auto max-w-full rounded bg-white shadow"
            />
          ) : (
            <Document
              file={ticketQuery.data.url}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              loading={
                <div className="mx-auto max-w-3xl">
                  <LoadingState label="Rendering document…" />
                </div>
              }
              error={
                <div className="mx-auto max-w-3xl">
                  <ErrorState description="This document could not be rendered." />
                </div>
              }
              className="flex flex-col items-center gap-4"
            >
              {Array.from({ length: numPages }, (_, i) => (
                <Page
                  key={i}
                  pageNumber={i + 1}
                  width={Math.min(900, window.innerWidth - 48)}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="rounded bg-white shadow"
                />
              ))}
            </Document>
          ))}
      </div>
    </div>
  );
}

export default DocumentViewer;
