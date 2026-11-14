import { randomBytes, randomUUID } from "node:crypto";

import { WebSocket } from "ws";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3911";
const messageCount = Number(process.env.MESSAGE_COUNT ?? 100);
const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 10));
const password = "password-12345";

const b64 = (size) => randomBytes(size).toString("base64");

class Client {
  cookies = new Map();
  csrfToken = null;

  get cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(method, path, body, csrf = true) {
    const headers = {};
    if (this.cookieHeader) headers.cookie = this.cookieHeader;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (csrf && this.csrfToken) headers["x-csrf-token"] = this.csrfToken;

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
    const setCookies = getSetCookie
      ? getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")]
        : [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    const text = await response.text();
    let data = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (data?.csrfToken) this.csrfToken = data.csrfToken;
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
    }
    return data;
  }

  async register(prefix) {
    const username = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const data = await this.request(
      "POST",
      "/api/auth/register",
      {
        username,
        password,
        device: {
          name: "load-test",
          identityPublicKey: b64(32),
          signingPublicKey: b64(32),
        },
      },
      false,
    );
    return { username, user: data.user, device: data.device };
  }
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

function frameCollector(socket) {
  const queue = [];
  const waiters = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index === -1) {
      queue.push(frame);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  });
  return {
    next(predicate, timeoutMs = 10_000) {
      const index = queue.findIndex(predicate);
      if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for WS frame")),
          timeoutMs,
        );
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

const alice = new Client();
const bob = new Client();
const aliceAccount = await alice.register("loadalice");
const bobAccount = await bob.register("loadbob");

const conversation = await alice.request("POST", "/api/conversations", {
  peerUserId: bobAccount.user.id,
});
const conversationId = conversation.conversation.id;
const { devices } = await alice.request(
  "GET",
  `/api/conversations/${conversationId}/devices`,
);

const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws`;
const socket = new WebSocket(wsUrl, { headers: { cookie: bob.cookieHeader } });
const frames = frameCollector(socket);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
await frames.next((frame) => frame.type === "ready");
socket.send(JSON.stringify({ type: "subscribe", conversationIds: [conversationId] }));
await frames.next((frame) => frame.type === "subscribed");

const restLatencies = [];
const wsLatencies = [];
const errors = [];
const clients = [alice, bob];
const startedAt = Date.now();

let nextIndex = 0;
async function worker() {
  for (;;) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= messageCount) return;

    const sender = clients[index % 2];
    const clientMessageId = `load-${index}-${randomUUID().slice(0, 8)}`;
    const payload = {
      clientMessageId,
      ciphertext: b64(64),
      nonce: b64(12),
      signature: b64(64),
      keys: devices.map((device) => ({
        deviceId: device.id,
        ephemeralPublicKey: b64(32),
        wrappedKey: b64(48),
        wrapNonce: b64(12),
        version: 1,
      })),
    };

    const sendStarted = performance.now();
    try {
      await sender.request("POST", `/api/conversations/${conversationId}/messages`, payload);
      restLatencies.push(performance.now() - sendStarted);

      await frames.next(
        (frame) =>
          frame.type === "message.created" &&
          frame.message.clientMessageId === clientMessageId,
      );
      wsLatencies.push(performance.now() - sendStarted);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, messageCount) }, () => worker()),
);

const elapsed = (Date.now() - startedAt) / 1000;
const history = await bob.request(
  "GET",
  `/api/conversations/${conversationId}/messages?limit=1`,
);
socket.close();

console.log(
  JSON.stringify(
    {
      conversationId,
      messages: messageCount,
      concurrency,
      errors: errors.length,
      seconds: Number(elapsed.toFixed(2)),
      messagesPerSecond: Number((messageCount / elapsed).toFixed(1)),
      restMs: {
        p50: Number(percentile(restLatencies, 0.5).toFixed(1)),
        p95: Number(percentile(restLatencies, 0.95).toFixed(1)),
      },
      wsDeliveryMs: {
        p50: Number(percentile(wsLatencies, 0.5).toFixed(1)),
        p95: Number(percentile(wsLatencies, 0.95).toFixed(1)),
      },
      latestClientMessageId: history.messages?.[0]?.clientMessageId ?? null,
      firstError: errors[0] ?? null,
    },
    null,
    2,
  ),
);
