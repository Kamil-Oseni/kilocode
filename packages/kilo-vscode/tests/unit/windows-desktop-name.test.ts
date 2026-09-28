import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { decodeDesktopNames, desktopNames } from "../../src/commands/windows-desktop-name"

const value = { version: 1, operation: "desktop-names", host: "Default", input: "Default", interactive: true }

describe("native desktop metadata boundary", () => {
  test("admits only the exact interactive Default response", () => {
    expect(decodeDesktopNames(JSON.stringify(value))).toEqual({ host: "Default", input: "Default" })
    for (const names of [
      { host: null, input: null },
      { host: "Default", input: null },
      { host: "Private", input: "Private" },
      { host: "é雪", input: "Default" },
    ])
      expect(decodeDesktopNames(JSON.stringify({ ...value, ...names, interactive: false }))).toEqual({
        host: names.host ?? undefined,
        input: names.input ?? undefined,
      })
  })

  test("refuses incompatible, malformed, expanded or contradictory replies", () => {
    for (const record of [
      null,
      [],
      { ...value, version: 2 },
      { ...value, operation: "input" },
      { ...value, extra: true },
      { ...value, interactive: false },
      { ...value, host: "Private", interactive: true },
      { ...value, input: 1 },
      { ...value, host: "" },
      { ...value, host: "x".repeat(256), interactive: false },
      { ...value, host: "\ud800", interactive: false },
      { ...value, host: "bad\u0000name", interactive: false },
      { version: 1, operation: "desktop-names", host: "Default", input: "Default" },
    ])
      expect(() => decodeDesktopNames(JSON.stringify(record))).toThrow()
    for (const text of ["", JSON.stringify(value) + "debug", " ".repeat(8_193) + JSON.stringify(value)])
      expect(() => decodeDesktopNames(text)).toThrow()
  })

  test.skipIf(process.platform !== "win32")(
    "reads the actual helper and refuses missing helpers without fallback",
    async () => {
      const path = process.env.RAYA_DESKTOP_NAMES_BINARY ?? join(import.meta.dir, "../../bin/raya-desktop-input.exe")
      const names = await desktopNames(path)
      expect(names.host === undefined || typeof names.host === "string").toBe(true)
      expect(names.input === undefined || typeof names.input === "string").toBe(true)
      await expect(desktopNames(join(import.meta.dir, "nonexistent-desktop-helper.exe"))).rejects.toThrow()
      await expect(desktopNames("raya-desktop-input.exe")).rejects.toThrow(/explicit native/)
    },
  )

  test.skipIf(process.platform !== "win32")(
    "refuses pre-cancelled reads before invoking even a missing helper",
    async () => {
      const controller = new AbortController()
      controller.abort(new Error("metadata cancelled"))
      await expect(
        desktopNames(join(import.meta.dir, "nonexistent-desktop-helper.exe"), controller.signal),
      ).rejects.toThrow(/metadata cancelled/)
    },
  )
})
