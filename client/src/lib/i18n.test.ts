import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  detectLocale,
  dictionaries,
  isLocale,
  LOCALES,
  missingKeys,
  translate,
} from "./i18n.ts";

describe("i18n", () => {
  it("keeps every locale in sync with the base dictionary", () => {
    for (const locale of LOCALES) {
      expect(missingKeys(locale)).toEqual([]);
    }
    // 키 집합이 완전히 같다(추가 키도 없어야 한다).
    const base = Object.keys(dictionaries.ko).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(dictionaries[locale]).sort()).toEqual(base);
    }
  });

  it("detects a locale from storage, then from the browser list", () => {
    expect(detectLocale("en", ["ko-KR"])).toBe("en");
    expect(detectLocale("fr", ["ko-KR", "en-US"])).toBe("ko");
    expect(detectLocale(null, ["en-US"])).toBe("en");
    expect(detectLocale(null, ["de-DE", "en-GB"])).toBe("en");
    expect(detectLocale(null, [])).toBe(DEFAULT_LOCALE);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("jp")).toBe(false);
  });

  it("falls back to Korean and then to the key itself", () => {
    expect(translate("en", "auth.tab.login")).toBe("Sign in");
    expect(translate("en", "missing.key")).toBe("missing.key");
    expect(translate("ko", "missing.key")).toBe("missing.key");
  });

  it("interpolates variables", () => {
    dictionaries.ko["test.greet"] = "안녕 {name}, {count}건";
    try {
      expect(translate("ko", "test.greet", { name: "지수", count: 3 })).toBe(
        "안녕 지수, 3건",
      );
      // 값이 없으면 원문 유지
      expect(translate("ko", "test.greet", { name: "지수" })).toBe("안녕 지수, {count}건");
    } finally {
      delete dictionaries.ko["test.greet"];
    }
  });
});
