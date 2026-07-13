import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  type AttestationAction,
  type AttestationItem,
  type AuthUser,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';

/** Everything needed to record one immutable attestation. */
export interface RecordAttestationInput {
  documentId: string;
  /** Nullable only for a `reviewed` sign-off on a file-less document. */
  versionId?: string | null;
  action: AttestationAction;
  signatureName: string;
  signatureRole?: string | null;
  comments?: string | null;
  reviewTaskId?: string | null;
  acknowledgmentAssignmentId?: string | null;
}

/** Fields + joins needed to project an {@link AttestationItem}. */
const attestationInclude = {
  user: { select: { name: true } },
  version: { select: { versionNumber: true } },
} satisfies Prisma.AttestationInclude;

type AttestationWithJoins = Prisma.AttestationGetPayload<{ include: typeof attestationInclude }>;

/** Maps an attestation action to its audit action string. */
const ATTESTATION_AUDIT_ACTION: Record<AttestationAction, string> = {
  reviewed: AUDIT_ACTIONS.ATTESTATION_REVIEWED,
  approved: AUDIT_ACTIONS.ATTESTATION_APPROVED,
  acknowledged: AUDIT_ACTIONS.ATTESTATION_ACKNOWLEDGED,
};

/**
 * Immutable compliance sign-off store (AGENTS.md §8/§10b). This service is the
 * ONLY writer of {@link Attestation} rows and deliberately exposes NO update or
 * delete surface — a correction is a new record, never a mutation. It captures the
 * signer, the exact version, the typed signature (name + role), and the network
 * context (IP + user-agent) at sign time, and writes an `attestation.*` audit
 * event for every sign-off.
 */
@Injectable()
export class AttestationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records one immutable attestation and audits it. IP + user-agent are taken
   * from the request context so the row is self-contained survey evidence. The
   * write is inside the request path (unlike audit) because losing a sign-off is
   * not acceptable — callers must await it.
   */
  async record(
    input: RecordAttestationInput,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<AttestationItem> {
    const created = await this.prisma.attestation.create({
      data: {
        documentId: input.documentId,
        versionId: input.versionId ?? undefined,
        reviewTaskId: input.reviewTaskId ?? undefined,
        acknowledgmentAssignmentId: input.acknowledgmentAssignmentId ?? undefined,
        userId: user.id,
        action: input.action,
        signatureName: input.signatureName,
        signatureRole: input.signatureRole ?? undefined,
        comments: input.comments ?? undefined,
        ipAddress: ctx.ipAddress ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      },
      include: attestationInclude,
    });

    await this.audit.record({
      action: ATTESTATION_AUDIT_ACTION[input.action],
      actorUserId: user.id,
      documentId: input.documentId,
      versionId: input.versionId ?? undefined,
      targetType: 'attestation',
      ...ctx,
      metadata: {
        attestationId: created.id,
        action: input.action,
        signatureName: input.signatureName,
      },
    });

    return AttestationService.toItem(created);
  }

  /**
   * The document's approval chain (reviewed + approved sign-offs), newest first —
   * the evidence rendered on the detail panel and cover page. Acknowledgments are
   * intentionally excluded here (they have their own distribution views).
   */
  async listApprovalChain(documentId: string): Promise<AttestationItem[]> {
    const rows = await this.prisma.attestation.findMany({
      where: { documentId, action: { in: ['reviewed', 'approved'] } },
      include: attestationInclude,
      orderBy: { signedAt: 'desc' },
    });
    return rows.map((r) => AttestationService.toItem(r));
  }

  /** Projects a joined attestation row onto the shared {@link AttestationItem}. */
  static toItem(row: AttestationWithJoins): AttestationItem {
    return {
      id: row.id,
      documentId: row.documentId,
      versionId: row.versionId,
      versionNumber: row.version?.versionNumber ?? null,
      reviewTaskId: row.reviewTaskId,
      acknowledgmentAssignmentId: row.acknowledgmentAssignmentId,
      userId: row.userId,
      userName: row.user?.name ?? null,
      action: row.action as AttestationAction,
      signatureName: row.signatureName,
      signatureRole: row.signatureRole,
      comments: row.comments,
      ipAddress: row.ipAddress,
      signedAt: row.signedAt.toISOString(),
    };
  }
}
