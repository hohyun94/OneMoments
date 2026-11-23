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
  // "전송 취소 또는 삭제" 버튼과 이름이 겹치지 않도록 정확히 일치시킨다.
  await page.getByRole("button", { name: "전송", exact: true }).click();
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
    await expect(bob.getByLabel(/읽지 않은 메시지/)).toBeVisible();
    await bobConversation.click();
    await expect(bob.getByText(first)).toBeVisible();
    await expect(bob.getByLabel(/읽지 않은 메시지/)).toHaveCount(0);
    // Bob이 대화를 열면 Alice의 발신 메시지에 읽음 표시가 갱신된다.
    await expect(alice.getByText(/· 읽음/).last()).toBeVisible({ timeout: 15_000 });

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
      alice.getByRole("heading", { name: "OneMoments" }),
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
  const erinContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const carol = await carolContext.newPage();
  const dave = await daveContext.newPage();
  const erin = await erinContext.newPage();
  const aliceName = uniqueName("alice");
  const bobName = uniqueName("bob");
  const carolName = uniqueName("carol");
  const daveName = uniqueName("dave");
  const erinName = uniqueName("erin");
  let groupName = `group-${Date.now().toString(36)}`;

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await register(carol, carolName);
    await register(dave, daveName);
    await register(erin, erinName);
    await expect(alice.getByTitle("실시간 연결됨")).toBeVisible();

    await startGroup(alice, groupName, [bobName, carolName]);
    await expect(alice.getByRole("heading", { name: groupName })).toBeVisible();
    await expect(alice.getByText("3명").first()).toBeVisible();

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
    await expect(alice.getByText("4명").first()).toBeVisible();

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

    // 초대 링크로 새 참여자 합류
    await alice.getByRole("button", { name: "그룹 설정" }).click();
    const inviteSettings = alice.getByRole("dialog", { name: "그룹 설정" });
    await inviteSettings.getByRole("button", { name: "초대 링크 만들기" }).click();
    const inviteInput = inviteSettings.getByLabel("그룹 초대 링크");
    await expect(inviteInput).toBeVisible();
    const inviteUrl = await inviteInput.inputValue();
    expect(inviteUrl).toContain("/join/");
    await alice.keyboard.press("Escape");

    await erin.goto(inviteUrl);
    await expect(erin.getByRole("heading", { name: groupName })).toBeVisible();
    await expect(erin.getByText("4명").first()).toBeVisible();
  } finally {
    await aliceContext.close();
    await bobContext.close();
    await carolContext.close();
    await daveContext.close();
    await erinContext.close();
  }
});


test("암호화된 파일 첨부를 보내고 상대가 내려받는다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("alice");
  const bobName = uniqueName("bob");
  const fileName = "첨부-이미지.png";
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice.getByLabel("파일 선택").setInputFiles({
      name: fileName,
      mimeType: "image/png",
      buffer: pngBytes,
    });
    // 원본 파일명이 있으면 편집 필드에 그대로 채워진다.
    await expect(alice.getByLabel("파일 이름")).toHaveValue(fileName);
    await alice.getByLabel("메시지 입력").fill("첨부합니다");
    await alice.getByRole("button", { name: "전송", exact: true }).click();
    await expect(alice.getByText("첨부합니다")).toBeVisible();
    const aliceImage = alice.getByRole("img", { name: fileName });
    await expect(aliceImage).toBeVisible();
    expect(await aliceImage.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByText("첨부합니다")).toBeVisible();
    const bobImage = bob.getByRole("img", { name: fileName });
    await expect(bobImage).toBeVisible();
    expect(await bobImage.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

    const downloadPromise = bob.waitForEvent("download");
    await bob.getByRole("button", { name: "다운로드" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = await download.path();

    expect(downloadPath).not.toBeNull();
    expect((await readFile(downloadPath as string)).equals(pngBytes)).toBe(true);

    // 서버 DB에는 파일 이름/내용이 없고, 저장 파일도 암호문이어야 한다.
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string; message_id: string | null }>(
        "select id, message_id from attachments order by created_at desc limit 1",
      );
      expect(rows).toHaveLength(1);
      const attachmentId = rows[0]?.id;
      if (!attachmentId) throw new Error("missing attachment row");
      expect(rows[0]?.message_id).toBeTruthy();

      const stored = await readFile(`data/attachments/${attachmentId}.bin`);
      expect(stored.equals(pngBytes)).toBe(false);

      const messages = await client.query<{ ciphertext: string }>(
        "select ciphertext from messages",
      );
      for (const row of messages.rows) {
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

test("브라우저 임시 파일명은 기본 이름으로 바꾸고 사용자가 수정할 수 있다", async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const aliceName = uniqueName("tmpname");
  const bobName = uniqueName("tmppeer");
  const tempName = "tmp_f870a5a7-aca3-4996-8270-4a1fde29c829.png";
  const editedName = "정리한-사진.png";
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice.getByLabel("파일 선택").setInputFiles({
      name: tempName,
      mimeType: "image/png",
      buffer: pngBytes,
    });
    const nameInput = alice.getByLabel("파일 이름");
    await expect(nameInput).toHaveValue(/^첨부-\d{8}-\d{4}\.png$/);
    await expect(
      alice.getByText("브라우저가 원본 파일명을 제공하지 않았습니다. 보낼 이름을 입력해 주세요."),
    ).toBeVisible();

    await nameInput.fill(editedName);
    await alice.getByRole("button", { name: "전송", exact: true }).click();
    await expect(alice.getByText(editedName)).toBeVisible();

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByText(editedName)).toBeVisible();

    const downloadPromise = bob.waitForEvent("download");
    await bob.getByRole("button", { name: "다운로드" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(editedName);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("여러 파일을 한 번에 첨부해 각각 메시지로 전송한다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("multi");
  const bobName = uniqueName("multipeer");
  const first = "여러개-1.png";
  const second = "여러개-2.png";
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice.getByLabel("파일 선택").setInputFiles([
      { name: first, mimeType: "image/png", buffer: pngBytes },
      { name: second, mimeType: "image/png", buffer: pngBytes },
    ]);
    await expect(alice.getByLabel("파일 이름 1")).toHaveValue(first);
    await expect(alice.getByLabel("파일 이름 2")).toHaveValue(second);
    await expect(
      alice.getByText("첨부 2개 · 파일마다 별도 메시지로 전송됩니다."),
    ).toBeVisible();

    await alice.getByLabel("메시지 입력").fill("두 장");
    await alice.getByRole("button", { name: "전송", exact: true }).click();
    await expect(alice.getByRole("img", { name: first })).toBeVisible();
    await expect(alice.getByRole("img", { name: second })).toBeVisible();

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByRole("img", { name: first })).toBeVisible();
    await expect(bob.getByRole("img", { name: second })).toBeVisible();
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("굵게·코드·링크 서식을 렌더링한다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("rich");
  const bobName = uniqueName("richpeer");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice
      .getByLabel("메시지 입력")
      .fill("**중요** `npm test` https://example.com");
    // 서식 버튼(B/코드)은 메신저 사용성 검토로 제거하고 마크다운 직접 입력만 지원한다.
    await expect(alice.getByRole("button", { name: "굵게" })).toHaveCount(0);
    await expect(alice.getByRole("button", { name: "코드" })).toHaveCount(0);
    await alice.getByRole("button", { name: "전송", exact: true }).click();

    await expect(alice.locator("strong", { hasText: "중요" })).toBeVisible();
    await expect(alice.locator("code", { hasText: "npm test" })).toBeVisible();
    const aliceLink = alice.getByRole("link", { name: "https://example.com" });
    await expect(aliceLink).toHaveAttribute("href", "https://example.com");
    await expect(aliceLink).toHaveAttribute("target", "_blank");
    await expect(aliceLink).toHaveAttribute("rel", /noopener/);

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.locator("strong", { hasText: "중요" })).toBeVisible();
    await expect(bob.getByRole("link", { name: "https://example.com" })).toBeVisible();
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("음성 첨부를 보내면 오디오 플레이어로 표시된다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("voice");
  const bobName = uniqueName("voicepeer");
  const fileName = "음성-테스트.webm";
  // 실제 재생 가능한 오디오는 아니지만, 복호화·렌더 경로를 검증하기에 충분한 바이트.
  const audioBytes = Buffer.from(new Uint8Array(256));

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice.getByLabel("파일 선택").setInputFiles({
      name: fileName,
      mimeType: "audio/webm",
      buffer: audioBytes,
    });
    await expect(alice.getByLabel("파일 이름")).toHaveValue(fileName);
    await alice.getByRole("button", { name: "전송", exact: true }).click();

    await expect(alice.locator("audio")).toHaveCount(1);

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.locator("audio")).toHaveCount(1);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("이모지 반응 개수가 읽기 좋은 크기로 표시된다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("react");
  const bobName = uniqueName("reactpeer");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice.getByLabel("메시지 입력").fill("반응 확인");
    await alice.getByRole("button", { name: "전송", exact: true }).click();
    await expect(alice.getByText("반응 확인")).toBeVisible();

    await alice.getByRole("button", { name: "반응", exact: true }).click();
    await alice.getByRole("button", { name: "👍 반응" }).click();

    const chip = alice.getByRole("button", { name: "👍 1", exact: true });
    await expect(chip).toBeVisible();

    // 이모지는 18px 이상, 개수 글자는 12px 이상이어야 한다(2026-11 조정).
    const sizes = await chip.locator("span").evaluateAll((nodes) =>
      nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    );
    expect(sizes[0]).toBeGreaterThanOrEqual(18);
    expect(sizes[1]).toBeGreaterThanOrEqual(12);

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByRole("button", { name: "👍 1", exact: true })).toBeVisible();
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("로그인 화면 배경이 다크/라이트 테마를 따른다", async ({ browser }) => {
  async function measure(colorScheme: "dark" | "light") {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    try {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "OneMoments" })).toBeVisible();
      const isDark = await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      const image = await page
        .getByTestId("auth-backdrop")
        .evaluate((node) => getComputedStyle(node).backgroundImage);
      return { isDark, image };
    } finally {
      await context.close();
    }
  }

  const dark = await measure("dark");
  expect(dark.isDark).toBe(true);
  // 다크에서는 흰색/밝은 회색 그라디언트가 남아 있으면 안 된다.
  expect(dark.image).not.toContain("255, 255, 255");
  expect(dark.image).not.toContain("250, 250, 250");

  const light = await measure("light");
  expect(light.isDark).toBe(false);
  expect(light.image).toContain("255, 255, 255");
});

test("음성 메시지를 녹음하면 파형이 표시된다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("record");
  const bobName = uniqueName("recordpeer");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await startConversation(alice, bobName);

    await alice.getByRole("button", { name: "음성 녹음" }).click();
    await expect(alice.getByText(/녹음 중/)).toBeVisible();
    await alice.waitForTimeout(1_500);
    await alice.getByRole("button", { name: "완료" }).click();
    await expect(alice.getByLabel("파일 이름")).toHaveValue(/^음성-\d{8}-\d{4}\.webm$/);

    await alice.getByRole("button", { name: "전송", exact: true }).click();
    await expect(alice.getByTestId("waveform")).toBeVisible();

    // 복호화한 Blob 오디오가 실제로 재생되는지 확인한다(CSP media-src 회귀 방지).
    async function expectPlayable(page: Page): Promise<void> {
      const audio = page.locator("audio").first();
      await expect(audio).toHaveCount(1);
      // 네이티브 <audio controls> 대신 컴팩트 커스텀 컨트롤을 쓴다.
      expect(await audio.getAttribute("controls")).toBeNull();
      const download = page.getByRole("button", { name: "다운로드" }).first();
      await expect(download).toBeVisible();
      // 다운로드는 아이콘만(텍스트 없이) 표시한다.
      expect((await download.innerText()).trim()).toBe("");

      const duration = await audio.evaluate(async (node: HTMLAudioElement) => {
        if (node.readyState < 1) {
          await new Promise<void>((resolve) => {
            node.addEventListener("loadedmetadata", () => resolve(), { once: true });
            window.setTimeout(() => resolve(), 5_000);
          });
        }
        return node.duration;
      });
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThan(0);

      // 카드가 컴팩트한지(이전 네이티브 플레이어 대비 절반 수준) 확인한다.
      const card = page.getByTestId("voice-card").first();
      const box = await card.boundingBox();
      expect(box?.height ?? 0).toBeLessThan(90);
      // 음성 카드에는 파일명을 표시하지 않는다(다운로드 파일명으로만 사용).
      await expect(card).not.toContainText(/음성-\d{8}-\d{4}\.webm/);
      await expect(card.getByText(/\d+:\d{2} \/ \d+:\d{2}/)).toBeVisible();

      await page.getByRole("button", { name: "재생" }).first().click();
      await expect(page.getByRole("button", { name: "일시정지" }).first()).toBeVisible();
      await expect
        .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);
      await page.getByRole("button", { name: "일시정지" }).first().click();
      await expect
        .poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused))
        .toBe(true);
    }

    await expectPlayable(alice);

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 25_000 });
    await bobConversation.click();
    await expect(bob.getByTestId("waveform")).toBeVisible();
    await expectPlayable(bob);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("Google 가입·로그인으로 계정을 만들고 다시 로그인한다", async ({ browser }) => {
  const username = uniqueName("guser");
  const signupContext = await browser.newContext();
  const signup = await signupContext.newPage();
  try {
    await signup.goto("/");
    await signup.getByRole("button", { name: "가입", exact: true }).click();
    await signup.getByRole("button", { name: "Google로 가입" }).click();
    // 스텁 IdP → 서버 콜백 → `/oauth/callback` 의 아이디 선택 단계
    await expect(signup.getByRole("heading", { name: "아이디 선택" })).toBeVisible({
      timeout: 25_000,
    });
    await signup.getByLabel("아이디").fill(username);
    await signup.getByRole("button", { name: "가입 완료" }).click();
    await expect(signup.getByRole("navigation", { name: "대화 목록" })).toBeVisible({
      timeout: 25_000,
    });

    await signup.goto("/devices");
    await expect(signup.getByText("현재 Google 계정이 연결되어 있습니다.")).toBeVisible();
  } finally {
    await signupContext.close();
  }

  // 같은 Google 계정으로 새 브라우저에서 로그인한다(기기 키는 새로 생성).
  const loginContext = await browser.newContext();
  const login = await loginContext.newPage();
  try {
    await login.goto("/");
    await login.getByRole("button", { name: "Google로 로그인" }).click();
    await expect(login.getByRole("navigation", { name: "대화 목록" })).toBeVisible({
      timeout: 25_000,
    });
  } finally {
    await loginContext.close();
  }
});

test("1:1 음성 통화: 발신 → 수락 → 음소거 → 종료", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("caller");
  const bobName = uniqueName("callee");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    // 양쪽 실시간 연결이 맺어진 뒤에 발신한다(벨은 대화를 열지 않아도 도착해야 한다).
    await expect(alice.getByTitle("실시간 연결됨")).toBeVisible();
    await expect(bob.getByTitle("실시간 연결됨")).toBeVisible();

    // 채팅 화면이 아닌 곳(기기 관리)에서도 수신 벨이 떠야 한다.
    await bob.goto("/devices");
    await expect(bob.getByRole("heading", { name: "기기 관리" })).toBeVisible();

    await startConversation(alice, bobName);
    await expect(alice.getByLabel("메시지 입력")).toBeVisible();

    await alice.getByRole("button", { name: "음성 통화" }).click();
    await expect(alice.getByTestId("call-status")).toHaveText(/발신 중/);

    // 수신 벨 → 수락
    await expect(bob.getByRole("dialog", { name: "수신 전화" })).toBeVisible({
      timeout: 25_000,
    });
    await bob.getByRole("button", { name: "수락", exact: true }).click();

    // WebRTC 연결이 완료되어야만 "통화 중" 으로 바뀐다.
    await expect(alice.getByTestId("call-status")).toHaveText(/통화 중/, { timeout: 25_000 });
    await expect(bob.getByTestId("call-status")).toHaveText(/통화 중/, { timeout: 25_000 });

    // 음소거 토글
    await alice.getByRole("button", { name: "음소거", exact: true }).click();
    await expect(alice.getByRole("button", { name: "음소거 해제" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(alice.getByTestId("call-status")).toHaveText(/통화 중 · 0:0/);

    // 종료하면 상대에게 안내가 남고, 잠시 뒤 오버레이가 사라진다.
    await alice.getByRole("button", { name: "통화 종료" }).click();
    await expect(bob.getByTestId("call-status")).toHaveText(/상대가 통화를 종료했습니다/, {
      timeout: 15_000,
    });
    await expect(alice.getByTestId("call-overlay")).toBeHidden({ timeout: 15_000 });

    // 통화 기록(메타데이터만)이 남는다.
    await alice.waitForTimeout(800);
    await alice.getByRole("button", { name: "통화 기록" }).click();
    const history = alice.getByRole("dialog", { name: "통화 기록" });
    await expect(history.getByText("발신 통화")).toBeVisible();
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("1:1 영상 통화: 발신 → 수락 → 카메라 끄기 → 종료", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("videocaller");
  const bobName = uniqueName("videocallee");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await expect(alice.getByTitle("실시간 연결됨")).toBeVisible();
    await expect(bob.getByTitle("실시간 연결됨")).toBeVisible();
    await startConversation(alice, bobName);

    await alice.getByRole("button", { name: "영상 통화" }).click();
    await expect(alice.getByTestId("call-status")).toHaveText(/영상 통화 발신 중/);

    await expect(bob.getByRole("dialog", { name: "수신 전화" })).toBeVisible({
      timeout: 25_000,
    });
    await expect(bob.getByTestId("call-status")).toHaveText(/영상 통화/);
    await bob.getByRole("button", { name: "수락", exact: true }).click();

    // 양쪽 모두 영상 패널이 뜨고 원격 영상이 실제로 재생된다(가짜 카메라).
    await expect(alice.getByTestId("remote-video")).toBeVisible({ timeout: 25_000 });
    await expect(bob.getByTestId("remote-video")).toBeVisible({ timeout: 25_000 });
    await expect(alice.getByTestId("call-status")).toHaveText(/통화 중/, { timeout: 25_000 });
    await expect
      .poll(
        async () =>
          await alice
            .getByTestId("remote-video")
            .evaluate((node) => (node as HTMLVideoElement).videoWidth),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // 카메라 끄기/켜기
    await alice.getByRole("button", { name: "카메라 끄기" }).click();
    await expect(alice.getByRole("button", { name: "카메라 켜기" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await alice.getByRole("button", { name: "통화 종료" }).click();
    await expect(bob.getByTestId("call-status")).toHaveText(/상대가 통화를 종료했습니다/, {
      timeout: 15_000,
    });
    await expect(bob.getByRole("dialog", { name: "수신 전화" })).toHaveCount(0);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("부재중 전화 배지가 생기고 대화를 열면 사라진다", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceName = uniqueName("missed");
  const bobName = uniqueName("missedpeer");

  try {
    await register(alice, aliceName);
    await register(bob, bobName);
    await expect(alice.getByTitle("실시간 연결됨")).toBeVisible();
    await expect(bob.getByTitle("실시간 연결됨")).toBeVisible();
    await startConversation(alice, bobName);

    await alice.getByRole("button", { name: "음성 통화" }).click();
    await expect(bob.getByRole("dialog", { name: "수신 전화" })).toBeVisible({
      timeout: 25_000,
    });
    // 받지 않고 발신자가 취소 → 수신자에게 부재중으로 남는다.
    await alice.getByRole("button", { name: "통화 취소" }).click();
    await expect(bob.getByTestId("call-status")).toHaveText(/취소/, { timeout: 15_000 });

    const bobList = bob.getByRole("navigation", { name: "대화 목록" });
    const badge = bobList.getByLabel(/부재중 전화 1건/);
    await expect(badge).toBeVisible({ timeout: 15_000 });

    const bobConversation = bobList.getByRole("button", { name: new RegExp(aliceName) });
    await expect(bobConversation).toBeVisible({ timeout: 15_000 });
    await bobConversation.click();
    await expect(bob.getByLabel("메시지 입력")).toBeVisible();
    await expect(badge).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test("auto-logout: 무활동 5분 후 로그인 화면으로 전환한다", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const name = uniqueName("idle");
  try {
    await page.clock.install();
    await register(page, name);
    await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();

    await page.clock.fastForward(5 * 60 * 1000 + 5_000);
    await expect(page.getByRole("button", { name: "로그인" }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: "로그아웃" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("offline: 오프라인 앱 셸과 서비스 워커 캐시 버전을 검증한다", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cacheNames = await page.evaluate(() => caches.keys());
  expect(cacheNames).toContain("onemoments-static-v3");
  const cachedPaths = await page.evaluate(async () => {
    const cache = await caches.open("onemoments-static-v3");
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(cachedPaths).toContain("/");
  expect(cachedPaths.some((path) => path.startsWith("/assets/"))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "OneMoments" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "로그인" }).last(),
  ).toBeVisible();
});

