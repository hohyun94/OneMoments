import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const PASSWORD = "password-12345";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://onemoments:onemoments@127.0.0.1:55432/onemoments_e2e";

function uniqueName(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

async function register(page: Page, username: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "가입", exact: true }).click();
  await page.getByLabel("아이디").fill(username);
  await page.getByLabel("비밀번호", { exact: true }).fill(PASSWORD);
  await page.getByLabel("비밀번호 확인").fill(PASSWORD);
  await page.getByRole("button", { name: "가입하고 시작하기" }).click();
  await expect(page.getByText(`@${username}`)).toBeVisible();
}

async function startConversation(page: Page, peerUsername: string): Promise<void> {
  await page.getByRole("button", { name: "새 대화", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 대화" });
  await dialog.getByLabel("사용자 아이디").fill(peerUsername);
  await dialog.getByRole("button", { name: "검색" }).click();
  await expect(dialog.getByText(`@${peerUsername}`)).toBeVisible();
  await dialog.getByRole("button", { name: "대화 시작" }).click();
  await expect(page.getByLabel("메시지 입력")).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel("메시지 입력").fill(text);
  await page.getByRole("button", { name: "전송" }).click();
}

test("두 브라우저가 종단간 암호화 메시지를 주고받고 키가 유지된다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("alice");
  const bobName = uniqueName("bob");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);

    // 실시간 연결이 맺어진 뒤 Alice가 대화를 시작한다.
    await expect(bob.getByTitle("실시간 연결됨")).toBeVisible();
    await startConversation(alice, bobName);

    const first = "안녕하세요, 종단간 암호화!";
    await sendMessage(alice, first);
    await expect(alice.getByText(first)).toBeVisible();

    // Bob은 구독 전이어도 대화 목록이 즉시 갱신되고, 열면 복호화된다.
    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByText(first)).toBeVisible();

    const reply = "잘 도착했어요!";
    await sendMessage(bob, reply);
    await expect(alice.getByText(reply)).toBeVisible();

    // 새로고침 후에도 IndexedDB의 기기 키로 이력이 복호화된다.
    await alice.reload();
    await expect(alice.getByText(first)).toBeVisible();
    await expect(alice.getByText(reply)).toBeVisible();

    // 기기 목록에는 현재 기기 하나만 있어야 한다.
    await alice.getByRole("button", { name: "기기 관리" }).click();
    await expect(alice.getByRole("heading", { name: "기기 관리" })).toBeVisible();
    await expect(alice.getByText("현재 기기")).toHaveCount(1);

    // 서버 DB에는 암호문만 있어야 한다.
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ ciphertext: string }>(
        "select ciphertext from messages",
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.ciphertext).not.toContain(first);
        expect(row.ciphertext).not.toContain(reply);
      }
    } finally {
      await client.end();
    }
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
