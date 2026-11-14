import type { MessageKeyRow, MessageRow } from "../db/schema.js";

export interface MessageEvent {
  conversationId: string;
  message: MessageRow;
  keys: MessageKeyRow[];
}

export type MessageListener = (event: MessageEvent) => void;

/**
 * REST/WS 로 저장된 메시지를 WebSocket 구독자에게 전달하기 위한 얇은 버스.
 * 각 연결은 자기 기기의 키 봉투만 받는다.
 */
export class MessageBus {
  readonly #listeners = new Set<MessageListener>();

  subscribe(listener: MessageListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: MessageEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "message_bus_listener_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }
}
