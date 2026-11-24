import { ApiError, getCsrfToken } from "./api.ts";

/** 업로드 진행률(0~100). total 을 모르면 0. */
export function uploadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

/**
 * 첨부 암호문 업로드(XHR).
 *
 * `fetch` 는 업로드 진행률을 제공하지 않아 XHR 을 쓴다.
 * AbortSignal 로 취소하면 `AbortError` 로 거부된다.
 */
export function uploadAttachment(input: {
  conversationId: string;
  clientMessageId: string;
  body: Blob;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<{ attachment: { id: string; size: number } }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/conversations/${encodeURIComponent(input.conversationId)}/attachments`,
    );
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-attachment-client-message-id", input.clientMessageId);
    const csrf = getCsrfToken();
    if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);

    const onAbort = () => xhr.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      input.signal?.removeEventListener("abort", onAbort);
    };

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !input.onProgress) return;
      input.onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: uploadPercent(event.loaded, event.total),
      });
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError(0, "NETWORK", "업로드에 실패했습니다. 네트워크를 확인해 주세요."));
    };
    xhr.onload = () => {
      cleanup();
      let data: { attachment?: { id: string; size: number }; error?: { code?: string; message?: string } } | null =
        null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.attachment) {
        resolve({ attachment: data.attachment });
        return;
      }
      reject(
        new ApiError(
          xhr.status,
          data?.error?.code ?? "UNKNOWN",
          data?.error?.message ?? `업로드에 실패했습니다 (${xhr.status})`,
        ),
      );
    };

    xhr.send(input.body);
  });
}
