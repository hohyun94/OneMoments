/**
 * 클라이언트 암복호화 프로파일링(브라우저와 같은 WebCrypto/DR 코드 사용).
 * 실행: pnpm bench:crypto
 * 환경: BENCH_ITERATIONS(기본 50), BENCH_BACKUP_ITERATIONS(기본 3)
 */
import { performance } from "node:perf_hooks";

import {
  createIdentityWithBackend,
  decryptAttachment,
  decryptMessage,
  detectBackend,
  encryptAttachment,
  encryptMessage,
  exportKeyBackup,
  importKeyBackup,
  type DeviceKeyEnvelope,
  type DeviceIdentity,
} from "../client/src/lib/crypto/index.ts";
import { computeSafetyNumber } from "../client/src/lib/safety.ts";

interface Stats {
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? 0;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    iterations: samples.length,
    meanMs: Number((total / Math.max(1, samples.length)).toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    minMs: Number((sorted[0] ?? 0).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}

async function measure(
  iterations: number,
  task: (index: number) => Promise<void>,
): Promise<Stats> {
  for (let index = 0; index < Math.min(5, iterations); index += 1) {
    await task(index);
  }
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await task(index);
    samples.push(performance.now() - started);
  }
  return stats(samples);
}

function withDevice(identity: DeviceIdentity, deviceId: string): DeviceIdentity {
  return { ...identity, deviceId };
}

const iterations = Math.max(1, Number(process.env.BENCH_ITERATIONS ?? 50));
const backupIterations = Math.max(1, Number(process.env.BENCH_BACKUP_ITERATIONS ?? 3));
const backend = await detectBackend();

const alice = withDevice(await createIdentityWithBackend(backend), "bench-alice");
const bob = withDevice(await createIdentityWithBackend(backend), "bench-bob");
const carol = withDevice(await createIdentityWithBackend(backend), "bench-carol");
const dave = withDevice(await createIdentityWithBackend(backend), "bench-dave");
const conversationId = crypto.randomUUID();
const recipients = [{ deviceId: "bench-bob", identityPublicKey: bob.identityPublicKey }];

const ratchet = await measure(iterations, async (index) => {
  const payload = await encryptMessage({
    identity: alice,
    conversationId,
    clientMessageId: `bench-${index}-${crypto.randomUUID()}`,
    plaintext: "프로파일링 메시지",
    recipients,
  });
  const key = payload.keys[0] as DeviceKeyEnvelope | undefined;
  if (!key) throw new Error("missing envelope");
  await decryptMessage({
    identity: bob,
    message: {
      id: `message-${index}-${crypto.randomUUID()}`,
      conversationId,
      clientMessageId: payload.clientMessageId,
      ciphertext: payload.ciphertext,
      nonce: payload.nonce,
      signature: payload.signature,
      senderDeviceId: "bench-alice",
      senderSigningPublicKey: alice.signingPublicKey,
      key,
    },
  });
});

const attachmentFile = new File(
  [new Uint8Array(1024 * 1024)],
  "benchmark.bin",
  { type: "application/octet-stream" },
);
const encryptedAttachment = await encryptAttachment(attachmentFile);
const attachmentEncrypt = await measure(iterations, async () => {
  await encryptAttachment(attachmentFile);
});
const attachmentDecrypt = await measure(iterations, async () => {
  await decryptAttachment(
    encryptedAttachment.ciphertext,
    encryptedAttachment.key,
    encryptedAttachment.iv,
  );
});

const safetyDevices = [alice, bob, carol, dave].flatMap((identity) => [
  {
    userId: identity.deviceId as string,
    identityPublicKey: identity.identityPublicKey,
    signingPublicKey: identity.signingPublicKey,
  },
]);
const safety = await measure(iterations, async () => {
  await computeSafetyNumber(safetyDevices);
});

const backup = await measure(backupIterations, async () => {
  const blob = await exportKeyBackup(alice, "benchmark-passphrase-123", undefined);
  await importKeyBackup(blob, "benchmark-passphrase-123");
});

console.log(
  JSON.stringify(
    {
      backend,
      iterations,
      message: ratchet,
      attachmentEncrypt,
      attachmentDecrypt,
      safetyNumber: safety,
      keyBackup: backup,
    },
    null,
    2,
  ),
);
