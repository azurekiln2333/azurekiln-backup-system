export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

let csrfToken = '';
export function setCsrfToken(token?: string) { csrfToken = token ?? ''; }

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal,
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error?.message ?? `请求失败 (${response.status})`, response.status, data?.error?.code);
  return data as T;
}

export const write = <T>(path: string, body?: unknown, method = 'POST') => api<T>(path, { method, body });
export async function uploadArchive<T>(path: string, file: File, password: string): Promise<T> {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(password)));
  const response = await fetch(`/api${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrfToken, 'X-Archive-Password-Base64': encoded },
    body: file,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error?.message ?? `请求失败 (${response.status})`, response.status, data?.error?.code);
  return data as T;
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败';
