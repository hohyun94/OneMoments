import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { ApiError, api, setCsrfToken } from "./lib/api.ts";
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
import { loadIdentity, saveIdentity } from "./lib/keystore.ts";
import { disablePush } from "./lib/push.ts";
import type { AuthResponse, MeResponse, PublicUser } from "./types.ts";

const LAST_USERNAME_KEY = "onemoments:lastUsername";

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
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [lastUsername, setLastUsername] = useState(
    () => localStorage.getItem(LAST_USERNAME_KEY) ?? "",
  );

  useEffect(() => {
    let cancelled = false;
    api<MeResponse>("/api/auth/me")
      .then(async (me) => {
        if (cancelled) return;
        const stored = await loadIdentity(me.user.username);
        if (!stored) {
          setSession({ user: me.user, deviceId: me.deviceId });
          setStatus("missing-keys");
          return;
        }
        const ensured = await syncPreKeys(stored);
        const updated: StoredIdentity = {
          ...ensured,
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

    const stored: StoredIdentity = {
      ...generated,
      username: response.user.username,
      userId: response.user.id,
      deviceId: response.device.id,
    };
    await saveIdentity(stored);
    localStorage.setItem(LAST_USERNAME_KEY, response.user.username);
    setLastUsername(response.user.username);
    setIdentity(stored);
    setSession({ user: response.user, deviceId: response.device.id });
    setStatus("authenticated");
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const normalized = username.trim().toLowerCase();
    const storedIdentity = await loadIdentity(normalized);
    let localIdentity: StoredIdentity = storedIdentity ?? {
      ...(await createIdentity()),
      username: normalized,
    };

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

    let response: AuthResponse;
    try {
      response = await loginWithDevice(localIdentity.deviceId, localIdentity);
    } catch (error) {
      const revoked =
        error instanceof ApiError &&
        error.status === 401 &&
        localIdentity.deviceId !== undefined &&
        /device/i.test(error.message);
      if (!revoked) throw error;

      // 폐기된 기기: 새 키로 이 기기를 등록하고 다시 로그인한다(과거 이력은 복호화 불가).
      localIdentity = {
        ...(await createIdentity()),
        username: normalized,
      };
      response = await loginWithDevice(undefined, localIdentity);
    }

    setCsrfToken(response.csrfToken);
    const stored: StoredIdentity = {
      ...localIdentity,
      username: response.user.username,
      userId: response.user.id,
      deviceId: response.device.id,
    };
    await saveIdentity(stored);
    localStorage.setItem(LAST_USERNAME_KEY, response.user.username);
    setLastUsername(response.user.username);
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
    const { state, ...device } = restored;
    const stored: StoredIdentity = {
      ...device,
      username: response.user.username,
      userId: response.user.id,
      deviceId: response.device.id,
    };
    if (state) await importLocalCryptoState(state);
    await saveIdentity(stored);
    localStorage.setItem(LAST_USERNAME_KEY, response.user.username);
    setLastUsername(response.user.username);
    setIdentity(stored);
    setSession({ user: response.user, deviceId: response.device.id });
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    try {
      // 이 기기의 푸시 구독을 먼저 해제해 로그아웃 후 알림이 남지 않게 한다.
      await disablePush();
    } catch {
      // 브라우저가 푸시를 지원하지 않거나 구독이 없어도 로그아웃은 계속한다.
    }
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // 세션이 이미 만료된 경우도 로컬 상태는 정리한다.
    }
    setCsrfToken(null);
    setIdentity(null);
    setSession(null);
    setStatus("anonymous");
  }, []);

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
    }),
    [status, session, identity, lastUsername, register, login, recover, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
