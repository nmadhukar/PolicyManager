import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    try {
      const created = await this.prisma.documentCategory.create({
        data: { name: dto.name, parentId: dto.parentId, description: dto.description },
        select: { id: true, name: true, parentId: true, description: true },
      });
      return { ...created, children: [] };
    } catch (err) {
      // D12/C10: a sibling category with this name already exists (unique on
      // (name, parentId) + the root partial unique). Surface a clean 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A category with that name already exists here');
      }
      throw err;
    }
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
