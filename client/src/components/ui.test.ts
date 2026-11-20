import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PasswordInput } from "./ui.tsx";

describe("PasswordInput", () => {
  it("renders a masked input with an accessible visibility toggle", () => {
    const html = renderToStaticMarkup(
      createElement(PasswordInput, {
        id: "password",
        defaultValue: "secret-value",
        autoComplete: "current-password",
      }),
    );

    expect(html).toContain('type="password"');
    expect(html).toContain('id="password"');
    expect(html).toContain('aria-label="비밀번호 표시"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('autoComplete="current-password"');
  });
});
