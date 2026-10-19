import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "run-review.browser.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5211",
    browserName: "chromium",
    timezoneId: "America/Toronto",
    locale: "en-US",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun tests/fixtures/run-review-serve.cjs",
    url: "http://127.0.0.1:5211",
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
