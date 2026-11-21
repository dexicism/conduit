import type {
  ExecutionDetail,
  ExecutionSummary,
  ApiErrorBody,
  CreateWorkflowInput,
  ListFilter,
  Page,
  UpdateWorkflowInput,
  WorkflowDetail,
  WorkflowSummary,
} from "@conduit/core";
import type { AppInfo, CredentialView } from "./app-info";

export class ClientApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
    });
  } catch {
    throw new ClientApiError(0, { error: "internal_error", message: "Network error. Check your connection and try again." });
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      // Session expired mid-use: a full reload intentionally drops all client state before signing in again.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ClientApiError(res.status, data ?? { error: "internal_error", message: `Request failed (${res.status})` });
  }
  return data as T;
}

export const api = {
  listWorkflows: (p: { q?: string; filter: ListFilter; cursor?: string; limit?: number }) => {
    const sp = new URLSearchParams({ filter: p.filter, limit: String(p.limit ?? 20) });
    if (p.q) sp.set("q", p.q);
    if (p.cursor) sp.set("cursor", p.cursor);
    return request<Page<WorkflowSummary>>(`/api/workflows?${sp}`);
  },
  createWorkflow: (input: CreateWorkflowInput) =>
    request<WorkflowDetail>("/api/workflows", { method: "POST", body: JSON.stringify(input) }),
  updateWorkflow: (id: string, input: UpdateWorkflowInput) =>
    request<WorkflowDetail>(`/api/workflows/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  duplicateWorkflow: (id: string) => request<WorkflowDetail>(`/api/workflows/${id}/duplicate`, { method: "POST" }),
  deleteWorkflow: (id: string) => request<void>(`/api/workflows/${id}`, { method: "DELETE" }),
  listExecutions: (p: { workflowId?: string; status?: string; cursor?: string }) => {
    const sp = new URLSearchParams({ limit: "25" });
    if (p.workflowId) sp.set("workflowId", p.workflowId);
    if (p.status) sp.set("status", p.status);
    if (p.cursor) sp.set("cursor", p.cursor);
    return request<Page<ExecutionSummary>>(`/api/executions?${sp}`);
  },
  getExecution: (id: string) => request<ExecutionDetail>(`/api/executions/${id}`),
  cancelExecution: (id: string) => request<ExecutionSummary>(`/api/executions/${id}/cancel`, { method: "POST" }),
  retryExecution: (id: string) => request<{ executionId: string }>(`/api/executions/${id}/retry`, { method: "POST" }),
  listCredentials: (app?: string) =>
    request<{ credentials: CredentialView[]; apps: AppInfo[] }>(`/api/credentials${app ? `?app=${encodeURIComponent(app)}` : ""}`),
  getCredential: (id: string) =>
    request<CredentialView & { usage: { workflows: Array<{ id: string; name: string }>; published: Array<{ id: string; name: string }> } }>(
      `/api/credentials/${id}`,
    ),
  createCredential: (input: { app: string; label: string; values: Record<string, string> }) =>
    request<CredentialView>("/api/credentials", { method: "POST", body: JSON.stringify(input) }),
  renameCredential: (id: string, label: string) => request<CredentialView>(`/api/credentials/${id}`, { method: "PATCH", body: JSON.stringify({ label }) }),
  deleteCredential: (id: string, force = false) => request<void>(`/api/credentials/${id}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  testCredential: (id: string) => request<CredentialView>(`/api/credentials/${id}/test`, { method: "POST" }),
  fieldOptions: (input: { source: string; credentialId: string; params: Record<string, unknown> }) =>
    request<{ options: Array<{ value: string; label: string }> }>("/api/nodes/options", { method: "POST", body: JSON.stringify(input) }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ClientApiError) return err.body.message;
  return "Something went wrong. Please try again.";
}
