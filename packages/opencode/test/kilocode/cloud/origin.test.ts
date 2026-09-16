import { expect, test } from "bun:test"
import { resolveWebAppOrigin } from "@/kilocode/cloud/origin"

test("web-app origin accepts Raya input and retains the Kilo fallback", () => {
  expect(resolveWebAppOrigin({})).toBe("https://kilo.ai")
  expect(resolveWebAppOrigin({ KILO_WEB_APP_URL: "https://legacy.example" })).toBe("https://legacy.example")
  expect(
    resolveWebAppOrigin({
      RAYA_WEB_APP_URL: "https://raya.example",
      KILO_WEB_APP_URL: "https://legacy.example",
    }),
  ).toBe("https://raya.example")
  expect(() =>
    resolveWebAppOrigin({
      RAYA_WEB_APP_URL: "",
      KILO_WEB_APP_URL: "https://legacy.example",
    }),
  ).toThrow("Service URL must")
})
