const BASE = "";

const APP_API_KEY: string =
  (import.meta as Record<string, Record<string, string>>).env?.VITE_APP_API_KEY ?? "";

const BACKEND_UNREACHABLE =
  "Backend server unreachable. Start the backend with: python backend/app.py (port 5120)";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (APP_API_KEY) {
    headers["Authorization"] = `Bearer ${APP_API_KEY}`;
  }
  return headers;
}

function isConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /failed to fetch/i.test(msg) ||
    /network error/i.test(msg) ||
    /connection refused/i.test(msg) ||
    /ECONNREFUSED/i.test(msg)
  );
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string")
        ? (data as { error: string }).error
        : response.status === 502 || response.status === 503
          ? BACKEND_UNREACHABLE
          : response.statusText || "Request failed";
    throw new ApiError(message, response.status);
  }
  return data as T;
}

async function fetchWithConnectionError<T>(
  fn: () => Promise<Response>
): Promise<T> {
  try {
    const response = await fn();
    return parseResponse<T>(response);
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(BACKEND_UNREACHABLE);
    }
    throw err;
  }
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return fetchWithConnectionError<T>(() =>
    fetch(`${BASE}${url.pathname}${url.search}`, {
      method: "GET",
      headers: authHeaders(),
    })
  );
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return fetchWithConnectionError<T>(() =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
  );
}

export async function apiDelete<T>(path: string): Promise<T> {
  return fetchWithConnectionError<T>(() =>
    fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: authHeaders(),
    })
  );
}

/** Normalize API errors for display (e.g. connection refused → backend unreachable). */
export function normalizeApiError(err: unknown): string {
  if (isConnectionError(err)) return BACKEND_UNREACHABLE;
  return err instanceof Error ? err.message : "Request failed";
}
