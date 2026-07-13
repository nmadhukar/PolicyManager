import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  PERMISSIONS,
  ROLES,
  type AuthUser,
  type DocumentAnnotationItem,
  type DocumentAnnotationListResponse,
} from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../audit/request-context';
import { DocumentAccessService, type AccessDocument } from './document-access.service';
import type { CreateAnnotationDto } from './dto/create-annotation.dto';

const annotationInclude = {
  author: { select: { name: true } },
  resolvedBy: { select: { name: true } },
} satisfies Prisma.DocumentAnnotationInclude;

type AnnotationRow = Prisma.DocumentAnnotationGetPayload<{ include: typeof annotationInclude }>;

/**
 * Review annotations for immutable versions.
 *
 * Comments are internal review artifacts only: every route enforces document
 * view access, create/state changes require comment rights or reviewer
 * assignment, and no public API/cover-page/export path reads this model.
 */
@Injectable()
export class DocumentAnnotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(
    documentId: string,
    versionId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentAnnotationListResponse> {
    const version = await this.loadVersion(documentId, versionId);
    await this.enforceView(user, version.document, ctx, versionId);
    const rows = await this.prisma.documentAnnotation.findMany({
      where: { documentId, versionId, deletedAt: null },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      include: annotationInclude,
    });
    return {
      items: rows.map(toItem),
      canAnnotate: await this.canComment(user, documentId),
      canComplianceDelete: this.hasComplianceDelete(user),
    };
  }

  async create(
    documentId: string,
    versionId: string,
    dto: CreateAnnotationDto,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentAnnotationItem> {
    const version = await this.loadVersion(documentId, versionId);
    await this.enforceCanComment(user, version.document, ctx, versionId);
    assertRect(dto);

    const row = await this.prisma.documentAnnotation.create({
      data: {
        documentId,
        versionId,
        authorId: user.id,
        type: dto.type ?? 'comment',
        pageNumber: dto.pageNumber,
        x: dto.x,
        y: dto.y,
        width: dto.width,
        height: dto.height,
        body: dto.body.trim(),
      },
      include: annotationInclude,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.ANNOTATION_CREATED,
      actorUserId: user.id,
      documentId,
      versionId,
      targetType: 'annotation',
      ...ctx,
      metadata: { annotationId: row.id, type: row.type, pageNumber: row.pageNumber },
    });
    return toItem(row);
  }

  async resolve(
    documentId: string,
    versionId: string,
    annotationId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentAnnotationItem> {
    const row = await this.loadAnnotation(documentId, versionId, annotationId);
    await this.enforceCanModerate(user, row.document, row.authorId, ctx, versionId);
    const updated = await this.prisma.documentAnnotation.update({
      where: { id: annotationId },
      data: { status: 'resolved', resolvedAt: new Date(), resolvedById: user.id },
      include: annotationInclude,
    });
    await this.auditState(AUDIT_ACTIONS.ANNOTATION_RESOLVED, updated, user, ctx);
    return toItem(updated);
  }

  async reopen(
    documentId: string,
    versionId: string,
    annotationId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<DocumentAnnotationItem> {
    const row = await this.loadAnnotation(documentId, versionId, annotationId);
    await this.enforceCanModerate(user, row.document, row.authorId, ctx, versionId);
    const updated = await this.prisma.documentAnnotation.update({
      where: { id: annotationId },
      data: { status: 'open', resolvedAt: null, resolvedById: null },
      include: annotationInclude,
    });
    await this.auditState(AUDIT_ACTIONS.ANNOTATION_REOPENED, updated, user, ctx);
    return toItem(updated);
  }

  async softDelete(
    documentId: string,
    versionId: string,
    annotationId: string,
    user: AuthUser,
    ctx: RequestContext = {},
  ): Promise<void> {
    const row = await this.loadAnnotation(documentId, versionId, annotationId);
    await this.enforceCanDelete(user, row, ctx, versionId);
    const updated = await this.prisma.documentAnnotation.update({
      where: { id: annotationId },
      data: { deletedAt: new Date() },
      include: annotationInclude,
    });
    await this.auditState(AUDIT_ACTIONS.ANNOTATION_DELETED, updated, user, ctx);
  }

  async countOpenForVersion(documentId: string, versionId: string): Promise<number> {
    return this.prisma.documentAnnotation.count({
      where: { documentId, versionId, status: 'open', deletedAt: null },
    });
  }

  private async loadVersion(documentId: string, versionId: string): Promise<{
    id: string;
    document: AccessDocument;
  }> {
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId, document: { deletedAt: null } },
      select: {
        id: true,
        document: {
          select: { id: true, ownerId: true, accessLevel: true, categoryId: true },
        },
      },
    });
    if (!version) throw new NotFoundException('Version not found');
    return version;
  }

  private async loadAnnotation(
    documentId: string,
    versionId: string,
    annotationId: string,
  ): Promise<AnnotationRow & { document: AccessDocument }> {
    const row = await this.prisma.documentAnnotation.findFirst({
      where: { id: annotationId, documentId, versionId, deletedAt: null },
      include: {
        ...annotationInclude,
        document: { select: { id: true, ownerId: true, accessLevel: true, categoryId: true } },
      },
    });
    if (!row) throw new NotFoundException('Annotation not found');
    return row;
  }

  private async enforceView(
    user: AuthUser,
    doc: AccessDocument,
    ctx: RequestContext,
    versionId: string,
  ): Promise<void> {
    if (await this.access.canAccess(user, doc, 'view')) return;
    await this.audit.record({
      action: AUDIT_ACTIONS.ACCESS_DENIED,
      actorUserId: user.id,
      documentId: doc.id,
      versionId,
      targetType: 'annotation',
      ...ctx,
      metadata: { attemptedAction: 'annotation.view', accessLevel: doc.accessLevel },
    });
    throw new ForbiddenException('You do not have access to this document');
  }

  private async enforceCanComment(
    user: AuthUser,
    doc: AccessDocument,
    ctx: RequestContext,
    versionId: string,
  ): Promise<void> {
    await this.enforceView(user, doc, ctx, versionId);
    if (await this.canComment(user, doc.id)) return;
    throw new ForbiddenException('You do not have permission to annotate this document');
  }

  private async enforceCanModerate(
    user: AuthUser,
    doc: AccessDocument,
    authorId: string,
    ctx: RequestContext,
    versionId: string,
  ): Promise<void> {
    await this.enforceView(user, doc, ctx, versionId);
    if (authorId === user.id || (await this.canComment(user, doc.id))) return;
    throw new ForbiddenException('You do not have permission to update this annotation');
  }

  private async enforceCanDelete(
    user: AuthUser,
    row: AnnotationRow & { document: AccessDocument },
    ctx: RequestContext,
    versionId: string,
  ): Promise<void> {
    await this.enforceView(user, row.document, ctx, versionId);
    if (row.authorId === user.id || this.hasComplianceDelete(user)) return;
    throw new ForbiddenException('Only the author or compliance staff can delete annotations');
  }

  private hasComplianceDelete(user: AuthUser): boolean {
    return user.roles.includes(ROLES.ADMIN) || user.roles.includes(ROLES.COMPLIANCE_OFFICER);
  }

  private async canComment(user: AuthUser, documentId: string): Promise<boolean> {
    if (user.permissions.includes(PERMISSIONS.DOCUMENT_COMMENT)) return true;
    const assigned = await this.prisma.reviewAssignment.count({
      where: { documentId, reviewerId: user.id },
    });
    if (assigned > 0) return true;
    const task = await this.prisma.reviewTask.count({
      where: { documentId, assignedToId: user.id, status: { in: ['pending', 'in_progress', 'overdue'] } },
    });
    return task > 0;
  }

  private async auditState(
    action: string,
    row: AnnotationRow,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<void> {
    await this.audit.record({
      action,
      actorUserId: user.id,
      documentId: row.documentId,
      versionId: row.versionId,
      targetType: 'annotation',
      ...ctx,
      metadata: { annotationId: row.id, status: row.status },
    });
  }
}

function assertRect(dto: CreateAnnotationDto): void {
  if (dto.x + dto.width > 1 || dto.y + dto.height > 1) {
    throw new BadRequestException('Annotation rectangle must stay within the page.');
  }
  if (dto.body.trim().length === 0) {
    throw new BadRequestException('Annotation text is required.');
  }
}

function toItem(row: AnnotationRow): DocumentAnnotationItem {
  return {
    id: row.id,
    documentId: row.documentId,
    versionId: row.versionId,
    authorId: row.authorId,
    authorName: row.author?.name ?? null,
    type: row.type as DocumentAnnotationItem['type'],
    status: row.status as DocumentAnnotationItem['status'],
    pageNumber: row.pageNumber,
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedByName: row.resolvedBy?.name ?? null,
  };
}
