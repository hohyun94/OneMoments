/**
 * 경량 i18n(외부 라이브러리 없음).
 *
 * - 사전은 `ko`(기준)와 `en` 두 개이며, 키 누락 시 한국어로 폴백한다.
 * - `{name}` 형태의 변수 치환만 지원한다.
 * - 번역 적용 범위는 점진적으로 넓힌다(docs/32-i18n.md).
 */

export type Locale = "ko" | "en";

export const LOCALES: readonly Locale[] = ["ko", "en"];
export const DEFAULT_LOCALE: Locale = "ko";
export const LOCALE_STORAGE_KEY = "onemoments-locale";

type Dictionary = Record<string, string>;

const ko: Dictionary = {
  "lang.ko": "한국어",
  "lang.en": "English",

  "auth.tab.login": "로그인",
  "auth.tab.register": "가입",
  "auth.tab.recover": "복구",
  "auth.google.signup": "Google로 가입",
  "auth.google.login": "Google로 로그인",
  "auth.orContinue": "또는 아이디로 계속",
  "auth.username.label": "아이디",
  "auth.password.label": "비밀번호",
  "auth.recoverPassphrase.label": "복구 암호",
  "auth.password.placeholder.min": "10자 이상",
  "auth.recoverPassphrase.placeholder": "백업할 때 설정한 복구 암호",
  "auth.confirm.label": "비밀번호 확인",
  "auth.submit.login": "로그인",
  "auth.submit.register": "가입하고 시작하기",
  "auth.submit.recover": "백업으로 복구",
  "auth.recover.note":
    "복구 암호는 서버로 전송되지 않습니다. 이 기기의 이전 세션은 로그아웃되고, 백업한 기기 키로 대화 이력을 이어서 복호화합니다.",
  "auth.footer.recover": "백업이 없거나 복구 암호를 잊으면 서버에서도 키를 복구할 수 없습니다.",
  "auth.footer.default":
    "기기 키는 이 브라우저에만 저장됩니다. 서버는 메시지 내용을 복호화할 수 없습니다.",

  "error.passwordMismatch": "비밀번호가 서로 다릅니다.",
  "error.recoverFailed": "복구 암호가 올바르지 않거나 백업이 손상되었습니다.",
  "error.backupPassphrase": "복구 암호가 올바르지 않습니다.",
  "error.backupFormat": "백업 형식이 올바르지 않습니다.",
  "error.usernameTaken": "이미 사용 중인 아이디입니다.",
  "error.unauthorized": "아이디 또는 비밀번호가 올바르지 않습니다.",
  "error.validation": "입력값을 확인해 주세요. 아이디는 3~32자, 비밀번호는 10자 이상입니다.",
  "error.tooManyRequests": "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  "error.deviceRequired": "기기 등록에 실패했습니다. 다시 시도해 주세요.",
  "error.backupNotFound": "이 계정의 키 백업을 찾을 수 없습니다.",
  "error.recoveryUnavailable": "복구할 수 없는 기기입니다(폐기되었거나 존재하지 않음).",
  "error.recoveryChallengeInvalid": "복구 요청이 만료되었습니다. 다시 시도해 주세요.",
  "error.webcrypto": "이 브라우저에서는 암호화 기능을 사용할 수 없습니다. 최신 브라우저를 사용해 주세요.",
  "error.generic": "문제가 발생했습니다. 잠시 후 다시 시도해 주세요.",
};

const en: Dictionary = {
  "lang.ko": "한국어",
  "lang.en": "English",

  "auth.tab.login": "Sign in",
  "auth.tab.register": "Sign up",
  "auth.tab.recover": "Recover",
  "auth.google.signup": "Sign up with Google",
  "auth.google.login": "Sign in with Google",
  "auth.orContinue": "or continue with a username",
  "auth.username.label": "Username",
  "auth.password.label": "Password",
  "auth.recoverPassphrase.label": "Recovery passphrase",
  "auth.password.placeholder.min": "At least 10 characters",
  "auth.recoverPassphrase.placeholder": "The passphrase you set when backing up",
  "auth.confirm.label": "Confirm password",
  "auth.submit.login": "Sign in",
  "auth.submit.register": "Create account",
  "auth.submit.recover": "Recover from backup",
  "auth.recover.note":
    "Your recovery passphrase never leaves this browser. Previous sessions on this device are signed out, and message history is decrypted with the backed-up device key.",
  "auth.footer.recover": "Without a backup or the passphrase, no one — including the server — can restore your keys.",
  "auth.footer.default":
    "Device keys live only in this browser. The server cannot decrypt your messages.",

  "error.passwordMismatch": "Passwords do not match.",
  "error.recoverFailed": "The recovery passphrase is wrong or the backup is damaged.",
  "error.backupPassphrase": "The recovery passphrase is incorrect.",
  "error.backupFormat": "The backup format is not valid.",
  "error.usernameTaken": "That username is already taken.",
  "error.unauthorized": "The username or password is incorrect.",
  "error.validation":
    "Please check your input. Usernames are 3-32 characters and passwords at least 10.",
  "error.tooManyRequests": "Too many attempts. Please try again later.",
  "error.deviceRequired": "Could not register this device. Please try again.",
  "error.backupNotFound": "No key backup was found for this account.",
  "error.recoveryUnavailable": "This device cannot be recovered (revoked or unknown).",
  "error.recoveryChallengeInvalid": "The recovery request expired. Please try again.",
  "error.webcrypto":
    "This browser cannot use Web Crypto. Please use a recent browser version.",
  "error.generic": "Something went wrong. Please try again.",
};

export const dictionaries: Record<Locale, Dictionary> = { ko, en };

export function isLocale(value: unknown): value is Locale {
  return value === "ko" || value === "en";
}

/** 저장된 값 → 브라우저 언어 → 기본값 순으로 로케일을 고른다. */
export function detectLocale(stored: string | null, languages: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** `{key}` 변수를 치환한다. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** 사전 조회. 없으면 한국어 → 키 순으로 폴백한다. */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const template = dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
  return interpolate(template, vars);
}

/** 기준(ko) 키 중 해당 로케일에 없는 키 목록(테스트·개발용). */
export function missingKeys(locale: Locale): string[] {
  if (locale === DEFAULT_LOCALE) return [];
  return Object.keys(dictionaries[DEFAULT_LOCALE]).filter((key) => !(key in dictionaries[locale]));
}
