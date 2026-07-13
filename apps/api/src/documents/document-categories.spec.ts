import { BadRequestException } from '@nestjs/common';
import { DocumentCategoriesService, buildCategoryTree } from './document-categories.service';

describe('buildCategoryTree', () => {
  it('nests children under their parents', () => {
    const tree = buildCategoryTree([
      { id: 'root', name: 'Policies', parentId: null, description: null },
      { id: 'child', name: 'Clinical', parentId: 'root', description: null },
      { id: 'grand', name: 'Intake', parentId: 'child', description: null },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('root');
    expect(tree[0].children[0].id).toBe('child');
    expect(tree[0].children[0].children[0].id).toBe('grand');
  });

  it('returns multiple roots and empty children arrays', () => {
    const tree = buildCategoryTree([
      { id: 'a', name: 'A', parentId: null, description: null },
      { id: 'b', name: 'B', parentId: null, description: 'desc' },
    ]);
    expect(tree.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(tree.every((n) => Array.isArray(n.children) && n.children.length === 0)).toBe(true);
  });

  it('treats orphaned nodes (missing parent) as roots so none are dropped', () => {
    const tree = buildCategoryTree([
      { id: 'orphan', name: 'Orphan', parentId: 'gone', description: null },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('orphan');
  });
});

describe('DocumentCategoriesService', () => {
  const makePrisma = () => ({
    documentCategory: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  });
  const build = (p = makePrisma()) => ({ prisma: p, svc: new DocumentCategoriesService(p as never) });

  it('tree() assembles the forest from the flat rows', async () => {
    const { svc, prisma } = build();
    prisma.documentCategory.findMany.mockResolvedValue([
      { id: 'r', name: 'Root', parentId: null, description: null },
      { id: 'c', name: 'Child', parentId: 'r', description: null },
    ]);
    const tree = await svc.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].id).toBe('c');
  });

  it('create() rejects an unknown parentId with 400', async () => {
    const { svc, prisma } = build();
    prisma.documentCategory.findUnique.mockResolvedValue(null);
    await expect(
      svc.create({ name: 'Nested', parentId: 'ghost' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.documentCategory.create).not.toHaveBeenCalled();
  });

  it('create() returns the new node with an empty children array', async () => {
    const { svc, prisma } = build();
    prisma.documentCategory.create.mockResolvedValue({
      id: 'new',
      name: 'Forms',
      parentId: null,
      description: null,
    });
    const node = await svc.create({ name: 'Forms' });
    expect(node).toEqual({ id: 'new', name: 'Forms', parentId: null, description: null, children: [] });
  });
});
