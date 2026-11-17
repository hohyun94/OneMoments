import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.tsx";
import "./index.css";
import { applyAccent, loadAccent } from "./lib/theme.ts";
import { SessionProvider } from "./session.tsx";

// 첫 렌더 전에 저장된 강조색을 적용해 색이 깜빡이지 않게 한다.
applyAccent(loadAccent(), false);

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
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
