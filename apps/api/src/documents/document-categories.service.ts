import { BadRequestException, Injectable } from '@nestjs/common';
import type { DocumentCategoryNode } from '@policymanager/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateCategoryDto } from './dto/create-category.dto';

interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
}

@Injectable()
export class DocumentCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the category forest (root nodes with nested children). */
  async tree(): Promise<DocumentCategoryNode[]> {
    const rows = await this.prisma.documentCategory.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, parentId: true, description: true },
    });
    return buildCategoryTree(rows);
  }

  /** Creates a category, validating the parent exists when nesting. */
  async create(dto: CreateCategoryDto): Promise<DocumentCategoryNode> {
    if (dto.parentId) {
      const parent = await this.prisma.documentCategory.findUnique({
        where: { id: dto.parentId },
        select: { id: true },
      });
      if (!parent) throw new BadRequestException('Unknown parentId');
    }
    const created = await this.prisma.documentCategory.create({
      data: { name: dto.name, parentId: dto.parentId, description: dto.description },
      select: { id: true, name: true, parentId: true, description: true },
    });
    return { ...created, children: [] };
  }
}

/**
 * Assembles a flat category list into a tree. Pure/exported for unit testing.
 * Orphans (parent not present in the set) are surfaced as roots so nothing is
 * silently dropped.
 */
export function buildCategoryTree(rows: CategoryRow[]): DocumentCategoryNode[] {
  const byId = new Map<string, DocumentCategoryNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });

  const roots: DocumentCategoryNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
