import { describe, expect, test } from "bun:test"
import path from "node:path"
import { channel, resolve } from "@opencode-ai/core/kilocode/database-path"

describe("database compatibility path", () => {
  test("preserves stable, disabled and sanitized channel filenames", () => {
    const data = path.join("root", "data")
    for (const name of ["latest", "beta", "prod"])
      expect(channel({ data, channel: name, disabled: false, exists: () => false })).toBe(path.join(data, "kilo.db"))
    expect(channel({ data, channel: "preview", disabled: true, exists: () => false })).toBe(path.join(data, "kilo.db"))
    expect(channel({ data, channel: "feature/name:one", disabled: false, exists: () => false })).toBe(
      path.join(data, "kilo-feature-name-one.db"),
    )
  })

  test("uses the old channel file only when the new file is absent", () => {
    const data = path.join("root", "data")
    const next = path.join(data, "kilo-dev.db")
    const prev = path.join(data, "opencode-dev.db")
    const seen: string[] = []
    const exists = (file: string) => {
      seen.push(file)
      return file === prev
    }
    expect(channel({ data, channel: "dev", disabled: false, exists })).toBe(prev)
    expect(seen).toEqual([next, prev])

    seen.length = 0
    const both = (file: string) => {
      seen.push(file)
      return file === next || file === prev
    }
    expect(channel({ data, channel: "dev", disabled: false, exists: both })).toBe(next)
    expect(seen).toEqual([next])
  })

  test("resolves memory, absolute and relative overrides without filesystem reads", () => {
    const data = path.resolve("profile")
    const absolute = path.resolve("external.db")
    const input = { data, channel: "dev", disabled: false, exists: () => false }
    expect(resolve({ ...input, override: ":memory:" })).toBe(":memory:")
    expect(resolve({ ...input, override: absolute })).toBe(absolute)
    expect(resolve({ ...input, override: "custom.db" })).toBe(path.join(data, "custom.db"))
  })

  test("does not mutate its inputs", () => {
    const input = {
      data: path.join("root", "data"),
      channel: "feature/name",
      disabled: false,
      override: undefined,
      exists: () => false,
    }
    const before = { ...input }
    resolve(input)
    expect(input).toEqual(before)
  })
})
