import type { Config } from "../config.js";

/**
 * 관리자 권한은 DB 역할이 아니라 ADMIN_USERNAMES allowlist 로만 부여한다.
 * API 로 권한을 얻거나 넓히는 경로가 없다.
 */
export function isAdminUsername(config: Config, username: string): boolean {
  return config.adminUsernames.includes(username.trim().toLowerCase());
}
