import { RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  applyServiceWorkerUpdate,
  initServiceWorkerUpdates,
  subscribeServiceWorkerUpdate,
} from "../lib/swUpdate.ts";
import { Button } from "./ui.tsx";

/** 새 배포를 감지했을 때 하단에 표시하는 새로고침 배너. */
export function UpdatePrompt() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    initServiceWorkerUpdates();
    return subscribeServiceWorkerUpdate(setAvailable);
  }, []);

  if (!available || dismissed) return null;

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-zinc-200 bg-white/95 px-4 py-2 text-sm shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
        <span className="text-zinc-700 dark:text-zinc-200">새 버전이 있습니다.</span>
        <Button type="button" size="sm" onClick={applyServiceWorkerUpdate}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          새로고침
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="새 버전 알림 닫기"
          className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
