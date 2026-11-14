import { WebSocket } from "ws";

import type { ServerFrame } from "../types/protocol.js";

export interface ChatConnection {
  readonly socket: WebSocket;
  readonly userId: string;
  readonly deviceId: string;
  readonly conversations: Set<string>;
}

/**
 * 연결·대화 구독·접속 상태를 프로세스 메모리에서 관리한다.
 * 다중 인스턴스는 sticky session 또는 Redis 팬아웃이 필요하다(M4).
 */
export class ChatHub {
  readonly #connections = new Map<WebSocket, ChatConnection>();
  readonly #conversationConnections = new Map<string, Set<ChatConnection>>();
  /** conversationId → userId → 연결 수 */
  readonly #presence = new Map<string, Map<string, number>>();

  add(socket: WebSocket, userId: string, deviceId: string): ChatConnection {
    const connection: ChatConnection = { socket, userId, deviceId, conversations: new Set() };
    this.#connections.set(socket, connection);
    return connection;
  }

  get(socket: WebSocket): ChatConnection | undefined {
    return this.#connections.get(socket);
  }

  subscribe(connection: ChatConnection, conversationIds: string[]): string[] {
    const joined: string[] = [];
    for (const conversationId of conversationIds) {
      if (connection.conversations.has(conversationId)) continue;
      connection.conversations.add(conversationId);

      let members = this.#conversationConnections.get(conversationId);
      if (!members) {
        members = new Set();
        this.#conversationConnections.set(conversationId, members);
      }
      members.add(connection);

      const users = this.#presence.get(conversationId) ?? new Map<string, number>();
      this.#presence.set(conversationId, users);
      const count = (users.get(connection.userId) ?? 0) + 1;
      users.set(connection.userId, count);
      if (count === 1) {
        this.broadcast(
          conversationId,
          {
            type: "presence",
            conversationId,
            userId: connection.userId,
            state: "online",
          },
          connection.socket,
        );
      }
      joined.push(conversationId);
    }
    return joined;
  }

  unsubscribe(connection: ChatConnection, conversationIds: string[]): string[] {
    const left: string[] = [];
    for (const conversationId of conversationIds) {
      if (!connection.conversations.delete(conversationId)) continue;
      this.#detach(connection, conversationId);
      left.push(conversationId);
    }
    return left;
  }

  #detach(connection: ChatConnection, conversationId: string): void {
    const members = this.#conversationConnections.get(conversationId);
    members?.delete(connection);
    if (members && members.size === 0) this.#conversationConnections.delete(conversationId);

    const users = this.#presence.get(conversationId);
    if (!users) return;
    const count = (users.get(connection.userId) ?? 1) - 1;
    if (count <= 0) {
      users.delete(connection.userId);
      if (users.size === 0) this.#presence.delete(conversationId);
      this.broadcast(
        conversationId,
        {
          type: "presence",
          conversationId,
          userId: connection.userId,
          state: "offline",
        },
        connection.socket,
      );
      return;
    }
    users.set(connection.userId, count);
  }

  remove(socket: WebSocket): void {
    const connection = this.#connections.get(socket);
    if (!connection) return;
    for (const conversationId of [...connection.conversations]) {
      connection.conversations.delete(conversationId);
      this.#detach(connection, conversationId);
    }
    this.#connections.delete(socket);
  }

  connectionsFor(conversationId: string): Iterable<ChatConnection> {
    return this.#conversationConnections.get(conversationId) ?? [];
  }

  broadcast(conversationId: string, frame: ServerFrame, except?: WebSocket): void {
    const members = this.#conversationConnections.get(conversationId);
    if (!members || members.size === 0) return;
    const payload = JSON.stringify(frame);
    for (const connection of members) {
      if (connection.socket === except) continue;
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.send(payload);
      }
    }
  }

  send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  get size(): number {
    return this.#connections.size;
  }

  closeAll(): void {
    for (const connection of this.#connections.values()) {
      try {
        connection.socket.close(1001, "Server shutting down");
      } catch {
        connection.socket.terminate();
      }
    }
    this.#connections.clear();
    this.#conversationConnections.clear();
    this.#presence.clear();
  }
}
