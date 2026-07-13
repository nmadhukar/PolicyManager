import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { getVersionHtml, saveHtmlVersion } from '../api/documents';
import { LoadingState } from './states';

/**
 * In-app rich-text (TipTap) authoring for native HTML documents (AGENTS.md §10a).
 * A save stores the HTML as a NEW immutable version (mime text/html) and the
 * server generates a PDF rendition — save == new version, never an overwrite.
 * Requires `document.write` (enforced by the API).
 */
export function TipTapEditor({
  documentId,
  version,
  onSaved,
  onClose,
}: {
  documentId: string;
  /** Existing HTML version to edit, or undefined to author a fresh document. */
  version?: { id: string; fileName: string };
  onSaved: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const initial = useQuery({
    queryKey: ['version-html', documentId, version?.id],
    queryFn: () => getVersionHtml(documentId, version!.id),
    enabled: !!version,
  });

  const editor = useEditor({
    extensions: [StarterKit],
    content: '<p></p>',
    editorProps: {
      attributes: {
        class: 'prose max-w-none min-h-[45vh] focus:outline-none',
        'aria-label': 'Document body',
      },
    },
  });

  // Load existing HTML into the editor once it (and the content) are ready.
  useEffect(() => {
    if (editor && initial.data?.html) {
      editor.commands.setContent(initial.data.html);
    }
  }, [editor, initial.data]);

  const save = useMutation({
    mutationFn: () => saveHtmlVersion(documentId, editor?.getHTML() ?? '', 'Edited text document'),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: () => setError('Could not save. Please try again.'),
  });

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Text document editor"
      onMouseDown={onClose}
    >
      <div
        className="card flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden p-0"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-ink">
            {version ? 'Edit text document' : 'New text document'}
          </h2>
          <button className="text-sm text-ink-muted hover:text-ink" onClick={onClose}>
            Cancel
          </button>
        </div>

        {version && initial.isLoading ? (
          <div className="p-6">
            <LoadingState label="Loading document…" />
          </div>
        ) : (
          <>
            <Toolbar editor={editor} />
            <div className="flex-1 overflow-auto px-5 py-4">
              <EditorContent editor={editor} />
            </div>
          </>
        )}

        {error && (
          <p className="px-5 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button className="btn-secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || !editor}
          >
            {save.isPending ? 'Saving…' : 'Save version'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Minimal, accessible formatting toolbar. */
function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  const btn = (active: boolean) =>
    `rounded px-2 py-1 text-sm font-medium ${
      active ? 'bg-brand-100 text-brand-700' : 'text-ink-soft hover:bg-slate-100'
    }`;

  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-4 py-2"
      role="toolbar"
      aria-label="Formatting"
    >
      <button
        type="button"
        className={btn(editor.isActive('bold'))}
        aria-label="Bold"
        aria-pressed={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </button>
      <button
        type="button"
        className={`italic ${btn(editor.isActive('italic'))}`}
        aria-label="Italic"
        aria-pressed={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </button>
      <span className="mx-1 h-5 w-px bg-slate-300" aria-hidden />
      <button
        type="button"
        className={btn(editor.isActive('heading', { level: 1 }))}
        aria-label="Heading 1"
        aria-pressed={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </button>
      <button
        type="button"
        className={btn(editor.isActive('heading', { level: 2 }))}
        aria-label="Heading 2"
        aria-pressed={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </button>
      <span className="mx-1 h-5 w-px bg-slate-300" aria-hidden />
      <button
        type="button"
        className={btn(editor.isActive('bulletList'))}
        aria-label="Bulleted list"
        aria-pressed={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        • List
      </button>
      <button
        type="button"
        className={btn(editor.isActive('orderedList'))}
        aria-label="Numbered list"
        aria-pressed={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1. List
      </button>
      <span className="mx-1 h-5 w-px bg-slate-300" aria-hidden />
      <button
        type="button"
        className={btn(false)}
        aria-label="Undo"
        onClick={() => editor.chain().focus().undo().run()}
      >
        ↶
      </button>
      <button
        type="button"
        className={btn(false)}
        aria-label="Redo"
        onClick={() => editor.chain().focus().redo().run()}
      >
        ↷
      </button>
    </div>
  );
}

export default TipTapEditor;
