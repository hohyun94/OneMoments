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
  readonly #userConnections = new Map<string, Set<ChatConnection>>();
  /** conversationId → userId → 연결 수 */
  readonly #presence = new Map<string, Map<string, number>>();

  add(socket: WebSocket, userId: string, deviceId: string): ChatConnection {
    const connection: ChatConnection = { socket, userId, deviceId, conversations: new Set() };
    this.#connections.set(socket, connection);
    const userConnections = this.#userConnections.get(userId) ?? new Set<ChatConnection>();
    userConnections.add(connection);
    this.#userConnections.set(userId, userConnections);
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
    const userConnections = this.#userConnections.get(connection.userId);
    userConnections?.delete(connection);
    if (userConnections && userConnections.size === 0) {
      this.#userConnections.delete(connection.userId);
    }
    this.#connections.delete(socket);
  }

  /** 구독 여부와 무관하게 사용자에게 연결된 모든 기기(대화 목록 갱신용). */
  connectionsForUsers(userIds: Iterable<string>): Iterable<ChatConnection> {
    const result = new Set<ChatConnection>();
    for (const userId of userIds) {
      for (const connection of this.#userConnections.get(userId) ?? []) {
        result.add(connection);
      }
    }
    return result;
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
    this.#userConnections.clear();
    this.#presence.clear();
  }
}
