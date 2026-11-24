import { describe, expect, it } from "vitest";

import { appInviteLink, inviteMailto } from "./inviteMail.ts";

describe("invite mail helpers", () => {
  it("builds a mailto link with the invite URL in the body", () => {
    const mailto = inviteMailto("https://one.example/join/abc", { groupName: "주말 모임" });
    expect(mailto.startsWith("mailto:?subject=")).toBe(true);
    const decoded = decodeURIComponent(mailto);
    expect(decoded).toContain("주말 모임 대화에 초대합니다");
    expect(decoded).toContain("https://one.example/join/abc");
  });

  it("falls back to a generic subject without a group name", () => {
    const decoded = decodeURIComponent(inviteMailto("https://one.example/"));
    expect(decoded).toContain("OneMoments 대화 초대");
    expect(decoded).toContain("OneMoments 에서 대화를 시작해 보세요");
  });

  it("normalizes the app invite link trailing slash", () => {
    expect(appInviteLink("https://one.example")).toBe("https://one.example/");
    expect(appInviteLink("https://one.example/")).toBe("https://one.example/");
  });
});
