import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnlyOfficeEditor } from './OnlyOfficeEditor';

const mockGetEditorConfig = vi.fn();
vi.mock('../api/documents', () => ({
  getEditorConfig: (...a: unknown[]) => mockGetEditorConfig(...a),
}));

/**
 * FINDING-016: OnlyOfficeEditor's mount effect depends on [configQuery.data,
 * onClose]. If the parent passes a new `onClose` closure on every render (the
 * pre-fix DocumentDetailPage.closeOfficeEditor did, since it closed over `doc`),
 * this effect re-runs — destroying the live DocsAPI editor session and creating a
 * new one, discarding whatever the user was mid-edit on. A stable `onClose`
 * (DocumentDetailPage now uses useCallback with no changing deps) must not
 * trigger this.
 */
describe('OnlyOfficeEditor', () => {
  let destroyEditor: ReturnType<typeof vi.fn>;
  let createCount: number;

  beforeEach(() => {
    mockGetEditorConfig.mockReset();
    mockGetEditorConfig.mockResolvedValue({ document: { key: 'k1' } });
    destroyEditor = vi.fn();
    createCount = 0;
    window.DocsAPI = {
      DocEditor: vi.fn().mockImplementation(() => {
        createCount += 1;
        return { destroyEditor };
      }),
    };
  });

  afterEach(() => {
    delete (window as { DocsAPI?: unknown }).DocsAPI;
  });

  function renderEditor(onClose: () => void) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <OnlyOfficeEditor documentId="doc-1" onClose={onClose} />
      </QueryClientProvider>,
    );
  }

  it('does not destroy/recreate the live editor session when onClose keeps the same identity across a re-render', async () => {
    const stableOnClose = () => undefined;
    const { rerender } = renderEditor(stableOnClose);
    await waitFor(() => expect(createCount).toBe(1));

    // Re-render with the identical onClose reference (mirrors the fixed
    // DocumentDetailPage: closeOfficeEditor is useCallback'd with no deps that
    // change when the parent's `doc` is replaced by an unrelated refetch).
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OnlyOfficeEditor documentId="doc-1" onClose={stableOnClose} />
      </QueryClientProvider>,
    );

    // Give effects a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(destroyEditor).not.toHaveBeenCalled();
    expect(createCount).toBe(1);
  });

  it('destroys and recreates the editor session when onClose is a NEW closure each render (the pre-fix bug)', async () => {
    const { rerender } = renderEditor(() => undefined);
    await waitFor(() => expect(createCount).toBe(1));

    // A fresh arrow function every render, exactly like the pre-fix
    // closeOfficeEditor that closed over `doc` inline.
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OnlyOfficeEditor documentId="doc-1" onClose={() => undefined} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(destroyEditor).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createCount).toBe(2));
  });
});
