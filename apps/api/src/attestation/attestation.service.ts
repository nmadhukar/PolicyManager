import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { DocumentAccessService } from '../documents/document-access.service';

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
    private readonly access: DocumentAccessService,
  ) {}

  /**
   * Records one immutable attestation and audits it. IP + user-agent are taken
   * from the request context so the row is self-contained survey evidence. The
   * write is inside the request path (unlike audit) because losing a sign-off is
   * not acceptable — callers must await it.
   *
   * `tx` lets a caller enlist the sign-off in its OWN transaction so the state
   * change (approve/complete/acknowledge) and its immutable evidence commit
   * atomically — never one without the other (C6/D4). The `attestation.*` audit is
   * best-effort as always.
   */
  async record(
    input: RecordAttestationInput,
    user: AuthUser,
    ctx: RequestContext = {},
    tx?: Prisma.TransactionClient,
  ): Promise<AttestationItem> {
    const client = tx ?? this.prisma;
    let created: AttestationWithJoins;
    try {
      created = await client.attestation.create({
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
    } catch (err) {
      // Last-resort guard against a race between two near-simultaneous
      // sign-offs (callers already check-before-create; this only fires when
      // both requests pass that check before either commits).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException(`You have already ${input.action} this document version`);
      }
      throw err;
    }

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

  /**
   * Access-enforced approval chain for the HTTP surface (SH1). The raw
   * {@link listApprovalChain} leaks a confidential document's reviewers/approvers
   * to any `document.read` holder; this loads the (non-deleted) document, clears the
   * same VIEW gate as the rest of the document surface (owner/Admin/ACL for
   * confidential), audits a denial, and only then returns the chain.
   */
  async listApprovalChainForDocument(
    documentId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<AttestationItem[]> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, ownerId: true, accessLevel: true, categoryId: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (!(await this.access.canAccess(user, doc, 'view'))) {
      await this.audit.record({
        action: AUDIT_ACTIONS.ACCESS_DENIED,
        actorUserId: user.id,
        documentId,
        targetType: 'document',
        ...ctx,
        metadata: { attemptedAction: 'view', accessLevel: doc.accessLevel, artifact: 'approval-chain' },
      });
      throw new ForbiddenException('You do not have access to this document');
    }
    return this.listApprovalChain(documentId);
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
