import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests",
  testMatch: "composer.browser.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5201",
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun tests/fixtures/composer-serve.cjs",
    url: "http://127.0.0.1:5201",
    reuseExistingServer: false,
    timeout: 90_000,
  },
})
