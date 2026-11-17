import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ApiError, api, setCsrfToken } from "./lib/api.ts";
import { clearDecryptedMessageCache } from "./components/MessageBubble.tsx";
import {
  createIdentity,
  replenishOneTimePreKeys,
  rotateSignedPreKeyIfNeeded,
  importKeyBackup,
  importLocalCryptoState,
  signPayload,
  toBase64,
  type KeyBackupBlob,
  type StoredIdentity,
} from "./lib/crypto/index.ts";
import {
  listIdentitiesForAlias,
  loadIdentityForUser,
  saveIdentity,
} from "./lib/keystore.ts";
import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  clampIdleTimeoutSeconds,
  effectiveIdleTimeoutSeconds,
} from "./lib/idleTimeout.ts";
import { disablePush } from "./lib/push.ts";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  loadTheme,
  type ThemeSettings,
} from "./lib/theme.ts";
import type { AuthResponse, MeResponse, PublicUser } from "./types.ts";

const LAST_USERNAME_KEY = "onemoments:lastUsername";
const FORCE_LOGIN_KEY = "onemoments:forceLogin";

export type SessionStatus =
  | "loading"
  | "anonymous"
  | "authenticated"
  | "missing-keys";

export interface Session {
  user: PublicUser;
  deviceId: string;
}

interface SessionContextValue {
  status: SessionStatus;
  session: Session | null;
  identity: StoredIdentity | null;
  lastUsername: string;
  register: (username: string, password: string) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  recover: (username: string, passphrase: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 실제 적용 중인 무활동 자동 로그아웃(초). 세션 오버라이드가 있으면 그 값. */
  idleTimeoutSeconds: number;
  /** 이 기기의 기본값(초). */
  deviceIdleTimeoutSeconds: number;
  /** 이번 로그인에만 적용하는 값(초). null 이면 기기 기본값. */
  sessionIdleTimeoutSeconds: number | null;
  /** 이 기기의 기본값을 변경한다(서버 저장). */
  updateDeviceIdleTimeout: (seconds: number) => Promise<void>;
  /** 이번 로그인에만 적용할 값을 변경한다. null 이면 오버라이드 해제. */
  updateSessionIdleTimeout: (seconds: number | null) => Promise<void>;
  /** 계정 화면 테마. */
  theme: ThemeSettings;
  /** 테마를 즉시 적용하고 계정에 저장한다. */
  updateTheme: (theme: ThemeSettings) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|Android/i.test(ua)) return "Mobile browser";
  if (/Macintosh/i.test(ua)) return "Mac browser";
  if (/Windows/i.test(ua)) return "Windows browser";
  return "Web browser";
}

function signedPreKeyBody(identity: StoredIdentity): {
  signedPreKey?: { id: string; publicKey: string; signature: string };
  oneTimePreKeys?: Array<{ id: string; publicKey: string }>;
} {
  const oneTimePreKeys = (identity.oneTimePreKeys ?? []).map((key) => ({
    id: key.id,
    publicKey: key.publicKey,
  }));
  if (
    identity.signedPreKeyId &&
    identity.signedPreKeyPublicKey &&
    identity.signedPreKeySignature
  ) {
    return {
      signedPreKey: {
        id: identity.signedPreKeyId,
        publicKey: identity.signedPreKeyPublicKey,
        signature: identity.signedPreKeySignature,
      },
      ...(oneTimePreKeys.length > 0 ? { oneTimePreKeys } : {}),
    };
  }
  return oneTimePreKeys.length > 0 ? { oneTimePreKeys } : {};
}

async function uploadSignedPreKey(identity: StoredIdentity): Promise<void> {
  if (
    !identity.signedPreKeyId ||
    !identity.signedPreKeyPublicKey ||
    !identity.signedPreKeySignature
  ) {
    return;
  }
  await api("/api/auth/device/prekey", {
    method: "PUT",
    csrf: false,
    body: {
      signedPreKey: {
        id: identity.signedPreKeyId,
        publicKey: identity.signedPreKeyPublicKey,
        signature: identity.signedPreKeySignature,
      },
    },
  }).catch(() => undefined);
}

async function uploadOneTimePreKeys(identity: StoredIdentity): Promise<void> {
  const oneTimePreKeys = (identity.oneTimePreKeys ?? []).map((key) => ({
    id: key.id,
    publicKey: key.publicKey,
  }));
  if (oneTimePreKeys.length === 0) return;
  await api("/api/auth/device/one-time-prekeys", {
    method: "POST",
    csrf: false,
    body: { oneTimePreKeys },
  }).catch(() => undefined);
}

interface PreKeyStatus {
  oneTimePreKeyCount: number;
  oneTimePreKeyIds: string[];
}

async function syncPreKeys(identity: StoredIdentity): Promise<StoredIdentity> {
  let serverIds: string[] = [];
  try {
    const status = await api<PreKeyStatus>("/api/auth/device/prekeys/status");
    serverIds = status.oneTimePreKeyIds ?? [];
  } catch {
    // 상태 조회 실패 시 로컬 보유분을 유지한 채 보충한다.
  }
  const rotated = await rotateSignedPreKeyIfNeeded(identity);
  const replenished = await replenishOneTimePreKeys(rotated, serverIds);
  return { ...replenished, username: identity.username };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [lastUsername, setLastUsername] = useState(
    () => localStorage.getItem(LAST_USERNAME_KEY) ?? "",
  );
  const [deviceIdleTimeoutSeconds, setDeviceIdleTimeoutSeconds] = useState(
    DEFAULT_IDLE_TIMEOUT_SECONDS,
  );
  const [sessionIdleTimeoutSeconds, setSessionIdleTimeoutSeconds] = useState<number | null>(
    null,
  );
  const idleTimeoutSeconds = effectiveIdleTimeoutSeconds(
    deviceIdleTimeoutSeconds,
    sessionIdleTimeoutSeconds,
  );
  const [theme, setTheme] = useState<ThemeSettings>(() => loadTheme());

  /** 서버/로컬 테마를 화면에 적용하고 상태를 맞춘다(로컬 캐시도 갱신). */
  const adoptTheme = useCallback((value: ThemeSettings) => {
    const applied = applyTheme(value);
    setTheme(applied);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setTheme(loadTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (localStorage.getItem(FORCE_LOGIN_KEY) === "1") {
      setStatus("anonymous");
      return;
    }
    let cancelled = false;
    api<MeResponse>("/api/auth/me")
      .then(async (me) => {
        if (cancelled) return;
        // 기기 기본값과 세션 오버라이드를 먼저 반영한다(구버전 응답은 기본값으로 대체).
        adoptTheme(me.theme);
        setDeviceIdleTimeoutSeconds(
          me.deviceIdleTimeoutSeconds ??
            me.devices.find((device) => device.id === me.deviceId)?.idleTimeoutSeconds ??
            DEFAULT_IDLE_TIMEOUT_SECONDS,
        );
        setSessionIdleTimeoutSeconds(me.sessionIdleTimeoutSeconds ?? null);
        const stored = await loadIdentityForUser(me.user.id, me.user.username);
        if (!stored) {
          setSession({ user: me.user, deviceId: me.deviceId });
          setStatus("missing-keys");
          return;
        }
        const ensured = await syncPreKeys(stored);
        const updated: StoredIdentity = {
          ...ensured,
          username: ensured.username,
          loginAlias: ensured.loginAlias ?? ensured.username.toLowerCase(),
          deviceId: me.deviceId,
          userId: me.user.id,
        };
        const keysChanged =
          updated.signedPreKeyId !== stored.signedPreKeyId ||
          (updated.oneTimePreKeys ?? []).map((key) => key.id).join(",") !==
            (stored.oneTimePreKeys ?? []).map((key) => key.id).join(",");
        if (keysChanged || stored.deviceId !== me.deviceId || stored.userId !== me.user.id) {
          await saveIdentity(updated);
        }
        if (keysChanged) {
          void uploadSignedPreKey(updated);
          void uploadOneTimePreKeys(updated);
        }
        setIdentity(updated);
        setSession({ user: me.user, deviceId: me.deviceId });
        setStatus("authenticated");
      })
      .catch(() => {
        if (!cancelled) setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const generated = await createIdentity();
    const response = await api<AuthResponse>("/api/auth/register", {
      method: "POST",
      csrf: false,
      body: {
        username,
        password,
        device: {
          name: deviceName(),
          identityPublicKey: generated.identityPublicKey,
          signingPublicKey: generated.signingPublicKey,
          ...signedPreKeyBody({ ...generated, username }),
        },
      },
    });
    setCsrfToken(response.csrfToken);

    // 새 계정은 이 브라우저의 현재 테마를 초기값으로 저장한다.
    const initialTheme = applyTheme(loadTheme());
    setTheme(initialTheme);
    void api("/api/auth/theme", { method: "PUT", body: initialTheme }).catch(
      () => undefined,
    );

    // 새 기기/세션이므로 기기 기본값을 쓰고 세션 오버라이드는 없다.
    setDeviceIdleTimeoutSeconds(
      response.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    );
    setSessionIdleTimeoutSeconds(null);

    const stored: StoredIdentity = {
      ...generated,
      username: response.user.username,
      loginAlias: response.user.username,
      userId: response.user.id,
      deviceId: response.device.id,
    };
    await saveIdentity(stored);
    localStorage.removeItem(FORCE_LOGIN_KEY);
    localStorage.setItem(LAST_USERNAME_KEY, response.user.username);
    setLastUsername(response.user.username);
    setIdentity(stored);
    setSession({ user: response.user, deviceId: response.device.id });
    setStatus("authenticated");
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const normalized = username.trim().toLowerCase();
    const candidates = await listIdentitiesForAlias(normalized);

    const loginWithDevice = (deviceId: string | undefined, current: StoredIdentity) =>
      api<AuthResponse>("/api/auth/login", {
        method: "POST",
        csrf: false,
        body: deviceId
          ? { username: normalized, password, deviceId }
          : {
              username: normalized,
              password,
              device: {
                name: deviceName(),
                identityPublicKey: current.identityPublicKey,
                signingPublicKey: current.signingPublicKey,
                ...signedPreKeyBody(current),
              },
            },
      });

    let response: AuthResponse | null = null;
    let localIdentity: StoredIdentity | null = null;

    // 같은 로그인 ID에 실제/decoy identity가 모두 있을 수 있으므로
    // 비밀번호로 선택된 프로필의 기기에서만 성공한다.
    for (const candidate of candidates) {
      if (!candidate.deviceId) continue;
      try {
        response = await loginWithDevice(candidate.deviceId, candidate);
        localIdentity = candidate;
        break;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }
    }

    // 처음 decoy 로그인/기기 폐기/새 기기: 새 키로 기기를 등록한다.
    if (!response || !localIdentity) {
      const generated = await createIdentity();
      localIdentity = {
        ...generated,
        username: normalized,
        loginAlias: normalized,
      };
      response = await loginWithDevice(undefined, localIdentity);
    }

    setCsrfToken(response.csrfToken);
    adoptTheme(response.theme);
    setDeviceIdleTimeoutSeconds(
      response.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    );
    setSessionIdleTimeoutSeconds(null);
    // decoy 프로필에서는 실제 프로필의 브라우저 푸시 구독이 남지 않게 한다.
    if (response.user.username.toLowerCase() !== normalized) {
      await disablePush().catch(() => undefined);
    }

    const stored: StoredIdentity = {
      ...localIdentity,
      username: response.user.username,
      loginAlias: normalized,
      userId: response.user.id,
      deviceId: response.device.id,
    };
    await saveIdentity(stored);
    localStorage.removeItem(FORCE_LOGIN_KEY);

    localStorage.setItem(LAST_USERNAME_KEY, normalized);
    setLastUsername(normalized);
    setIdentity(stored);
    setSession({ user: response.user, deviceId: response.device.id });
    setStatus("authenticated");
  }, []);

  const recover = useCallback(async (username: string, passphrase: string) => {
    const normalized = username.trim().toLowerCase();
    if (passphrase.length < 10) {
      throw new Error("복구 암호는 10자 이상이어야 합니다.");
    }

    const lookup = await api<{ backup: { blob: string } }>(
      "/api/auth/recovery/lookup",
      { method: "POST", csrf: false, body: { username: normalized } },
    );
    let blob: KeyBackupBlob;
    try {
      blob = JSON.parse(lookup.backup.blob) as KeyBackupBlob;
    } catch {
      throw new Error("백업 형식이 올바르지 않습니다.");
    }

    const restored = await importKeyBackup(blob, passphrase);
    if (!restored.deviceId) throw new Error("백업에 기기 정보가 없습니다.");

    const challenge = await api<{ challengeId: string; challenge: string }>(
      "/api/auth/recovery/challenge",
      { method: "POST", csrf: false, body: { deviceId: restored.deviceId } },
    );
    const signature = toBase64(
      await signPayload(
        restored.backend,
        restored.signingPrivate,
        new TextEncoder().encode(`recover:${challenge.challenge}`),
      ),
    );

    const response = await api<AuthResponse>("/api/auth/recover", {
      method: "POST",
      csrf: false,
      body: {
        deviceId: restored.deviceId,
        challengeId: challenge.challengeId,
        signature,
      },
    });

    setCsrfToken(response.csrfToken);
    adoptTheme(response.theme);
    setDeviceIdleTimeoutSeconds(
      response.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    );
    setSessionIdleTimeoutSeconds(null);
    const { state, ...device } = restored;
    const stored: StoredIdentity = {
      ...device,
      username: response.user.username,
      loginAlias: normalized,
      userId: response.user.id,
      deviceId: response.device.id,
    };
    if (state) await importLocalCryptoState(state);
    await saveIdentity(stored);
    localStorage.removeItem(FORCE_LOGIN_KEY);
    localStorage.setItem(LAST_USERNAME_KEY, normalized);
    setLastUsername(normalized);
    setIdentity(stored);
    setSession({ user: response.user, deviceId: response.device.id });
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    // 즉시 로그인 화면으로 전환해 남은 내용이 화면에 보이지 않게 한다.
    localStorage.setItem(FORCE_LOGIN_KEY, "1");
    const serverLogout = api("/api/auth/logout", { method: "POST" }).catch(
      () => undefined,
    );
    const pushOff = disablePush().catch(() => undefined);
    setCsrfToken(null);
    setIdentity(null);
    setSession(null);
    setStatus("anonymous");
    setDeviceIdleTimeoutSeconds(DEFAULT_IDLE_TIMEOUT_SECONDS);
    setSessionIdleTimeoutSeconds(null);
    queryClient.clear();
    clearDecryptedMessageCache();
    await Promise.all([serverLogout, pushOff]);
  }, [queryClient]);

  /** 기기 기본값을 서버에 저장하고 이 화면의 타이머에 즉시 반영한다. */
  const updateDeviceIdleTimeout = useCallback(
    async (seconds: number) => {
      if (!session) throw new Error("로그인이 필요합니다.");
      const clamped = clampIdleTimeoutSeconds(seconds);
      const response = await api<{ device: { idleTimeoutSeconds: number } }>(
        `/api/devices/${session.deviceId}/timeout`,
        { method: "PUT", body: { seconds: clamped } },
      );
      setDeviceIdleTimeoutSeconds(
        response.device.idleTimeoutSeconds ?? clamped,
      );
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
    [session, queryClient],
  );

  /** 이번 로그인(세션)에만 적용할 값을 저장한다. null 이면 오버라이드 해제. */
  const updateSessionIdleTimeout = useCallback(async (seconds: number | null) => {
    const response = await api<{ idleTimeoutSeconds: number | null }>(
      "/api/auth/session/timeout",
      {
        method: "PUT",
        body: { seconds: seconds === null ? null : clampIdleTimeoutSeconds(seconds) },
      },
    );
    setSessionIdleTimeoutSeconds(response.idleTimeoutSeconds);
  }, []);

  /** 테마를 즉시 적용하고 계정에 저장한다. 저장 실패 시에도 로컬에는 적용된다. */
  const updateTheme = useCallback(async (value: ThemeSettings) => {
    const applied = applyTheme(value);
    setTheme(applied);
    const response = await api<{ theme: ThemeSettings }>("/api/auth/theme", {
      method: "PUT",
      body: applied,
    });
    setTheme(applyTheme(response.theme));
  }, []);

  // 무활동 자동 로그아웃: 입력/스크롤/포인터 활동이 없으면 세션과 화면 캐시를 지운다.
  // 값은 기기 기본값 또는 세션 오버라이드를 따르며, 설정 변경 시 타이머가 재시작된다.
  const idleTimeoutMs = idleTimeoutSeconds * 1000;
  useEffect(() => {
    if (status !== "authenticated") return;

    let lastActivity = Date.now();
    const markActivity = () => {
      lastActivity = Date.now();
    };
    const events = [
      "pointerdown",
      "keydown",
      "touchstart",
      "scroll",
      "wheel",
      "mousemove",
    ] as const;
    for (const event of events) {
      window.addEventListener(event, markActivity, { passive: true });
    }

    const checkIdle = () => {
      if (Date.now() - lastActivity >= idleTimeoutMs) {
        void logout();
      }
    };
    const timer = window.setInterval(checkIdle, 1_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkIdle();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      for (const event of events) {
        window.removeEventListener(event, markActivity);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [status, logout, idleTimeoutMs]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      session,
      identity,
      lastUsername,
      register,
      login,
      recover,
      logout,
      idleTimeoutSeconds,
      deviceIdleTimeoutSeconds,
      sessionIdleTimeoutSeconds,
      updateDeviceIdleTimeout,
      updateSessionIdleTimeout,
      theme,
      updateTheme,
    }),
    [
      status,
      session,
      identity,
      lastUsername,
      register,
      login,
      recover,
      logout,
      idleTimeoutSeconds,
      deviceIdleTimeoutSeconds,
      sessionIdleTimeoutSeconds,
      updateDeviceIdleTimeout,
      updateSessionIdleTimeout,
      theme,
      updateTheme,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
