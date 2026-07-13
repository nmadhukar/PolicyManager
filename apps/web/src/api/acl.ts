import type { AclGrant, AclPermission, AclPrincipalType } from '@policymanager/shared';
import { http } from './http';

export type { AclGrant } from '@policymanager/shared';

/** Body for granting a role or user a capability on a document. */
export interface AddAclInput {
  principalType: AclPrincipalType;
  principalId: string;
  permission: AclPermission;
}

export async function listAcl(documentId: string): Promise<AclGrant[]> {
  const { data } = await http.get<AclGrant[]>(`/documents/${documentId}/acl`);
  return data;
}

export async function addAcl(documentId: string, input: AddAclInput): Promise<AclGrant> {
  const { data } = await http.post<AclGrant>(`/documents/${documentId}/acl`, input);
  return data;
}

export async function removeAcl(documentId: string, aclId: string): Promise<void> {
  await http.delete(`/documents/${documentId}/acl/${aclId}`);
}
