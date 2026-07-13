import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  type ApiClientItem,
  type ApiClientSecret,
  type ApiScope,
  type AuthUser,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import type { AuthenticatedApiClient } from './api-client.types';
import type { CreateApiClientDto } from './dto/create-api-client.dto';
import type { UpdateApiClientDto } from './dto/update-api-client.dto';
import {
  buildCredential,
  generateClientId,
  generateSecret,
  hashSecret,
  parseCredential,
  verifySecret,
} from './api-key.util';

/** Read shape for the management views — deliberately EXCLUDES `secretHash`. */
const apiClientSelect = {
  id: true,
  name: true,
  clientId: true,
  scopes: true,
  allowedCategoryIds: true,
  enabled: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdBy: { select: { name: true } },
} satisfies Prisma.ApiClientSelect;

type ApiClientRow = Prisma.ApiClientGetPayload<{ select: typeof apiClientSelect }>;

/**
 * Manages public API clients (AGENTS.md §8 — Phase 7). Create/rotate mint a
 * high-entropy secret, return it EXACTLY ONCE, and persist only its Argon2 hash.
 * {@link authenticate} is the read path used by {@link ApiKeyGuard}. Lifecycle
 * changes are audited.
 */
@Injectable()
export class ApiClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a client, returning the plaintext secret + ready-to-use credential
   * ONCE. Only the Argon2 hash is stored; the caller must copy the secret now.
   */
  async create(
    dto: CreateApiClientDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ApiClientSecret> {
    const clientId = generateClientId();
    const secret = generateSecret();
    const secretHash = await hashSecret(secret);

    const row = await this.prisma.apiClient.create({
      data: {
        name: dto.name,
        clientId,
        secretHash,
        scopes: dto.scopes,
        allowedCategoryIds: dto.allowedCategoryIds ?? [],
        createdById: user.id,
      },
      select: apiClientSelect,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.API_CLIENT_CREATED,
      actorUserId: user.id,
      targetType: 'api_client',
      ...ctx,
      metadata: { apiClientId: row.id, name: dto.name, scopes: dto.scopes },
    });

    return { client: this.toItem(row), secret, credential: buildCredential(clientId, secret) };
  }

  /** Lists all clients (never the secret hash), newest first. */
  async list(): Promise<ApiClientItem[]> {
    const rows = await this.prisma.apiClient.findMany({
      orderBy: { createdAt: 'desc' },
      select: apiClientSelect,
    });
    return rows.map((r) => this.toItem(r));
  }

  /** Updates scopes / category allow-list / enabled flag. Audited. */
  async update(
    id: string,
    dto: UpdateApiClientDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ApiClientItem> {
    await this.ensureExists(id);
    const data: Prisma.ApiClientUpdateInput = {};
    if (dto.scopes !== undefined) data.scopes = dto.scopes;
    if (dto.allowedCategoryIds !== undefined) data.allowedCategoryIds = dto.allowedCategoryIds;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;

    const row = await this.prisma.apiClient.update({
      where: { id },
      data,
      select: apiClientSelect,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.API_CLIENT_UPDATED,
      actorUserId: user.id,
      targetType: 'api_client',
      ...ctx,
      metadata: { apiClientId: id, fields: Object.keys(data) },
    });
    return this.toItem(row);
  }

  /**
   * Revokes a client: stamps `revokedAt` and disables it so every subsequent API
   * call fails auth. Idempotent — re-revoking a revoked client is a no-op change.
   */
  async revoke(id: string, user: AuthUser, ctx: RequestContext = {}): Promise<ApiClientItem> {
    await this.ensureExists(id);
    const row = await this.prisma.apiClient.update({
      where: { id },
      data: { revokedAt: new Date(), enabled: false },
      select: apiClientSelect,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.API_CLIENT_REVOKED,
      actorUserId: user.id,
      targetType: 'api_client',
      ...ctx,
      metadata: { apiClientId: id },
    });
    return this.toItem(row);
  }

  /**
   * Rotates the secret in place (same `clientId`), returning the new plaintext
   * ONCE. The previous secret stops working immediately. Does NOT change the
   * enabled/revoked state.
   */
  async rotateSecret(
    id: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ApiClientSecret> {
    await this.ensureExists(id);
    const secret = generateSecret();
    const secretHash = await hashSecret(secret);
    const row = await this.prisma.apiClient.update({
      where: { id },
      data: { secretHash },
      select: apiClientSelect,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.API_CLIENT_ROTATED,
      actorUserId: user.id,
      targetType: 'api_client',
      ...ctx,
      metadata: { apiClientId: id },
    });
    return {
      client: this.toItem(row),
      secret,
      credential: buildCredential(row.clientId, secret),
    };
  }

  /**
   * Authenticates a raw `clientId.secret` credential for the guard. Returns the
   * authenticated client on success, or null for ANY failure (unknown id, wrong
   * secret, disabled, or revoked) — the guard maps null to 401. On success it
   * best-effort bumps `lastUsedAt`. Constant-shape: it always performs the Argon2
   * verification when a row exists so timing does not leak the failure reason.
   */
  async authenticate(raw: string | undefined | null): Promise<AuthenticatedApiClient | null> {
    const parsed = parseCredential(raw);
    if (!parsed) return null;

    const client = await this.prisma.apiClient.findUnique({
      where: { clientId: parsed.clientId },
      select: {
        id: true,
        name: true,
        secretHash: true,
        scopes: true,
        allowedCategoryIds: true,
        enabled: true,
        revokedAt: true,
      },
    });
    if (!client) return null;

    const ok = await verifySecret(client.secretHash, parsed.secret);
    if (!ok) return null;
    if (!client.enabled || client.revokedAt) return null;

    // Best-effort usage stamp — an update failure must not deny a valid client.
    try {
      await this.prisma.apiClient.update({
        where: { id: client.id },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      /* non-fatal */
    }

    return {
      id: client.id,
      name: client.name,
      scopes: client.scopes as ApiScope[],
      allowedCategoryIds: client.allowedCategoryIds,
    };
  }

  /** 404s when a client id does not exist (used before update/revoke/rotate). */
  private async ensureExists(id: string): Promise<void> {
    const found = await this.prisma.apiClient.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('API client not found');
  }

  private toItem(row: ApiClientRow): ApiClientItem {
    return {
      id: row.id,
      name: row.name,
      clientId: row.clientId,
      scopes: row.scopes as ApiScope[],
      allowedCategoryIds: row.allowedCategoryIds,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdBy?.name ?? null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    };
  }
}
