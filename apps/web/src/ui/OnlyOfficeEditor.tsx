import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { getEditorConfig } from '../api/documents';
import { ErrorState, LoadingState } from './states';
import { useFocusTrap } from './useFocusTrap';

interface DocEditorInstance {
  destroyEditor: () => void;
}
interface DocsAPIType {
  DocEditor: new (id: string, config: Record<string, unknown>) => DocEditorInstance;
}
declare global {
  interface Window {
    DocsAPI?: DocsAPIType;
  }
}

const ONLYOFFICE_URL = import.meta.env.VITE_ONLYOFFICE_URL ?? 'http://localhost:8080';

let scriptPromise: Promise<void> | null = null;

/** Loads the DocsAPI script once (idempotent) from the Docs server. */
function loadDocsApi(): Promise<void> {
  if (window.DocsAPI) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${ONLYOFFICE_URL.replace(/\/$/, '')}/web-apps/apps/api/documents/api.js`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Failed to load the OnlyOffice editor'));
    };
    document.body.appendChild(script);
  });
  return scriptPromise;
}

/**
 * Mounts the self-hosted OnlyOffice editor for a document's current version
 * (docx/xlsx/pptx). The signed config comes from the API; save-backs are handled
 * server-side by the editor callback, which writes a NEW immutable version
 * (AGENTS.md §10a). Requires `document.write` — the API enforces it.
 *
 * On close the parent refreshes version history so a just-saved version appears.
 */
export function OnlyOfficeEditor({
  documentId,
  onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const containerId = useRef(`onlyoffice-${Math.random().toString(36).slice(2)}`);
  const editorRef = useRef<DocEditorInstance | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [scriptError, setScriptError] = useState(false);

  // Focus management for the overlay (AGENTS.md §10c). The embedded editor owns
  // focus once loaded; this moves focus in on open and restores it on close.
  useFocusTrap(true, dialogRef, onClose);

  const configQuery = useQuery({
    queryKey: ['editor-config', documentId],
    queryFn: () => getEditorConfig(documentId),
    staleTime: 0,
    gcTime: 0,
  });
  const status = (configQuery.error as AxiosError | null)?.response?.status;

  useEffect(() => {
    if (!configQuery.data) return;
    let cancelled = false;
    loadDocsApi()
      .then(() => {
        if (cancelled || !window.DocsAPI) return;
        editorRef.current = new window.DocsAPI.DocEditor(containerId.current, {
          ...configQuery.data,
          type: 'desktop',
          width: '100%',
          height: '100%',
          events: {
            // Docs server asks the host to close (e.g. the user clicked ×).
            onRequestClose: onClose,
            onError: () => undefined,
          },
        });
      })
      .catch(() => setScriptError(true));
    return () => {
      cancelled = true;
      try {
        editorRef.current?.destroyEditor();
      } catch {
        /* editor may already be torn down */
      }
      editorRef.current = null;
    };
  }, [configQuery.data, onClose]);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 focus:outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="Editing document"
    >
      <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900 px-5 py-3 text-white">
        <div className="text-sm font-medium">Editing document</div>
        <button
          className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600"
          onClick={onClose}
        >
          Done
        </button>
      </div>
      <div className="relative flex-1 bg-white">
        {configQuery.isLoading && <LoadingState label="Opening editor…" />}
        {status === 400 && (
          <div className="p-6">
            <ErrorState
              title="Not editable here"
              description="This document type can't be edited in OnlyOffice. Use download, or a text document instead."
            />
          </div>
        )}
        {(scriptError || (configQuery.isError && status !== 400)) && (
          <div className="p-6">
            <ErrorState
              description="We couldn't open the editor. Check that the OnlyOffice service is reachable."
              onRetry={() => void configQuery.refetch()}
            />
          </div>
        )}
        {/* The Docs server renders into this element. */}
        <div id={containerId.current} className="absolute inset-0" />
      </div>
    </div>
  );
}

export default OnlyOfficeEditor;
