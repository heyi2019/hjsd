import { api } from "./client";
import type { EmployeeOption, ManagedUser, Team } from "./types";

export const employeesApi = {
  list: () => api.get<EmployeeOption[]>("/users/options").then((r) => r.data),
};

export const usersApi = {
  list: () => api.get<ManagedUser[]>("/users").then((r) => r.data),
  create: (payload: Record<string, unknown>) => api.post<ManagedUser>("/users", payload).then((r) => r.data),
  update: (id: number, payload: Record<string, unknown>) => api.patch<ManagedUser>(`/users/${id}`, payload).then((r) => r.data),
  resetPassword: (id: number, password: string) =>
    api.post<{ ok: boolean }>(`/users/${id}/reset-password`, { password }).then((r) => r.data),
};

export const teamsApi = {
  list: () => api.get<Team[]>("/teams").then((r) => r.data),
  create: (payload: Record<string, unknown>) => api.post<Team>("/teams", payload).then((r) => r.data),
  update: (id: number, payload: Record<string, unknown>) => api.patch<Team>(`/teams/${id}`, payload).then((r) => r.data),
};
