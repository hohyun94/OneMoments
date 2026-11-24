/** 한 번 보기 메시지 상태 판별. */
export function isViewOnceLocked(input: {
  viewOnce: boolean;
  own: boolean;
  opened: boolean;
}): boolean {
  return input.viewOnce && !input.own && !input.opened;
}

/** 발신자/수신자에게 보여줄 안내 문구. */
export function viewOnceHint(own: boolean): string {
  return own ? "상대가 열면 사라집니다" : "한 번 열면 사라집니다";
}
