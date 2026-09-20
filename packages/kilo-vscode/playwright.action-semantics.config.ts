import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "action-semantics-web.browser.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5218",
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun tests/fixtures/action-semantics-web-serve.cjs",
    url: "http://127.0.0.1:5218",
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
