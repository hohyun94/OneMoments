import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Alert, Button, Card, Dialog, Input, Label, Spinner } from "./ui.tsx";
import { api } from "../lib/api.ts";
import type { DecoyProfile } from "../types.ts";

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "요청이 실패했습니다.";
}

/**
 * decoy 프로필 관리 패널.
 * 비밀번호 원문은 서버 응답에 포함되지 않으며, 입력값도 화면에 다시 표시하지 않는다.
 */
export function AdminDecoyPanel() {
  const queryClient = useQueryClient();
  const [alias, setAlias] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<DecoyProfile | null>(null);

  const profilesQuery = useQuery({
    queryKey: ["admin", "decoy"],
    queryFn: () =>
      api<{ profiles: DecoyProfile[] }>("/api/admin/decoy").then((response) => response.profiles),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  const create = useMutation({
    mutationFn: () =>
      api<{ profile: DecoyProfile }>("/api/admin/decoy", {
        method: "POST",
        body: {
          alias: alias.trim(),
          ...(handle.trim() ? { handle: handle.trim() } : {}),
          password,
        },
      }),
    onSuccess: () => {
      setAlias("");
      setHandle("");
      setPassword("");
      setFormError(null);
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; disabled: boolean }) =>
      api<{ profile: DecoyProfile }>(`/api/admin/decoy/${input.id}/disabled`, {
        method: "POST",
        body: { disabled: input.disabled },
      }),
    onSuccess: invalidate,
  });

  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    create.mutate();
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
          <KeyRound className="h-4 w-4" aria-hidden />
          decoy 프로필 만들기
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          실제 로그인 ID는 그대로 두고, 별도 비밀번호로 격리된 프로필에 들어갑니다. 비밀번호는
          해시로만 저장되며 이 화면에서 다시 표시되지 않습니다.
        </p>
        <form onSubmit={onCreate} className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="decoy-alias">실제 로그인 ID</Label>
            <Input
              id="decoy-alias"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="alice"
              maxLength={32}
              required
            />
          </div>
          <div>
            <Label htmlFor="decoy-handle">공개 핸들(선택)</Label>
            <Input
              id="decoy-handle"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="decoy_alice"
              maxLength={32}
            />
          </div>
          <div>
            <Label htmlFor="decoy-password">decoy 비밀번호</Label>
            <Input
              id="decoy-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={10}
              maxLength={200}
              required
            />
          </div>
          <div className="flex items-center gap-2 sm:col-span-3">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "만드는 중" : "만들기"}
            </Button>
            {formError ? <span className="text-sm text-red-600">{formError}</span> : null}
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {profilesQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-5 w-5 text-accent-600" />
          </div>
        ) : profilesQuery.isError ? (
          <div className="p-4">
            <Alert variant="error">{errorMessage(profilesQuery.error)}</Alert>
          </div>
        ) : profilesQuery.data && profilesQuery.data.length > 0 ? (
          <ul className="divide-y divide-zinc-100">
            {profilesQuery.data.map((profile) => (
              <li key={profile.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900">@{profile.handle}</p>
                  <p className="text-xs text-zinc-500">
                    alias @{profile.alias} · 생성 {formatDateTime(profile.createdAt)}
                  </p>
                </div>
                <span
                  className={
                    profile.disabledAt
                      ? "rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500"
                      : "rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                  }
                >
                  {profile.disabledAt ? "비활성" : "활성"}
                </span>
                <Button size="sm" variant="outline" onClick={() => setRotateTarget(profile)}>
                  비밀번호 교체
                </Button>
                <Button
                  size="sm"
                  variant={profile.disabledAt ? "outline" : "ghost"}
                  onClick={() =>
                    toggle.mutate({ id: profile.id, disabled: profile.disabledAt === null })
                  }
                  disabled={toggle.isPending}
                >
                  {profile.disabledAt ? "활성화" : "비활성화"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            decoy 프로필이 없습니다.
          </p>
        )}
        {toggle.isError ? (
          <div className="p-4">
            <Alert variant="error">{errorMessage(toggle.error)}</Alert>
          </div>
        ) : null}
      </Card>

      <RotateDecoyDialog
        target={rotateTarget}
        onClose={() => setRotateTarget(null)}
        onSuccess={invalidate}
      />
    </div>
  );
}

function RotateDecoyDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: DecoyProfile | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState("");

  const rotate = useMutation({
    mutationFn: (profileId: string) =>
      api<{ profile: DecoyProfile }>(`/api/admin/decoy/${profileId}/password`, {
        method: "POST",
        body: { password },
      }),
    onSuccess: () => {
      setPassword("");
      onSuccess();
      onClose();
    },
  });

  const close = () => {
    setPassword("");
    onClose();
  };

  return (
    <Dialog open={Boolean(target)} onClose={close} title="decoy 비밀번호 회전">
      <p className="text-sm leading-relaxed text-zinc-600">
        @{target?.alias} 의 decoy 비밀번호를 교체합니다. 기존 decoy 비밀번호는 즉시 무효화됩니다.
      </p>
      <div className="mt-3">
        <Label htmlFor="rotate-decoy-password">새 decoy 비밀번호</Label>
        <Input
          id="rotate-decoy-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={10}
          maxLength={200}
        />
      </div>
      {rotate.isError ? (
        <div className="mt-2">
          <Alert variant="error">{errorMessage(rotate.error)}</Alert>
        </div>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={close}>
          취소
        </Button>
        <Button
          onClick={() => target && rotate.mutate(target.id)}
          disabled={rotate.isPending || password.length < 10}
        >
          {rotate.isPending ? "교체 중" : "교체"}
        </Button>
      </div>
    </Dialog>
  );
}