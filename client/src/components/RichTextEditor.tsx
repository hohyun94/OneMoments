import { Bold, Code, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "./ui.tsx";
import { isDiaryHtmlEmpty, sanitizeDiaryHtml } from "../lib/richTextSanitize.ts";
import { useI18n } from "../i18n.tsx";

/**
 * 일기 작성용 리치 텍스트 에디터(의존성 0, contentEditable).
 *
 * - 서식 결과는 **HTML** 로 돌려주고, 저장 전/렌더 직전에 `sanitizeDiaryHtml` 로 허용 목록 정리.
 * - 외부 에디터 라이브러리를 쓰지 않는다(오프라인·번들 크기·CSP 부담 없음).
 * - 붙여넣기는 서식 없이 텍스트만 넣는다(외부 스타일 유입 차단).
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [empty, setEmpty] = useState(() => isDiaryHtmlEmpty(value));

  // 외부 값(수정 모드 초기값)만 DOM 에 반영한다. 타이핑 중 재설정하면 커서가 튄다.
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    if (element.innerHTML === value) return;
    if (document.activeElement === element) return;
    element.innerHTML = sanitizeDiaryHtml(value);
    setEmpty(isDiaryHtmlEmpty(value));
  }, [value]);

  function emit() {
    const element = editorRef.current;
    if (!element) return;
    const html = sanitizeDiaryHtml(element.innerHTML);
    setEmpty(isDiaryHtmlEmpty(html));
    onChange(html);
  }

  /** 선택 영역에 서식 명령을 적용한다(execCommand 는 여전히 모든 주요 브라우저에서 동작). */
  function format(command: string, arg?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  }

  function addLink() {
    const url = window.prompt(t("diary.editor.linkPrompt"));
    if (!url) return;
    const href = url.trim();
    if (!/^(https?:|mailto:)/i.test(href)) {
      window.alert(t("diary.editor.linkInvalid"));
      return;
    }
    format("createLink", href);
  }

  const tools: Array<{ key: string; label: string; icon: typeof Bold; run: () => void }> = [
    { key: "bold", label: t("diary.editor.bold"), icon: Bold, run: () => format("bold") },
    { key: "italic", label: t("diary.editor.italic"), icon: Italic, run: () => format("italic") },
    {
      key: "underline",
      label: t("diary.editor.underline"),
      icon: Underline,
      run: () => format("underline"),
    },
    {
      key: "strike",
      label: t("diary.editor.strike"),
      icon: Strikethrough,
      run: () => format("strikeThrough"),
    },
    { key: "h2", label: t("diary.editor.heading"), icon: Quote, run: () => format("formatBlock", "h2") },
    {
      key: "quote",
      label: t("diary.editor.quote"),
      icon: Quote,
      run: () => format("formatBlock", "blockquote"),
    },
    {
      key: "ul",
      label: t("diary.editor.bulletList"),
      icon: List,
      run: () => format("insertUnorderedList"),
    },
    {
      key: "ol",
      label: t("diary.editor.numberList"),
      icon: ListOrdered,
      run: () => format("insertOrderedList"),
    },
    { key: "code", label: t("diary.editor.code"), icon: Code, run: () => format("formatBlock", "pre") },
    { key: "link", label: t("diary.editor.link"), icon: Link2, run: addLink },
  ];

  return (
    <div className={cn("rounded-lg border border-zinc-200 bg-white", className)}>
      <div
        role="toolbar"
        aria-label={t("diary.editor.toolbar")}
        className="flex flex-wrap items-center gap-0.5 border-b border-zinc-100 px-1.5 py-1"
      >
        {tools.map((tool) => (
          <button
            key={tool.key}
            type="button"
            title={tool.label}
            aria-label={tool.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={tool.run}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <tool.icon className="h-4 w-4" aria-hidden />
          </button>
        ))}
      </div>
      <div className="relative">
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel ?? t("diary.editor.aria")}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onBlur={emit}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text) document.execCommand("insertText", false, text);
            emit();
          }}
          className="min-h-40 w-full px-3 py-2.5 text-sm leading-relaxed text-zinc-900 outline-none [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-200 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-600 [&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_pre]:rounded-md [&_pre]:bg-zinc-50 [&_pre]:px-2 [&_pre]:py-1.5 [&_pre]:font-mono [&_pre]:text-xs"
        />
        {empty ? (
          <p
            aria-hidden
            className="pointer-events-none absolute left-3 top-2.5 text-sm text-zinc-400"
          >
            {placeholder ?? t("diary.editor.placeholder")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
