/** 이메일 초대 링크(mailto). 서버가 메일을 보내지 않고 사용자의 메일 클라이언트를 연다. */
export function inviteMailto(link: string, options?: { groupName?: string | null }): string {
  const groupName = options?.groupName?.trim();
  const subject = groupName ? `${groupName} 대화에 초대합니다` : "OneMoments 대화 초대";
  const body = groupName
    ? `OneMoments 에서 "${groupName}" 대화로 초대했습니다.\n\n아래 링크를 열어 참여하세요.\n${link}`
    : `OneMoments 에서 대화를 시작해 보세요.\n\n아래 링크를 열어 시작할 수 있습니다.\n${link}`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** 앱 자체 초대 링크(로그인 화면). */
export function appInviteLink(origin: string): string {
  return `${origin.replace(/\/$/, "")}/`;
}
