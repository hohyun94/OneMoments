import type { Identity } from "./crypto.js";

export interface ApiResponse {
  status: number;
  body: any;
  text: string;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string | Uint8Array;
  headers?: Record<string, string>;
  csrf?: boolean;
}

/** 세션 쿠키와 CSRF 토큰을 유지하는 테스트 클라이언트. */
export class TestClient {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(readonly baseUrl: string) {}

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...options.headers };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;

    const isAuthEntry = path === "/api/auth/login" || path === "/api/auth/register";
    if (method !== "GET" && options.csrf !== false && !isAuthEntry && this.csrfToken) {
      headers["x-csrf-token"] = this.csrfToken;
    }

    let body: string | Uint8Array | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers["content-type"] ??= "application/json";
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body as unknown as RequestInit["body"],
    });
    const getSetCookie = (
      response.headers as unknown as { getSetCookie?: () => string[] }
    ).getSetCookie;
    const setCookies = getSetCookie
      ? getSetCookie.call(response.headers)
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie") as string]
        : [];
    for (const raw of setCookies) this.storeCookie(raw);

    const text = await response.text();
    let parsed: any = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (parsed && typeof parsed === "object" && typeof parsed.csrfToken === "string") {
      this.csrfToken = parsed.csrfToken;
    }
    return { status: response.status, body: parsed, text };
  }

  private storeCookie(raw: string): void {
    const pair = raw.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator === -1) return;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const expired = /Max-Age=0/i.test(raw) || /Expires=Thu, 01 Jan 1970/i.test(raw);
    if (!value || expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  async register(
    username: string,
    identity: Identity,
    options: { password?: string; deviceName?: string; platform?: string } = {},
  ): Promise<ApiResponse> {
    return this.request("POST", "/api/auth/register", {
      body: {
        username,
        password: options.password ?? "password-12345",
        device: {
          name: options.deviceName ?? "test-device",
          ...(options.platform ? { platform: options.platform } : {}),
          identityPublicKey: identity.identity.publicKeyBase64,
          signingPublicKey: identity.signing.publicKeyBase64,
        },
      },
    });
  }

  async loginWithNewDevice(
    username: string,
    identity: Identity,
    options: { password?: string; deviceName?: string; platform?: string } = {},
  ): Promise<ApiResponse> {
    return this.request("POST", "/api/auth/login", {
      body: {
        username,
        password: options.password ?? "password-12345",
        device: {
          name: options.deviceName ?? "second-device",
          ...(options.platform ? { platform: options.platform } : {}),
          identityPublicKey: identity.identity.publicKeyBase64,
          signingPublicKey: identity.signing.publicKeyBase64,
        },
      },
    });
  }

  async addDevice(
    name: string,
    identity: Identity,
    options: { platform?: string } = {},
  ): Promise<ApiResponse> {
    return this.request("POST", "/api/devices", {
      body: {
        name,
        ...(options.platform ? { platform: options.platform } : {}),
        identityPublicKey: identity.identity.publicKeyBase64,
        signingPublicKey: identity.signing.publicKeyBase64,
      },
    });
  }
}
