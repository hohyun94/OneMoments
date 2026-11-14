import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
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

async function startGroup(page: Page, name: string, members: string[]): Promise<void> {
  await page.getByRole("button", { name: "새 대화", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 대화" });
  await dialog.getByRole("tab", { name: "그룹" }).click();
  await dialog.getByLabel("그룹 이름").fill(name);
  for (const member of members) {
    await dialog.getByLabel("사용자 아이디").fill(member);
    await dialog.getByRole("button", { name: "검색" }).click();
    await expect(dialog.getByText(`@${member}`)).toBeVisible();
    await dialog.getByRole("button", { name: "추가", exact: true }).click();
  }
  await dialog.getByRole("button", { name: "그룹 만들기" }).click();
  await expect(page.getByLabel("메시지 입력")).toBeVisible();
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

    // 대화별 알림 음소거 토글
    await alice.getByRole("button", { name: "대화 알림 끄기" }).click();
    await expect(alice.getByRole("button", { name: "대화 알림 켜기" })).toBeVisible();
    await alice.getByRole("button", { name: "대화 알림 켜기" }).click();
    await expect(alice.getByRole("button", { name: "대화 알림 끄기" })).toBeVisible();

    // 안전번호: 60자리(5자리 × 12그룹)
    await alice.getByRole("button", { name: "안전번호" }).click();
    const safetyDialog = alice.getByRole("dialog", { name: "안전번호" });
    await expect(safetyDialog.getByTestId("safety-number")).toBeVisible();
    const digits = (await safetyDialog.getByTestId("safety-number").innerText()).replace(
      /\s/g,
      "",
    );
    expect(digits).toMatch(/^\d{60}$/);
    await safetyDialog.getByRole("button", { name: "닫기" }).click();

    // 새로고침 후에도 IndexedDB의 기기 키로 이력이 복호화된다.
    await alice.reload();
    await expect(alice.getByText(first)).toBeVisible();
    await expect(alice.getByText(reply)).toBeVisible();

    // 기기 목록에는 현재 기기 하나만 있어야 한다.
    await alice.getByRole("button", { name: "기기 관리" }).click();
    await expect(alice.getByRole("heading", { name: "기기 관리" })).toBeVisible();
    await expect(alice.getByText("현재 기기")).toHaveCount(1);
    await expect(alice.getByRole("heading", { name: "알림" })).toBeVisible();
    await expect(alice.getByRole("button", { name: "알림 켜기" })).toBeVisible();
    expect((await alice.request.get("/manifest.webmanifest")).ok()).toBe(true);
    expect((await alice.request.get("/sw.js")).ok()).toBe(true);

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

test("계정 삭제 후 상대 이력은 유지되고 익명화된다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("alice");
  const bobName = uniqueName("bob");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await expect(alice.getByTitle("실시간 연결됨")).toBeVisible();
    await startConversation(alice, bobName);

    const text = "삭제 후에도 남는 메시지";
    await sendMessage(alice, text);

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByText(text)).toBeVisible();

    // Alice 계정 삭제(익명화)
    await alice.getByRole("button", { name: "기기 관리" }).click();
    await alice.getByRole("button", { name: "계정 삭제", exact: true }).click();
    const deleteDialog = alice.getByRole("dialog", { name: "계정 삭제" });
    await deleteDialog.getByLabel("비밀번호 확인").fill(PASSWORD);
    await deleteDialog.getByRole("button", { name: "계정 삭제" }).click();
    await expect(
      alice.getByText("두 사람만 읽을 수 있는 1:1 암호화 메신저"),
    ).toBeVisible();

    // Bob: 이력은 유지되고 발신자는 "삭제된 사용자"로 표시된다.
    await bob.reload();
    await expect(bob.getByText(text)).toBeVisible();
    const reloadedList = bob.getByRole("navigation", { name: "대화 목록" });
    const deletedPeer = reloadedList.getByRole("button", { name: /삭제된 사용자/ });
    await expect(deletedPeer).toBeVisible();
    await deletedPeer.click();
    await expect(bob.getByText("이 사용자는 계정을 삭제했습니다.")).toBeVisible();
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("키 백업으로 새 브라우저에서 기기와 이력을 복구한다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("alice");
  const bobName = uniqueName("bob");
  const recoveryPassphrase = "recovery-passphrase-12345";
  let recoveredContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    const text = "백업으로 복구할 메시지";
    await sendMessage(alice, text);
    await expect(alice.getByText(text)).toBeVisible();

    // 상대의 답장(DR v2)까지 받은 뒤 백업해야 이력 키도 함께 저장된다.
    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByText(text)).toBeVisible();
    const reply = "백업 전에 받은 답장";
    await sendMessage(bob, reply);
    await expect(alice.getByText(reply)).toBeVisible();

    // 이 기기 키와 DR 세션/이력 키를 복구 암호로 백업한다.
    await alice.getByRole("button", { name: "기기 관리" }).click();
    await alice.getByLabel("복구 암호", { exact: true }).fill(recoveryPassphrase);
    await alice.getByLabel("복구 암호 확인").fill(recoveryPassphrase);
    await alice.getByRole("button", { name: "백업 저장" }).click();
    await expect(alice.getByText(/백업이 저장되었습니다/)).toBeVisible();

    // 완전히 새 브라우저(빈 저장소)에서 복구한다.
    recoveredContext = await browser.newContext();
    const recovered = await recoveredContext.newPage();
    await recovered.goto("/");
    await recovered.getByRole("button", { name: "복구", exact: true }).click();
    await recovered.getByLabel("아이디").fill(aliceName);
    await recovered.getByLabel("복구 암호").fill(recoveryPassphrase);
    await recovered.getByRole("button", { name: "백업으로 복구" }).click();

    await expect(recovered.getByText(`@${aliceName}`)).toBeVisible();
    const list = recovered.getByRole("navigation", { name: "대화 목록" });
    const conversation = list.getByRole("button", { name: new RegExp(bobName) });
    await expect(conversation).toBeVisible();
    await conversation.click();
    await expect(recovered.getByText(text)).toBeVisible();
    await expect(recovered.getByText(reply)).toBeVisible();

    await recovered.getByRole("button", { name: "기기 관리" }).click();
    await expect(recovered.getByText("현재 기기")).toHaveCount(1);
  } finally {
    if (recoveredContext) await recoveredContext.close();
    await aliceContext.close();
    await bobContext.close();
  }
});

test("그룹 대화를 만들고 참여자 전원이 메시지를 주고받는다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const carolContext = await browser.newContext();
  const daveContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const carol = await carolContext.newPage();
  const dave = await daveContext.newPage();
  const aliceName = uniqueName("alice");
  const bobName = uniqueName("bob");
  const carolName = uniqueName("carol");
  const daveName = uniqueName("dave");
  let groupName = `group-${Date.now().toString(36)}`;

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await register(carol, carolName);
    await register(dave, daveName);
    await expect(alice.getByTitle("실시간 연결됨")).toBeVisible();

    await startGroup(alice, groupName, [bobName, carolName]);
    await expect(alice.getByRole("heading", { name: groupName })).toBeVisible();
    await expect(alice.getByText("3명 · 종단간 암호화").first()).toBeVisible();

    // 그룹 이름 변경
    await alice.getByRole("button", { name: "그룹 설정" }).click();
    const settingsDialog = alice.getByRole("dialog", { name: "그룹 설정" });
    const renamedGroup = `${groupName}-renamed`;
    await settingsDialog.getByLabel("그룹 이름").fill(renamedGroup);
    await settingsDialog.getByRole("button", { name: "이름 저장" }).click();
    await expect(alice.getByRole("heading", { name: renamedGroup })).toBeVisible();
    groupName = renamedGroup;

    const first = "그룹 첫 메시지";
    await sendMessage(alice, first);
    await expect(alice.getByText(first)).toBeVisible();

    // 새 참여자는 다음 목록 갱신 전에 새로고침으로 즉시 확인한다.
    await bob.reload();
    const bobGroup = bob
      .getByRole("navigation", { name: "대화 목록" })
      .getByRole("button", { name: new RegExp(groupName) });
    await expect(bobGroup).toBeVisible();
    await bobGroup.click();
    await expect(bob.getByRole("heading", { name: groupName })).toBeVisible();
    await expect(bob.getByText(first)).toBeVisible();

    const reply = "그룹 답장";
    await sendMessage(bob, reply);
    await expect(alice.getByText(reply)).toBeVisible();
    // 그룹 메시지에는 발신자 이름이 표시된다.
    await expect(alice.getByText(bobName)).toBeVisible();

    await carol.reload();
    const carolGroup = carol
      .getByRole("navigation", { name: "대화 목록" })
      .getByRole("button", { name: new RegExp(groupName) });
    await expect(carolGroup).toBeVisible();
    await carolGroup.click();
    await expect(carol.getByText(first)).toBeVisible();
    await expect(carol.getByText(reply)).toBeVisible();

    const safetyButton = carol.getByRole("button", { name: "안전번호" });
    await expect(safetyButton).toBeEnabled();
    await safetyButton.click();
    const safetyDialog = carol.getByRole("dialog", { name: "안전번호" });
    const digits = (await safetyDialog.getByTestId("safety-number").innerText()).replace(
      /\s/g,
      "",
    );
    expect(digits).toMatch(/^\d{60}$/);

    // 그룹 참여자 추가: 새 참여자는 이후 메시지만 볼 수 있다.
    await alice.getByRole("button", { name: "참여자 추가" }).click();
    const membersDialog = alice.getByRole("dialog", { name: "참여자 추가" });
    await membersDialog.getByLabel("사용자 아이디").fill(daveName);
    await membersDialog.getByRole("button", { name: "검색" }).click();
    await expect(membersDialog.getByText(`@${daveName}`)).toBeVisible();
    await membersDialog.getByRole("button", { name: "추가", exact: true }).click();
    await membersDialog.getByRole("button", { name: "참여자 추가하기" }).click();
    await expect(alice.getByText("4명 · 종단간 암호화").first()).toBeVisible();

    await dave.reload();
    const daveGroup = dave
      .getByRole("navigation", { name: "대화 목록" })
      .getByRole("button", { name: new RegExp(groupName) });
    await expect(daveGroup).toBeVisible();
    await daveGroup.click();
    await expect(dave.getByText("첫 메시지를 보내보세요.")).toBeVisible();
    await expect(dave.getByTitle("실시간 연결됨")).toBeVisible();

    const welcome = "새 참여자 환영";
    await sendMessage(alice, welcome);
    await expect(dave.getByText(welcome)).toBeVisible();

    // 새 참여자가 그룹을 나가면 목록에서 사라진다.
    await dave.getByRole("button", { name: "그룹 설정" }).click();
    const daveSettings = dave.getByRole("dialog", { name: "그룹 설정" });
    await daveSettings.getByRole("button", { name: "그룹 나가기" }).click();
    await daveSettings.getByRole("button", { name: "정말 나가기" }).click();
    await expect(
      dave
        .getByRole("navigation", { name: "대화 목록" })
        .getByRole("button", { name: new RegExp(groupName) }),
    ).toHaveCount(0);
  } finally {
    await aliceContext.close();
    await bobContext.close();
    await carolContext.close();
    await daveContext.close();
  }
});


test("암호화된 파일 첨부를 보내고 상대가 내려받는다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("alice");
  const bobName = uniqueName("bob");
  const fileName = "첨부-메모.txt";
  const content = "파일 첨부 E2E 비밀 내용";

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice.getByLabel("파일 선택").setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(content, "utf8"),
    });
    await expect(alice.getByText(fileName)).toBeVisible();
    await alice.getByLabel("메시지 입력").fill("첨부합니다");
    await alice.getByRole("button", { name: "전송" }).click();
    await expect(alice.getByText("첨부합니다")).toBeVisible();
    await expect(alice.getByText(fileName)).toBeVisible();

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByText("첨부합니다")).toBeVisible();
    await expect(bob.getByText(fileName)).toBeVisible();

    const downloadPromise = bob.waitForEvent("download");
    await bob.getByRole("button", { name: "다운로드" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(await readFile(downloadPath as string, "utf8")).toBe(content);

    // 서버 DB에는 파일 이름/내용이 없고, 저장 파일도 암호문이어야 한다.
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        "select id from attachments order by created_at desc limit 1",
      );
      expect(rows).toHaveLength(1);
      const attachmentId = rows[0]?.id;
      if (!attachmentId) throw new Error("missing attachment row");

      const stored = await readFile(`data/attachments/${attachmentId}.bin`);
      expect(stored.toString("utf8")).not.toContain(content);

      const messages = await client.query<{ ciphertext: string }>(
        "select ciphertext from messages",
      );
      for (const row of messages.rows) {
        expect(row.ciphertext).not.toContain(content);
        expect(row.ciphertext).not.toContain(fileName);
      }
    } finally {
      await client.end();
    }
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
