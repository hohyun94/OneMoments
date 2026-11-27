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
import { currentPlatform } from "./lib/device.ts";
import { fileToAvatarPayload } from "./lib/avatar.ts";
import { disablePush } from "./lib/push.ts";
import { markDeviceRecovered } from "./lib/recovery.ts";
import { clearSearchIndex } from "./lib/search.ts";
import { clearAllDrafts } from "./lib/drafts.ts";
import { clearAliases } from "./lib/aliases.ts";
import { clearBookmarks } from "./lib/bookmarks.ts";
import { clearOutbox } from "./lib/outbox.ts";
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
  /** 가입. `SIGNUP_MODE=invite` 면 초대 코드가 필요하다. */
  register: (
    username: string,
    password: string,
    inviteCode?: string,
    signupRequestToken?: string,
  ) => Promise<void>;
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
  /** 가입 정책. invite 면 초대 코드가 필요하고, closed 면 가입 탭을 숨긴다. */
  signupMode: "open" | "invite" | "closed";
  /** 가입 신청(관리자 승인형) 허용 여부. */
  signupRequestEnabled: boolean;
  /** 서버에 Google OAuth 설정이 있는지. */
  oauthEnabled: boolean;
  /** 지도 타일 템플릿(서버 설정). null 이면 위치 공유에서 지도 이미지를 쓰지 않는다. */
  mapTileUrl: string | null;
  /** 현재 계정에 Google 계정이 연결되었는지. */
  googleLinked: boolean;
  /** 비밀번호 로그인 가능 여부(Google 전용 계정은 false). */
  hasPassword: boolean;
  /** Google 로그인/가입 시작(브라우저를 Google 로 이동). */
  startGoogle: (intent: "signup" | "login") => Promise<void>;
  /** 콜백 티켓으로 가입/로그인을 완료한다. username 은 가입일 때 필수. */
  completeGoogle: (input: { ticket: string; username?: string }) => Promise<void>;
  /** 로그인 상태에서 Google 연결 시작. */
  startGoogleLink: () => Promise<void>;
  /** 연결 완료(티켓). */
  completeGoogleLink: (ticket: string) => Promise<void>;
  /** 연결 해제(비밀번호 확인 필요). */
  unlinkGoogle: (password: string) => Promise<void>;
  /** 계정 화면 테마. */
  theme: ThemeSettings;
  /** 테마를 즉시 적용하고 계정에 저장한다. */
  updateTheme: (theme: ThemeSettings) => Promise<void>;
  /** 공개 프로필 상태 메시지를 저장한다(null/빈 문자열이면 지움). */
  updateStatusMessage: (statusMessage: string | null) => Promise<void>;
  /** 공개 프로필 아바타를 128px JPEG 로 줄여 저장한다. */
  uploadAvatar: (file: File) => Promise<void>;
  /** 공개 프로필 아바타를 지운다. */
  removeAvatar: () => Promise<void>;
  /** 마지막 접속 시각 공개 여부(옵트인)를 저장한다. */
  updateLastSeenVisibility: (visible: boolean) => Promise<void>;
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
  // Google OAuth 상태(서버 설정·계정 연결·비밀번호 유무).
  const [oauthEnabled, setOauthEnabled] = useState(false);
  /** 지도 타일 템플릿(서버 설정). null 이면 지도 이미지 기능을 숨긴다. */
  const [mapTileUrl, setMapTileUrl] = useState<string | null>(null);
  /** 가입 정책(open/invite/closed). 로그인 전 공개 설정에서 읽는다. */
  const [signupMode, setSignupMode] = useState<"open" | "invite" | "closed">("open");
  /** 가입 신청(관리자 승인형) 허용 여부. */
  const [signupRequestEnabled, setSignupRequestEnabled] = useState(false);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [hasPassword, setHasPassword] = useState(true);
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
    // 로그인 전에도 Google 버튼 노출 여부를 알 수 있게 공개 설정을 읽는다.
    let cancelled = false;
    api<{
      oauthEnabled: boolean;
      mapTileUrl: string | null;
      signupMode?: string;
      signupRequestEnabled?: boolean;
    }>(
      "/api/auth/config",
    )
      .then((value) => {
        if (cancelled) return;
        setOauthEnabled(Boolean(value.oauthEnabled));
        setSignupRequestEnabled(Boolean(value.signupRequestEnabled));
        setMapTileUrl(typeof value.mapTileUrl === "string" ? value.mapTileUrl : null);
        setSignupMode(
          value.signupMode === "invite" || value.signupMode === "closed"
            ? value.signupMode
            : "open",
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
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
        setOauthEnabled(me.oauthEnabled ?? false);
        setGoogleLinked(me.googleLinked ?? false);
        setHasPassword(me.hasPassword ?? true);
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

  const register = useCallback(
    async (
      username: string,
      password: string,
      inviteCode?: string,
      signupRequestToken?: string,
    ) => {
    const generated = await createIdentity();
    const response = await api<AuthResponse>("/api/auth/register", {
      method: "POST",
      csrf: false,
      body: {
        username,
        password,
        ...(inviteCode ? { inviteCode } : {}),
        ...(signupRequestToken ? { signupRequestToken } : {}),
        device: {
          name: deviceName(),
          platform: currentPlatform(),
          identityPublicKey: generated.identityPublicKey,
          signingPublicKey: generated.signingPublicKey,
          ...signedPreKeyBody({ ...generated, username }),
        },
      },
    });
    setCsrfToken(response.csrfToken);

    // 새 계정/세션이므로 이전 계정의 로컬 검색 인덱스를 비운다.
    void clearSearchIndex();

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
    setHasPassword(true);
    setGoogleLinked(false);
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
                platform: currentPlatform(),
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
    void clearSearchIndex();
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
    setHasPassword(response.hasPassword ?? true);
    setGoogleLinked(response.googleLinked ?? false);
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
    void clearSearchIndex();
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
    // 복구 스냅샷 이후 메시지는 이 기기에서 읽을 수 없다는 안내에 쓴다.
    markDeviceRecovered(response.device.id);
    localStorage.removeItem(FORCE_LOGIN_KEY);
    localStorage.setItem(LAST_USERNAME_KEY, normalized);
    setLastUsername(normalized);
    setIdentity(stored);
    setSession({ user: response.user, deviceId: response.device.id });
    setStatus("authenticated");
    setHasPassword(response.hasPassword ?? true);
    setGoogleLinked(response.googleLinked ?? false);
  }, []);

  /** Google 로그인/가입을 시작한다(브라우저가 Google 로 이동). */
  const startGoogle = useCallback(async (intent: "signup" | "login") => {
    const response = await api<{ authorizationUrl: string }>("/api/auth/google/start", {
      method: "POST",
      csrf: false,
      body: { intent },
    });
    window.location.assign(response.authorizationUrl);
  }, []);

  /**
   * 콜백 티켓으로 가입/로그인을 완료한다.
   * 가입은 아이디 선택이 필요하고, 기기 키는 이 브라우저에서 새로 만들어 공개키만 보낸다.
   */
  const completeGoogle = useCallback(
    async (input: { ticket: string; username?: string }) => {
      const generated = await createIdentity();
      const username = input.username?.trim().toLowerCase();
      const response = await api<AuthResponse>("/api/auth/google/complete", {
        method: "POST",
        csrf: false,
        body: {
          ticket: input.ticket,
          ...(username ? { username } : {}),
          device: {
            name: deviceName(),
            platform: currentPlatform(),
            identityPublicKey: generated.identityPublicKey,
            signingPublicKey: generated.signingPublicKey,
            ...signedPreKeyBody({ ...generated, username: username ?? "" }),
          },
        },
      });
      setCsrfToken(response.csrfToken);
      void clearSearchIndex();

      // 새 세션이므로 이 브라우저의 테마를 초기값으로 저장한다.
      const initialTheme = applyTheme(loadTheme());
      setTheme(initialTheme);
      void api("/api/auth/theme", { method: "PUT", body: initialTheme }).catch(() => undefined);

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
      setOauthEnabled(true);
      setGoogleLinked(response.googleLinked ?? true);
      setHasPassword(response.hasPassword ?? false);
    },
    [],
  );

  const startGoogleLink = useCallback(async () => {
    const response = await api<{ authorizationUrl: string }>("/api/auth/google/start/link", {
      method: "POST",
      body: {},
    });
    window.location.assign(response.authorizationUrl);
  }, []);

  const completeGoogleLink = useCallback(async (ticket: string) => {
    const response = await api<{ hasPassword?: boolean; googleLinked?: boolean }>(
      "/api/auth/google/complete/link",
      { method: "POST", body: { ticket } },
    );
    setGoogleLinked(response.googleLinked ?? true);
    if (typeof response.hasPassword === "boolean") setHasPassword(response.hasPassword);
  }, []);

  const unlinkGoogle = useCallback(async (password: string) => {
    const response = await api<{ hasPassword?: boolean; googleLinked?: boolean }>(
      "/api/auth/google/unlink",
      { method: "POST", body: { password } },
    );
    setGoogleLinked(response.googleLinked ?? false);
    if (typeof response.hasPassword === "boolean") setHasPassword(response.hasPassword);
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
    // 로컬 초안·별명·저장한 메시지에는 평문이 남으므로 로그아웃 시 함께 지운다.
    clearAllDrafts();
    clearAliases();
    await Promise.all([
      serverLogout,
      pushOff,
      clearSearchIndex(),
      clearBookmarks(),
      clearOutbox(),
    ]);
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

  /** 공개 프로필 상태 메시지를 저장하고 세션 사용자 정보를 갱신한다. */
  const updateStatusMessage = useCallback(async (statusMessage: string | null) => {
    const response = await api<{ user: PublicUser }>("/api/auth/profile", {
      method: "PUT",
      body: { statusMessage },
    });
    setSession((current) =>
      current ? { ...current, user: response.user } : current,
    );
  }, []);

  /**
   * 공개 프로필 아바타 업로드.
   * 상태 메시지와 같은 공개 메타데이터라 평문으로 저장하고, 전송 전에 128px 로 줄인다.
   */
  const uploadAvatar = useCallback(async (file: File) => {
    const payload = await fileToAvatarPayload(file);
    const response = await api<{ user: PublicUser }>("/api/auth/profile/avatar", {
      method: "PUT",
      body: payload,
    });
    setSession((current) => (current ? { ...current, user: response.user } : current));
  }, []);

  const removeAvatar = useCallback(async () => {
    const response = await api<{ user: PublicUser }>("/api/auth/profile/avatar", {
      method: "DELETE",
    });
    setSession((current) => (current ? { ...current, user: response.user } : current));
  }, []);

  /** 마지막 접속 시각 공개 여부(옵트인, 기본 비공개). */
  const updateLastSeenVisibility = useCallback(async (visible: boolean) => {
    const response = await api<{ user: PublicUser }>("/api/auth/profile/last-seen", {
      method: "PUT",
      body: { visible },
    });
    setSession((current) => (current ? { ...current, user: response.user } : current));
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
      updateStatusMessage,
      uploadAvatar,
      removeAvatar,
      updateLastSeenVisibility,
      oauthEnabled,
      mapTileUrl,
      signupMode,
      signupRequestEnabled,
      googleLinked,
      hasPassword,
      startGoogle,
      completeGoogle,
      startGoogleLink,
      completeGoogleLink,
      unlinkGoogle,
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
      updateStatusMessage,
      uploadAvatar,
      removeAvatar,
      updateLastSeenVisibility,
      oauthEnabled,
      mapTileUrl,
      signupMode,
      signupRequestEnabled,
      googleLinked,
      hasPassword,
      startGoogle,
      completeGoogle,
      startGoogleLink,
      completeGoogleLink,
      unlinkGoogle,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
