import { Download, X } from "lucide-react";
import { useEffect } from "react";

import { cn } from "./ui.tsx";
import { useI18n } from "../i18n.tsx";

/**
 * 복호화된 이미지를 화면 가득 보여주는 라이트박스.
 *
 * blob URL 은 호출측(첨부 카드)이 관리하고, 닫기는 Esc·배경 클릭·버튼 모두 지원한다.
 */
export function ImageLightbox({
  src,
  name,
  onClose,
  onDownload,
  downloading = false,
}: {
  src: string;
  name: string;
  onClose: () => void;
  onDownload?: () => void;
  downloading?: boolean;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // 뒤 화면 스크롤을 잠근다.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("lightbox.open")}
      data-testid="image-lightbox"
      className="fixed inset-0 z-[60] flex flex-col bg-black/95 p-3"
      onClick={onClose}
    >
      <div className="flex items-center justify-end gap-2">
        {onDownload ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
            disabled={downloading}
            aria-label={t("msg.download")}
            title={t("msg.download")}
            className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-50"
          >
            <Download className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          aria-label={t("lightbox.close")}
          title={t("lightbox.close")}
          className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <img
          src={src}
          alt={name}
          onClick={(event) => event.stopPropagation()}
          className={cn("max-h-full max-w-full object-contain")}
        />
      </div>
    </div>
  );
}
