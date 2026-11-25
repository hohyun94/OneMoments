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

  "nav.contacts": "연락처",
  "nav.moments": "Moments",
  "nav.admin": "관리자 콘솔",
  "nav.devices": "기기 관리",
  "nav.logout": "로그아웃",
  "nav.language": "언어",

  "sidebar.newConversation": "새 대화",
  "sidebar.search.label": "메시지 검색",
  "sidebar.search.placeholder": "메시지 검색 (2자 이상)",
  "sidebar.connection.open": "실시간 연결됨",
  "sidebar.connection.connecting": "실시간 연결 중",
  "sidebar.empty.title": "아직 대화가 없습니다.",
  "sidebar.empty.hint": "사용자 아이디로 새 대화를 시작하세요.",
  "sidebar.pinned": "고정된 대화",
  "sidebar.pin": "대화 고정",
  "sidebar.unpin": "대화 고정 해제",
  "sidebar.pinTitle": "고정",
  "sidebar.unpinTitle": "고정 해제",
  "sidebar.favorite": "즐겨찾기",
  "sidebar.missedCalls": "부재중 전화 {count}건",
  "sidebar.unread": "읽지 않은 메시지 {count}개",
  "sidebar.muted": "알림 꺼짐",
  "sidebar.members": "{count}명",
  "sidebar.direct": "1:1 대화",
  "sidebar.blocked.me": "차단함",
  "sidebar.blocked.peer": "차단됨",
  "sidebar.group": "그룹",
  "sidebar.deletedUser": "삭제된 사용자",
  "sidebar.conversation": "대화",
  "sidebar.saved.button": "저장한 메시지",
  "sidebar.saved.description": "이 기기에만 저장됩니다. 항목을 누르면 원문으로 이동합니다.",
  "sidebar.saved.loading": "불러오는 중…",
  "sidebar.saved.empty":
    "저장한 메시지가 없습니다. 메시지 아래의 북마크 아이콘을 누르면 여기에 모입니다.",
  "sidebar.saved.attachment": "첨부 메시지",
  "sidebar.saved.remove": "저장 취소",

  "chat.empty.select": "대화를 선택하세요",
  "chat.empty.new": "새 대화 시작",

  "newChat.title": "새 대화",
  "newChat.kind.label": "대화 종류",
  "newChat.tab.direct": "1:1",
  "newChat.tab.group": "그룹",
  "newChat.groupName.label": "그룹 이름",
  "newChat.groupName.placeholder": "예: 주말 등산",
  "newChat.username.label": "사용자 아이디",
  "newChat.username.placeholder": "정확한 아이디 입력",
  "newChat.search": "검색",
  "newChat.notFound": "일치하는 사용자가 없습니다.",
  "newChat.result.group": "그룹에 추가할 사용자",
  "newChat.result.direct": "1:1 대화",
  "newChat.add": "추가",
  "newChat.start": "대화 시작",
  "newChat.members": "참여자 {count}명",
  "newChat.maxMembers": "최대 20명",
  "newChat.removeMember": "{name} 제거",
  "newChat.membersEmpty": "아이디를 검색해 참여자를 추가하세요.",
  "newChat.createGroup": "그룹 만들기",
  "newChat.groupNote":
    "그룹 메시지는 참여자 전원의 기기로 각각 암호화되어 전송됩니다. 새로 참여한 사람은 이후 메시지만 읽을 수 있습니다.",
  "newChat.directNote": "상대가 오프라인이어도 메시지는 암호화되어 저장되고, 접속하면 전달됩니다.",
  "error.searchFailed": "검색에 실패했습니다.",
  "error.startConversation": "대화를 시작할 수 없습니다.",
  "error.createGroup": "그룹을 만들 수 없습니다.",

  "invite.invalid": "초대 링크가 올바르지 않습니다.",
  "invite.failed": "초대를 수락하지 못했습니다.",
  "invite.errorTitle": "초대를 열 수 없습니다",
  "invite.back": "대화 목록으로 이동",
  "invite.accepting": "그룹 초대를 수락하는 중…",
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

  "nav.contacts": "Contacts",
  "nav.moments": "Moments",
  "nav.admin": "Admin console",
  "nav.devices": "Devices",
  "nav.logout": "Sign out",
  "nav.language": "Language",

  "sidebar.newConversation": "New chat",
  "sidebar.search.label": "Search messages",
  "sidebar.search.placeholder": "Search messages (2+ characters)",
  "sidebar.connection.open": "Realtime connected",
  "sidebar.connection.connecting": "Connecting realtime",
  "sidebar.empty.title": "No conversations yet.",
  "sidebar.empty.hint": "Start a new chat with a username.",
  "sidebar.pinned": "Pinned chat",
  "sidebar.pin": "Pin chat",
  "sidebar.unpin": "Unpin chat",
  "sidebar.pinTitle": "Pin",
  "sidebar.unpinTitle": "Unpin",
  "sidebar.favorite": "Favorite",
  "sidebar.missedCalls": "{count} missed calls",
  "sidebar.unread": "{count} unread messages",
  "sidebar.muted": "Notifications off",
  "sidebar.members": "{count} members",
  "sidebar.direct": "Direct chat",
  "sidebar.blocked.me": "Blocked",
  "sidebar.blocked.peer": "You are blocked",
  "sidebar.group": "Group",
  "sidebar.deletedUser": "Deleted user",
  "sidebar.conversation": "Chat",
  "sidebar.saved.button": "Saved messages",
  "sidebar.saved.description": "Saved only on this device. Tap an item to jump to it.",
  "sidebar.saved.loading": "Loading…",
  "sidebar.saved.empty":
    "No saved messages yet. Tap the bookmark icon under a message to collect it here.",
  "sidebar.saved.attachment": "Attachment",
  "sidebar.saved.remove": "Remove from saved",

  "chat.empty.select": "Select a conversation",
  "chat.empty.new": "Start a new chat",

  "newChat.title": "New chat",
  "newChat.kind.label": "Chat type",
  "newChat.tab.direct": "1:1",
  "newChat.tab.group": "Group",
  "newChat.groupName.label": "Group name",
  "newChat.groupName.placeholder": "e.g. Weekend hike",
  "newChat.username.label": "Username",
  "newChat.username.placeholder": "Exact username",
  "newChat.search": "Search",
  "newChat.notFound": "No matching user found.",
  "newChat.result.group": "Add to group",
  "newChat.result.direct": "Direct chat",
  "newChat.add": "Add",
  "newChat.start": "Start chat",
  "newChat.members": "{count} participants",
  "newChat.maxMembers": "Up to 20",
  "newChat.removeMember": "Remove {name}",
  "newChat.membersEmpty": "Search a username to add participants.",
  "newChat.createGroup": "Create group",
  "newChat.groupNote":
    "Group messages are encrypted separately for every participant's device. New members can read only messages sent after joining.",
  "newChat.directNote":
    "Messages are encrypted even while the other person is offline, and delivered when they connect.",
  "error.searchFailed": "Search failed.",
  "error.startConversation": "Could not start the chat.",
  "error.createGroup": "Could not create the group.",

  "invite.invalid": "This invite link is not valid.",
  "invite.failed": "Could not accept the invite.",
  "invite.errorTitle": "Unable to open the invite",
  "invite.back": "Go to conversations",
  "invite.accepting": "Accepting the group invite…",
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
