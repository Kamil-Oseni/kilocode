import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "admin.browser.ts",
  workers: 1,
  reporter: "list",
  preserveOutput: "always",
  use: {
    baseURL: "http://127.0.0.1:5208",
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun tests/fixtures/admin-serve.cjs",
    url: "http://127.0.0.1:5208",
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
