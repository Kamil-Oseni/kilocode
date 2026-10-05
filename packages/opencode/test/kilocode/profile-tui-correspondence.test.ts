import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking, type Working } from "../../src/kilocode/migration/profile-image"
import { collectTui, ordinary } from "../../src/kilocode/migration/profile-tui"
import { bindTui, tuiGroups, validateTui, type TuiClaim } from "../../src/kilocode/migration/profile-tui-correspondence"

test.skipIf(process.platform !== "win32")(
  "held TUI state binds safe current preferences without activating consent",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-tui-correspondence-")))
    const data = path.join(root, "data")
    const state = path.join(root, "state")
    const storage = path.join(data, "storage")
    await mkdir(storage, { recursive: true })
    await mkdir(state)
    const file = path.join(state, "kv.json")
    const text = JSON.stringify({ share_consent: true, animations_enabled: false }, null, 2)
    await writeFile(file, text)
    const database = path.join(data, "raya.db")
    const db = new Database(database)
    db.exec("CREATE TABLE evidence(value TEXT)")
    db.close()
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(
      process.env.RAYA_TEST_DIRECTORY_HELPER ??
        path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"),
      helper,
    )
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const policy = { version: 1 as const, directories: [data, state].sort(), files: [] }
    const selected = await select({ database, storage }, policy)
    const selection = {
      ...selected,
      roots: [...selected.roots, { kind: "json" as const, path: state }],
      globals: [
        {
          data,
          state,
          stateParent: state,
          config: data,
          cache: data,
          log: data,
          bin: data,
          repos: data,
          homeKilocode: data,
          homeConfigKilo: data,
        },
      ],
    }
    const saved: { token?: Working; claim?: TuiClaim } = {}
    const capture = (body: (token: Working) => Promise<void>) =>
      withImage(
        {
          roots: selection.roots,
          policy,
          helper: { executable: helper, digest },
          inventory: "directories",
          registry: path.join(root, "registry"),
        },
        (image) => withWorking(image, selection, body),
      )
    await capture(async (token) => {
      const tui = await collectTui(token, [state])
      const claim = await bindTui(token, { tui })
      const entries = tuiGroups(token, claim)
      expect(entries).toHaveLength(1)
      expect(entries[0].text).toBe(text)
      expect(entries[0].activation).toBe("inert")
      expect(ordinary(tui)).toEqual({ animations_enabled: false })
      validateTui(entries[0], { tui })
      assert.throws(() => validateTui({ ...entries[0], digest: "0".repeat(64) }, { tui }), /bytes/)
      assert.throws(() => validateTui(entries[0], { tui: { ...tui, scopes: [] } }), /component/)
      assert.throws(() => tuiGroups(token, { ...claim }), /claim/)
      await assert.rejects(bindTui(token, { tui: { ...tui, scopes: [{ ...tui.scopes[0], state: root }] } }), /Global/)
      await assert.rejects(writeFile(file, "{}"))
      saved.token = token
      saved.claim = claim
    })
    assert(saved.token && saved.claim)
    assert.throws(() => tuiGroups(saved.token!, saved.claim!), /expired|closed|unavailable/)
    await writeFile(file, JSON.stringify({ token: "unrecognized-private-content" }))
    await capture(async (token) => {
      await assert.rejects(collectTui(token, [state]))
    })
  },
  60000,
)
