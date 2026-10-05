import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { notes, restoreNotes } from "../../src/kilocode/migration/profile-notes"

test("typed notes reject forged bytes, unsupported sidecar keys and ambiguous mappings before publication", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-notes-validation-")))
  const text = "# Actual plan"
  const markdown = { text, digest: createHash("sha256").update(text).digest("hex") }
  const plan = { scope: "data", root, name: "review.md", markdown }
  expect(() =>
    notes.parse({ version: 1, plans: [{ ...plan, markdown: { ...markdown, digest: "0".repeat(64) } }], reverts: [] }),
  ).toThrow()
  const sidecar = JSON.stringify({ title: "Review", summary: "Summary", steps: [], unknown: "refuse" })
  expect(() =>
    notes.parse({
      version: 1,
      plans: [{ ...plan, sidecar: { text: sidecar, digest: createHash("sha256").update(sidecar).digest("hex") } }],
      reverts: [],
    }),
  ).toThrow()
  const stage = path.join(root, "unpublished")
  const sql = [{ table: "session", columns: ["id", "directory"], rows: [["ses_notes_validation", root]] }]
  await assert.rejects(
    restoreNotes(
      {
        version: 1,
        plans: [],
        reverts: [{ root, session: "ses_notes_validation", files: [path.join(root, "file.txt")] }],
      },
      stage,
      stage,
      new Map(),
      sql,
    ),
    /mapping/,
  )
  expect(await Bun.file(path.join(stage, "restore-notes.json")).exists()).toBe(false)
  const legacy = [{ table: "session", columns: ["id", "directory"], rows: [["ses_notes_validation", ""]] }]
  await assert.rejects(
    restoreNotes(
      { version: 1, plans: [], reverts: [{ root, session: "ses_notes_validation", files: ["relative.txt"] }] },
      stage,
      stage,
      new Map([[root, root]]),
      legacy,
    ),
    /lacks session directory/,
  )
  expect(await Bun.file(path.join(stage, "restore-notes.json")).exists()).toBe(false)
  const other = path.join(root, "other")
  const changed = { text: "# Changed plan", digest: createHash("sha256").update("# Changed plan").digest("hex") }
  await assert.rejects(
    restoreNotes(
      { version: 1, plans: [plan, { ...plan, root: other, markdown: changed }], reverts: [] },
      stage,
      stage,
      new Map(),
      sql,
    ),
    /conflict/,
  )
  expect(await Bun.file(path.join(stage, "restore-notes.json")).exists()).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "actual plan and undo writers survive held image, encrypted inactive restore and explicit reminder consumption",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-profile-notes-")))
    const inherited = { ...process.env }
    for (const key of Object.keys(inherited))
      if (/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|(?:TOKEN|SECRET|API_KEY)$/.test(key)) delete inherited[key]
    for (const mode of ["setup", "source", "read", "reminder"]) {
      const home = path.join(root, mode === "setup" || mode === "source" ? "producer" : "reader")
      await mkdir(home, { recursive: true })
      const destination = mode === "reminder" ? await Bun.file(path.join(root, "restored.json")).json() : undefined
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "--conditions=browser",
          path.join(import.meta.dir, "fixtures/profile-notes.ts"),
          root,
          mode,
        ],
        {
          env: {
            ...inherited,
            HOME: home,
            USERPROFILE: home,
            KILO_TEST_HOME: home,
            LOCALAPPDATA: path.join(home, "local"),
            XDG_DATA_HOME: path.join(home, "data"),
            XDG_CONFIG_HOME: path.join(home, "config"),
            XDG_CACHE_HOME: path.join(home, "cache"),
            XDG_STATE_HOME: path.join(home, "state"),
            RAYA_DB: path.join(root, "producer", "source.db"),
            KILO_DB: path.join(root, "producer", "source.db"),
            RAYA_AUTH_CONTENT: "{}",
            KILO_AUTH_CONTENT: "{}",
            KILO_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_AUTOUPDATE: "1",
            KILO_PURE: "1",
            ...destination?.env,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )
      let forced = false
      const timer = setTimeout(() => {
        forced = true
        child.kill()
      }, 45000)
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        await Bun.write(path.join(root, mode + "-stdout.log"), output)
        await Bun.write(path.join(root, mode + "-stderr.log"), error)
        await Bun.write(path.join(root, mode + "-process.json"), JSON.stringify({ pid: child.pid, code, forced }))
        expect(forced).toBe(false)
        expect(code, `Private evidence retained ${root}: ${error}`).toBe(0)
        expect(output).toContain(mode === "setup" ? "PROFILE_IMPORT_BUNDLE_READY" : "PROFILE_NOTES_OK")
        expect(() => process.kill(child.pid, 0)).toThrow()
      } finally {
        clearTimeout(timer)
      }
    }
  },
  190000,
)
