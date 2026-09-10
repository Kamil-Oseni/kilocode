import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests",
  testMatch: "task-provenance.browser.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5211",
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun tests/fixtures/task-provenance-serve.cjs",
    url: "http://127.0.0.1:5211",
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
