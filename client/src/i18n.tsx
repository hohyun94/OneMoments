import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  detectLocale,
  LOCALE_STORAGE_KEY,
  translate,
  type Locale,
} from "./lib/i18n.ts";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function initialLocale(): Locale {
  const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
  const languages =
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  return detectLocale(stored, languages);
}

/**
 * 언어 설정. 저장된 값 → 브라우저 언어 → 한국어 순으로 정하며, 선택은 localStorage 에 남긴다.
 * 번역은 점진 적용이므로 미번역 문자열은 한국어 그대로 노출된다.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // 다른 탭에서 언어를 바꾸면 따라간다.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      setLocaleState(detectLocale(event.newValue, []));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // 저장 실패(사생활 모드 등)해도 이번 세션 동안은 적용한다.
    }
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
