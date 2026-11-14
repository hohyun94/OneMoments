import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3931);
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://onemoments:onemoments@127.0.0.1:55432/onemoments_e2e";

// 테스트 코드에서도 같은 DB를 검증할 수 있게 노출한다.
process.env.E2E_DATABASE_URL = DATABASE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "node e2e/start-server.mjs",
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "production",
      PORT: String(PORT),
      DATABASE_URL,
      SESSION_SECRET: "e2e-session-secret-0123456789abcdef0123",
      COOKIE_SECURE: "false",
      CORS_ORIGINS: `http://127.0.0.1:${PORT}`,
      TRUST_PROXY: "0",
    },
  },
});
