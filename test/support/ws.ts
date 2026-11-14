import { WebSocket } from "ws";

export interface FrameCollector {
  frames: any[];
  next(predicate?: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
}

export function collectFrames(socket: WebSocket): FrameCollector {
  const frames: any[] = [];
  const waiters: Array<{
    predicate: (frame: any) => boolean;
    resolve: (frame: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  socket.on("message", (data) => {
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      frames.splice(frames.indexOf(frame), 1);
      waiter.resolve(frame);
    }
  });

  return {
    frames,
    next(predicate = () => true, timeoutMs = 5_000) {
      const index = frames.findIndex(predicate);
      if (index >= 0) {
        const [frame] = frames.splice(index, 1);
        return Promise.resolve(frame);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(
            waiters.findIndex((waiter) => waiter.timer === timer),
            1,
          );
          reject(new Error(`Timed out waiting for WS frame; received: ${JSON.stringify(frames)}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

export function connect(url: string, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`WebSocket upgrade rejected with ${response.statusCode ?? "unknown"}`));
    });
  });
}

/** open 이벤트를 기다리기 전에 리스너를 붙여 ready 프레임을 놓치지 않는다. */
export async function connectAndCollect(
  url: string,
  cookie: string,
): Promise<{ socket: WebSocket; frames: FrameCollector }> {
  const socket = new WebSocket(url, { headers: { cookie } });
  const frames = collectFrames(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`WebSocket upgrade rejected with ${response.statusCode ?? "unknown"}`));
    });
  });
  return { socket, frames };
}

export function sendFrame(socket: WebSocket, frame: unknown): void {
  socket.send(JSON.stringify(frame));
}

export function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}
