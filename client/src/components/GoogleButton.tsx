import { Button } from "./ui.tsx";

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className="h-4 w-4">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.8 6.1C12.2 13.1 17.6 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24c0-1.6-.1-2.8-.4-4H24v8.5h12.8c-.3 2.1-1.5 4.3-3.4 5.7l7.6 5.9C45.4 35.9 46.5 30.5 46.5 24z"
      />
      <path
        fill="#FBBC05"
        d="M10.3 28.7A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.5 10.8l7.8-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.2 0 11.5-2 15.3-5.6l-7.6-5.9c-2 1.4-4.6 2.3-7.7 2.3-6.4 0-11.8-3.6-13.7-8.8l-7.8 6.1C6.4 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

/** Google OAuth 이동 버튼. 브랜드 가이드에 맞춰 흰 배경 + 로고만 쓴다. */
export function GoogleButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button type="button" variant="outline" className="w-full" onClick={onClick} disabled={disabled}>
      <GoogleMark />
      {label}
    </Button>
  );
}
