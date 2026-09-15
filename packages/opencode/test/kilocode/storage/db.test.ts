import { describe, expect, test } from "bun:test"
import path from "path"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Database } from "../../../src/storage/db"
import { tmpdir } from "../../fixture/fixture"

const custom = ["latest", "beta", "prod"].includes(InstallationChannel) ? test.skip : test

describe("kilo channel database paths", () => {
  test("keeps both database clients on the same late-bound override", async () => {
    await using dir = await tmpdir()
    const data = Global.Path.data
    const raya = process.env.RAYA_DB
    const kilo = process.env.KILO_DB
    ;(Global.Path as { data: string }).data = dir.path
    Flag.KILO_DB = "nested/custom.db"

    try {
      const expected = path.join(dir.path, "nested/custom.db")
      expect(Database.getPath({ disableChannelDb: false })).toBe(expected)
      expect(CoreDatabase.path()).toBe(expected)
    } finally {
      ;(Global.Path as { data: string }).data = data
      if (raya === undefined) delete process.env.RAYA_DB
      if (raya !== undefined) process.env.RAYA_DB = raya
      if (kilo === undefined) delete process.env.KILO_DB
      if (kilo !== undefined) process.env.KILO_DB = kilo
    }
  })

  custom("falls back to the old opencode channel database", async () => {
    await using dir = await tmpdir()
    const data = Global.Path.data
    ;(Global.Path as { data: string }).data = dir.path

    try {
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const old = path.join(dir.path, `opencode-${safe}.db`)
      await Bun.write(old, "")

      expect(Database.getChannelPath({ disableChannelDb: false })).toBe(old)
    } finally {
      ;(Global.Path as { data: string }).data = data
    }
  })
})
