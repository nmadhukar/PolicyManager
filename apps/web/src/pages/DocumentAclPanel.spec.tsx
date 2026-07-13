import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import type { AclGrant, DocumentDetail } from '@policymanager/shared';
import { DocumentAclPanel } from './DocumentAclPanel';
import * as aclApi from '../api/acl';
import * as usersApi from '../api/users';
import * as documentsApi from '../api/documents';

function doc(over: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    id: 'doc-1',
    title: 'Seclusion Policy',
    documentNumber: 'PP-42',
    categoryId: null,
    categoryName: null,
    ownerId: 'u1',
    ownerName: 'Owner',
    status: 'published',
    accessLevel: 'restricted',
    tags: [],
    reviewCadence: 'none',
    nextReviewDate: null,
    effectiveDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    description: null,
    currentVersion: null,
    versions: [],
    ...over,
  };
}

function grant(over: Partial<AclGrant> = {}): AclGrant {
  return {
    id: 'acl-1',
    documentId: 'doc-1',
    categoryId: null,
    principalType: 'user',
    principalId: 'u2',
    principalName: 'Jane Staff',
    permission: 'view',
    createdAt: '2026-01-02T00:00:00.000Z',
    createdByName: 'Admin',
    ...over,
  };
}

function renderPanel(d: DocumentDetail) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DocumentAclPanel doc={d} />
    </QueryClientProvider>,
  );
}

describe('DocumentAclPanel', () => {
  beforeEach(() => {
    vi.spyOn(usersApi, 'listRoles').mockResolvedValue([
      { id: 'r1', name: 'Managers', description: null, isSystem: true },
    ]);
    vi.spyOn(usersApi, 'listUsers').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists existing grants with principal name and permission', async () => {
    vi.spyOn(aclApi, 'listAcl').mockResolvedValue([grant()]);
    renderPanel(doc());
    await waitFor(() => expect(screen.getByText('Jane Staff')).toBeInTheDocument());
    expect(screen.getByText(/· view/)).toBeInTheDocument();
  });

  it('explains confidential semantics when the level is confidential', async () => {
    vi.spyOn(aclApi, 'listAcl').mockResolvedValue([]);
    renderPanel(doc({ accessLevel: 'confidential' }));
    await waitFor(() =>
      expect(screen.getByText(/document.read\s+alone is not enough/i)).toBeInTheDocument(),
    );
  });

  it('adds a grant via the form (role picker + permission)', async () => {
    vi.spyOn(aclApi, 'listAcl').mockResolvedValue([]);
    const addSpy = vi.spyOn(aclApi, 'addAcl').mockResolvedValue(grant({ principalType: 'role' }));
    renderPanel(doc());

    // Role picker becomes available once listRoles resolves.
    await waitFor(() => expect(screen.getByLabelText('Role')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText('Permission'), { target: { value: 'download' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add grant' }));

    await waitFor(() =>
      expect(addSpy).toHaveBeenCalledWith('doc-1', {
        principalType: 'role',
        principalId: 'r1',
        permission: 'download',
      }),
    );
  });

  it('removes a grant', async () => {
    vi.spyOn(aclApi, 'listAcl').mockResolvedValue([grant()]);
    const removeSpy = vi.spyOn(aclApi, 'removeAcl').mockResolvedValue();
    renderPanel(doc());
    await waitFor(() => expect(screen.getByText('Jane Staff')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Remove grant' }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('doc-1', 'acl-1'));
  });

  it('changes the access level through the select', async () => {
    vi.spyOn(aclApi, 'listAcl').mockResolvedValue([]);
    const updateSpy = vi
      .spyOn(documentsApi, 'updateDocument')
      .mockResolvedValue(doc({ accessLevel: 'confidential' }));
    renderPanel(doc());

    await waitFor(() => expect(screen.getByLabelText('Access level')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Access level'), { target: { value: 'confidential' } });
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith('doc-1', { accessLevel: 'confidential' }),
    );
  });
});
