import { http } from './http';

export interface UserView {
  id: string;
  email: string;
  name: string;
  title: string | null;
  status: string;
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

export interface CreatedUser {
  user: UserView;
  temporaryPassword: string;
}

export interface CreateUserInput {
  email: string;
  name: string;
  title?: string;
  roles?: string[];
}

export async function listUsers(): Promise<UserView[]> {
  const { data } = await http.get<UserView[]>('/users');
  return data;
}

export async function listRoles(): Promise<RoleView[]> {
  const { data } = await http.get<RoleView[]>('/roles');
  return data;
}

export async function createUser(input: CreateUserInput): Promise<CreatedUser> {
  const { data } = await http.post<CreatedUser>('/users', input);
  return data;
}

export async function assignRoles(id: string, roles: string[]): Promise<UserView> {
  const { data } = await http.post<UserView>(`/users/${id}/roles`, { roles });
  return data;
}

export async function setUserStatus(id: string, enable: boolean): Promise<UserView> {
  const { data } = await http.post<UserView>(`/users/${id}/${enable ? 'enable' : 'disable'}`);
  return data;
}
