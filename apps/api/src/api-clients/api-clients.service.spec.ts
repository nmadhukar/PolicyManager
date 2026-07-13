import type { AuthUser } from '@policymanager/shared';
import { ApiClientsService } from './api-clients.service';
import { verifySecret } from './api-key.util';

/**
 * Business-behavior tests for the API client manager (AGENTS.md §8):
 *  - create/rotate return the secret ONCE and store only an Argon2 hash,
 *  - list never leaks the hash,
 *  - lifecycle changes are audited,
 *  - authenticate() accepts a valid key and rejects unknown/wrong/disabled/revoked,
 *    bumping lastUsedAt only on success.
 */
describe('ApiClientsService', () => {
  const user: AuthUser = {
    id: 'admin-1',
    email: 'a@x.com',
    name: 'Admin',
    roles: ['Admin'],
    permissions: ['api.manage'],
    mustChangePassword: false,
  };

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ac-1',
    name: 'EMR',
    clientId: 'pmk_abc',
    scopes: ['documents:read'],
    allowedCategoryIds: [],
    enabled: true,
    createdAt: new Date('2026-07-10T00:00:00Z'),
    lastUsedAt: null,
    revokedAt: null,
    createdBy: { name: 'Admin' },
    ...over,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePrisma = (): any => ({
    apiClient: {
      // Echo the inserted clientId (as a real DB does) so the returned client
      // matches the credential the service builds from the generated id.
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(row({ clientId: data.clientId, name: data.name, scopes: data.scopes })),
      ),
      findMany: jest.fn().mockResolvedValue([row()]),
      findUnique: jest.fn().mockResolvedValue(row()),
      update: jest.fn().mockResolvedValue(row()),
    },
  });
  const makeAudit = () => ({ record: jest.fn().mockResolvedValue('ae-1') });

  const build = (prisma = makePrisma(), audit = makeAudit()) => ({
    prisma,
    audit,
    svc: new ApiClientsService(prisma as never, audit as never),
  });

  describe('create', () => {
    it('mints a secret ONCE, stores only its Argon2 hash, and audits', async () => {
      const { svc, prisma, audit } = build();
      const result = await svc.create({ name: 'EMR', scopes: ['documents:read'] }, user, {
        ipAddress: '10.0.0.1',
      });

      // Secret + credential returned to the caller exactly once.
      expect(result.secret).toBeTruthy();
      expect(result.credential).toBe(`${result.client.clientId}.${result.secret}`);

      // What is persisted is an Argon2 hash — never the plaintext secret.
      const created = prisma.apiClient.create.mock.calls[0][0];
      const storedHash = created.data.secretHash as string;
      expect(storedHash).not.toContain(result.secret);
      expect(storedHash.startsWith('$argon2')).toBe(true);
      expect(await verifySecret(storedHash, result.secret)).toBe(true);
      expect(created.data.createdById).toBe('admin-1');

      // Audited, and the plaintext secret is NOT anywhere in the audit payload.
      const auditArg = audit.record.mock.calls[0][0];
      expect(auditArg.action).toBe('api_client.created');
      expect(auditArg.actorUserId).toBe('admin-1');
      expect(JSON.stringify(auditArg)).not.toContain(result.secret);
    });

    it('returned client item carries no secretHash', async () => {
      const { svc } = build();
      const result = await svc.create({ name: 'EMR', scopes: ['documents:read'] }, user);
      expect((result.client as unknown as Record<string, unknown>).secretHash).toBeUndefined();
    });
  });

  describe('list', () => {
    it('selects without the secret hash and maps to items', async () => {
      const { svc, prisma } = build();
      const items = await svc.list();
      expect(items).toHaveLength(1);
      expect((items[0] as unknown as Record<string, unknown>).secretHash).toBeUndefined();
      // The Prisma select must not include secretHash.
      const select = prisma.apiClient.findMany.mock.calls[0][0].select;
      expect(select.secretHash).toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('stamps revokedAt + disables and audits', async () => {
      const prisma = makePrisma();
      prisma.apiClient.update.mockResolvedValue(row({ enabled: false, revokedAt: new Date() }));
      const { svc, audit } = build(prisma);
      const item = await svc.revoke('ac-1', user);
      const data = prisma.apiClient.update.mock.calls[0][0].data;
      expect(data.enabled).toBe(false);
      expect(data.revokedAt).toBeInstanceOf(Date);
      expect(item.enabled).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api_client.revoked', actorUserId: 'admin-1' }),
      );
    });

    it('404s an unknown id', async () => {
      const prisma = makePrisma();
      prisma.apiClient.findUnique.mockResolvedValue(null);
      const { svc } = build(prisma);
      await expect(svc.revoke('nope', user)).rejects.toThrow('API client not found');
    });
  });

  describe('rotateSecret', () => {
    it('returns a new secret ONCE, updates the hash, and audits', async () => {
      const { svc, prisma, audit } = build();
      const result = await svc.rotateSecret('ac-1', user);
      expect(result.secret).toBeTruthy();
      const data = prisma.apiClient.update.mock.calls[0][0].data;
      expect(data.secretHash.startsWith('$argon2')).toBe(true);
      expect(await verifySecret(data.secretHash, result.secret)).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api_client.rotated' }),
      );
    });
  });

  describe('update', () => {
    it('applies scopes/categories/enabled and audits', async () => {
      const { svc, prisma, audit } = build();
      await svc.update('ac-1', { scopes: ['documents:read', 'download'], enabled: false }, user);
      const data = prisma.apiClient.update.mock.calls[0][0].data;
      expect(data.scopes).toEqual(['documents:read', 'download']);
      expect(data.enabled).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'api_client.updated' }),
      );
    });
  });

  describe('authenticate', () => {
    /** Builds a prisma whose stored hash matches `secret`, with row overrides. */
    const withSecret = async (secret: string, over: Record<string, unknown> = {}) => {
      const { hashSecret } = await import('./api-key.util');
      const secretHash = await hashSecret(secret);
      const prisma = makePrisma();
      prisma.apiClient.findUnique.mockResolvedValue({
        id: 'ac-1',
        name: 'EMR',
        secretHash,
        scopes: ['documents:read'],
        allowedCategoryIds: [],
        enabled: true,
        revokedAt: null,
        ...over,
      });
      return prisma;
    };

    it('accepts a valid credential and bumps lastUsedAt', async () => {
      const prisma = await withSecret('s3cr3t');
      const { svc } = build(prisma);
      const client = await svc.authenticate('pmk_abc.s3cr3t');
      expect(client).toMatchObject({ id: 'ac-1', name: 'EMR', scopes: ['documents:read'] });
      // lastUsedAt update issued.
      expect(prisma.apiClient.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ac-1' } }),
      );
      expect(prisma.apiClient.update.mock.calls[0][0].data.lastUsedAt).toBeInstanceOf(Date);
    });

    it('rejects a malformed credential without hitting the DB', async () => {
      const prisma = makePrisma();
      const { svc } = build(prisma);
      expect(await svc.authenticate('no-dot')).toBeNull();
      expect(prisma.apiClient.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown clientId', async () => {
      const prisma = makePrisma();
      prisma.apiClient.findUnique.mockResolvedValue(null);
      const { svc } = build(prisma);
      expect(await svc.authenticate('pmk_missing.secret')).toBeNull();
    });

    it('rejects a wrong secret (no lastUsedAt bump)', async () => {
      const prisma = await withSecret('right-secret');
      const { svc } = build(prisma);
      expect(await svc.authenticate('pmk_abc.wrong-secret')).toBeNull();
      expect(prisma.apiClient.update).not.toHaveBeenCalled();
    });

    it('rejects a disabled client even with the right secret', async () => {
      const prisma = await withSecret('s3cr3t', { enabled: false });
      const { svc } = build(prisma);
      expect(await svc.authenticate('pmk_abc.s3cr3t')).toBeNull();
      expect(prisma.apiClient.update).not.toHaveBeenCalled();
    });

    it('rejects a revoked client even with the right secret', async () => {
      const prisma = await withSecret('s3cr3t', { revokedAt: new Date() });
      const { svc } = build(prisma);
      expect(await svc.authenticate('pmk_abc.s3cr3t')).toBeNull();
    });
  });
});
