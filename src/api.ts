export interface ApiErrorBody {
  error?: { code?: string; what?: string; why?: string; fix?: string };
}

export class ApiError extends Error {
  readonly code: string;
  readonly why: string;
  readonly fix: string;

  constructor(body: ApiErrorBody, status: number) {
    super(body.error?.what ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.code = body.error?.code ?? "HTTP";
    this.why = body.error?.why ?? `The server returned ${status}.`;
    this.fix = body.error?.fix ?? "Retry, or run `atelier doctor`.";
  }
}

export async function ensureAuth(): Promise<void> {
  await fetch("/api/auth", { credentials: "same-origin" });
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const csrf = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("atelier_csrf="));
  if (csrf !== undefined) headers.set("x-atelier-csrf", decodeURIComponent(csrf.slice("atelier_csrf=".length)));
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = {};
    }
    throw new ApiError(body, response.status);
  }
  return (await response.json()) as T;
}
