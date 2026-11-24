import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.tsx";
import "./index.css";
import { I18nProvider } from "./i18n.tsx";
import { THEME_STORAGE_KEY, applyTheme, loadTheme } from "./lib/theme.ts";
import { SessionProvider } from "./session.tsx";

// 첫 렌더 전에 저장된 테마를 적용해 색이 깜빡이지 않게 한다.
applyTheme(loadTheme(), { persist: false });

// 시스템 모드일 때 OS 설정 변경을 따라간다.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const current = loadTheme();
  if (current.mode === "system") applyTheme(current, { persist: false });
});

// 같은 브라우저의 다른 탭에서 바뀐 테마를 반영한다.
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) applyTheme(loadTheme(), { persist: false });
});

// 설치형 PWA/오프라인 앱 셸: HTTPS(localhost 포함)에서만 등록된다. 실패해도 앱 사용에는 영향이 없다.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("root element is missing");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter>
          <SessionProvider>
            <App />
          </SessionProvider>
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
