import { http } from './http';

export interface UserView {
  id: string;
  email: string;
  name: string;
  title: string | null;
  status: string;
  roles: string[];
  mustChangePassword: boolean;
  /** ISO timestamp; a value in the future means the account is locked out. */
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AdminResetMode = 'temp' | 'email';

export interface AdminResetResult {
  mode: AdminResetMode;
  temporaryPassword?: string;
  emailed?: boolean;
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

/** Admin lock (credential lockout) — distinct from disable (status). */
export async function setUserLock(id: string, lock: boolean): Promise<UserView> {
  const { data } = await http.post<UserView>(`/users/${id}/${lock ? 'lock' : 'unlock'}`);
  return data;
}

/** Admin password reset: `temp` returns a one-time password; `email` sends a link. */
export async function adminResetPassword(
  id: string,
  mode: AdminResetMode,
): Promise<AdminResetResult> {
  const { data } = await http.post<AdminResetResult>(`/users/${id}/reset-password`, { mode });
  return data;
}

/** True when the user is currently locked out of sign-in. */
export function isLocked(user: Pick<UserView, 'lockedUntil'>): boolean {
  return !!user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now();
}
