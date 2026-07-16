import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type ApproveDocumentInput,
  type ApproveDocumentResult,
  type AuthUser,
  type DocumentStatus,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { DocumentAccessService, type AccessDocument } from '../documents/document-access.service';
import { AttestationService } from './attestation.service';
import { AcknowledgmentService } from './acknowledgment.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmbeddingService } from '../rag/embedding.service';

/**
 * Document approval / publish sign-off (PM-0602). Approving records an immutable
 * `Attestation(action=approved)` against the current version, sets the document to
 * `approved` (or `published` when `publish=true`), and — on publish — re-triggers
 * acknowledgment for the current version so staff must re-read a newly published
 * revision (AGENTS.md §10b). Gated by `document.approve` (controller) PLUS the
 * per-document access check (confidential ACL).
 */
@Injectable()
export class DocumentApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: DocumentAccessService,
    private readonly attestation: AttestationService,
    private readonly acknowledgment: AcknowledgmentService,
    private readonly notifications?: NotificationsService,
    // Optional (like notifications): when RAG is wired in, publishing ensures the
    // current version is embedded so it's retrievable. Best-effort, non-blocking.
    private readonly embedding?: EmbeddingService,
  ) {}

  /** Fire-and-forget embedding of a version after publish. No-op without RAG. */
  private triggerEmbedding(versionId: string): void {
    if (!this.embedding) return;
    void this.embedding.embedVersion(versionId).catch(() => {
      // Swallowed: the EmbeddingService has its own poller/retry; a publish must
      // never fail because embedding did.
    });
  }

  async approve(
    documentId: string,
    input: ApproveDocumentInput,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<ApproveDocumentResult> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, ownerId: true, accessLevel: true, categoryId: true, currentVersionId: true },
    });
    if (!doc) throw new NotFoundException('Document not found');

    await this.enforceApprove(user, doc, ctx);

    if (!doc.currentVersionId) {
      throw new BadRequestException('Upload a version before approving this document');
    }

    const alreadyApproved = await this.prisma.attestation.findFirst({
      where: {
        documentId,
        versionId: doc.currentVersionId,
        userId: user.id,
        action: 'approved',
      },
      select: { id: true },
    });
    if (alreadyApproved) {
      throw new BadRequestException('You have already approved this document version');
    }

    const status: DocumentStatus = input.publish ? 'published' : 'approved';

    // C6/D4: the state change and its immutable sign-off commit ATOMICALLY — an
    // `approved` status is never persisted without its evidence, nor vice versa.
    const attestation = await this.prisma.$transaction(async (tx) => {
      const att = await this.attestation.record(
        {
          documentId,
          versionId: doc.currentVersionId,
          action: 'approved',
          signatureName: input.signatureName?.trim() || user.name,
          signatureRole: input.signatureRole,
          comments: input.comments,
        },
        user,
        ctx,
        tx,
      );
      await tx.document.update({ where: { id: documentId }, data: { status } });
      return att;
    });

    // Audit + acknowledgment re-trigger happen AFTER commit (out of the critical path).
    await this.audit.record({
      action: AUDIT_ACTIONS.DOCUMENT_APPROVED,
      actorUserId: user.id,
      documentId,
      versionId: doc.currentVersionId,
      targetType: 'document',
      ...ctx,
      metadata: { status, published: !!input.publish, attestationId: attestation.id },
    });

    let acknowledgmentsRetriggered = 0;
    if (input.publish) {
      await this.audit.record({
        action: AUDIT_ACTIONS.DOCUMENT_PUBLISHED,
        actorUserId: user.id,
        documentId,
        versionId: doc.currentVersionId,
        targetType: 'document',
        ...ctx,
        metadata: { versionId: doc.currentVersionId },
      });
      // Re-open acknowledgment for the (possibly new) current version.
      acknowledgmentsRetriggered = await this.acknowledgment.retriggerForVersion(
        documentId,
        doc.currentVersionId,
        user,
        ctx,
      );
      await this.notifications?.notifyPolicyPublished(documentId, doc.currentVersionId, user);
      // Ensure the now-published current version is embedded so the RAG chatbot
      // can retrieve it. Idempotent (skips if already `done`) and best-effort —
      // a failure here never affects the publish result.
      this.triggerEmbedding(doc.currentVersionId);
    }

    return { documentId, status, attestation, acknowledgmentsRetriggered };
  }

  /** Access check for approve + access.denied audit on denial (403). */
  private async enforceApprove(
    user: AuthUser,
    doc: AccessDocument,
    ctx: RequestContext,
  ): Promise<void> {
    if (await this.access.canAccess(user, doc, 'approve')) return;
    await this.audit.record({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      actorUserId: user.id,
      documentId: doc.id,
      targetType: 'document',
      ...ctx,
      metadata: { attemptedAction: 'approve', accessLevel: doc.accessLevel },
    });
    throw new ForbiddenException('You do not have access to approve this document');
  }
}
