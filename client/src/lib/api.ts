export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(value: string | null): void {
  csrfToken = value;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  csrf?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const needsCsrf = method !== "GET" && (options.csrf ?? true);
  if (needsCsrf && csrfToken) headers["x-csrf-token"] = csrfToken;

  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (data && typeof data === "object" && "csrfToken" in data) {
    const value = (data as { csrfToken?: unknown }).csrfToken;
    if (typeof value === "string") setCsrfToken(value);
  }

  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `요청이 실패했습니다 (${response.status})`,
      error?.details,
    );
  }

  return data as T;
}
