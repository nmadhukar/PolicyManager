import type { DocumentCategoryNode } from '@policymanager/shared';
import { http } from './http';

export type { DocumentCategoryNode } from '@policymanager/shared';

export interface CreateCategoryInput {
  name: string;
  parentId?: string;
  description?: string;
}

export async function listCategoryTree(): Promise<DocumentCategoryNode[]> {
  const { data } = await http.get<DocumentCategoryNode[]>('/document-categories');
  return data;
}

export async function createCategory(input: CreateCategoryInput): Promise<DocumentCategoryNode> {
  const { data } = await http.post<DocumentCategoryNode>('/document-categories', input);
  return data;
}

/** Flattened category option with a depth for indented rendering in selects. */
export interface FlatCategory {
  id: string;
  name: string;
  depth: number;
}

/** Depth-first flatten of the category tree for use in <select> controls. */
export function flattenCategories(nodes: DocumentCategoryNode[], depth = 0): FlatCategory[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth },
    ...flattenCategories(node.children, depth + 1),
  ]);
}
