import { KeyRound, Lock, LogOut } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Button, Card, Spinner } from "./components/ui.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { DevicesPage } from "./pages/DevicesPage.tsx";
import { InvitePage } from "./pages/InvitePage.tsx";
import { useSession } from "./session.tsx";

// 관리자 화면은 allowlist 사용자만 진입하므로 일반 사용자 번들에 포함하지 않는다.
const AdminPage = lazy(() =>
  import("./pages/AdminPage.tsx").then((module) => ({ default: module.AdminPage })),
);

// Moments 화면도 필요할 때만 로드한다.
const MomentsPage = lazy(() =>
  import("./pages/MomentsPage.tsx").then((module) => ({
    default: module.MomentsPage,
  })),
);

const ContactsPage = lazy(() =>
  import("./pages/ContactsPage.tsx").then((module) => ({
    default: module.ContactsPage,
  })),
);

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-zinc-50">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-600 text-accent-contrast">
        <Lock className="h-6 w-6" aria-hidden />
      </span>
      <Spinner className="h-5 w-5 text-accent-600" />
    </div>
  );
}

function MissingKeys() {
  const { logout, session } = useSession();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
          <KeyRound className="h-6 w-6" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold text-zinc-900">이 기기의 키가 없습니다</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {session ? `@${session.user.username} ` : ""}
          세션은 남아 있지만 이 브라우저에 기기 키가 없어 메시지를 읽거나 보낼 수 없습니다.
          로그아웃 후 다시 로그인하면 이 기기에 새 키가 만들어집니다(과거 이력은 복호화되지
          않습니다).
        </p>
        <Button className="mt-5 w-full" onClick={() => void logout()}>
          <LogOut className="h-4 w-4" aria-hidden />
          로그아웃하고 다시 로그인
        </Button>
      </Card>
    </div>
  );
}

function Guard({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === "loading") return <Splash />;
  if (status === "anonymous") return <AuthPage />;
  if (status === "missing-keys") return <MissingKeys />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Guard>
            <ChatPage />
          </Guard>
        }
      />
      <Route
        path="/c/:conversationId"
        element={
          <Guard>
            <ChatPage />
          </Guard>
        }
      />
      <Route
        path="/join/:token"
        element={
          <Guard>
            <InvitePage />
          </Guard>
        }
      />
      <Route
        path="/devices"
        element={
          <Guard>
            <DevicesPage />
          </Guard>
        }
      />
      <Route
        path="/moments"
        element={
          <Guard>
            <Suspense fallback={<Splash />}>
              <MomentsPage />
            </Suspense>
          </Guard>
        }
      />
      <Route
        path="/contacts"
        element={
          <Guard>
            <Suspense fallback={<Splash />}>
              <ContactsPage />
            </Suspense>
          </Guard>
        }
      />
      <Route
        path="/admin"
        element={
          <Guard>
            <Suspense fallback={<Splash />}>
              <AdminPage />
            </Suspense>
          </Guard>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
