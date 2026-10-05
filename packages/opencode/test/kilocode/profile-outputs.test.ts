import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { outputs, restoreOutputs } from "../../src/kilocode/migration/profile-outputs"

test("tool output codec rejects forged bytes, escaped namespaces and fabricated SQL bindings", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-output-codec-")))
  const item = {
    root,
    name: "tool_123",
    text: "café",
    bytes: 5,
    digest: createHash("sha256").update("café").digest("hex"),
    classification: "orphan",
  }
  expect(() => outputs.parse({ version: 1, files: [{ ...item, digest: "0".repeat(64) }], bindings: [] })).toThrow()
  expect(() => outputs.parse({ version: 1, files: [{ ...item, name: "../escape" }], bindings: [] })).toThrow()
  const ref = {
    table: "part",
    row: "prt_bad",
    session: "ses_bad",
    message: "msg_bad",
    call: "call_bad",
    slot: 0,
    index: 0,
    path: path.join(root, "tool-output", "tool_123"),
    root,
    name: "tool_123",
    state: "present",
  }
  const stage = path.join(root, "unpublished")
  await assert.rejects(
    restoreOutputs(
      outputs.parse({ version: 1, files: [{ ...item, classification: "referenced" }], bindings: [ref] }),
      stage,
      stage,
      [{ table: "session", columns: ["id"], rows: [["ses_bad"]] }],
    ),
    /disagree/,
  )
  expect(await Bun.file(path.join(stage, "restore-outputs.json")).exists()).toBe(false)
})

test("merging injected output namespaces preserves referenced bytes and refuses missing-reference collisions", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-output-conflict-")))
  const other = path.join(root, "injected")
  const item = {
    root,
    name: "tool_123",
    text: "café",
    bytes: 5,
    digest: createHash("sha256").update("café").digest("hex"),
    classification: "referenced",
  }
  const ref = {
    table: "part",
    row: "prt_conflict",
    session: "ses_conflict",
    message: "msg_conflict",
    call: "call_conflict",
    slot: 0,
    index: 0,
    path: path.join(root, "tool-output", "tool_123"),
    root,
    name: "tool_123",
    state: "present",
  }
  function sql(file: string) {
    return [
      { table: "session", columns: ["id"], rows: [["ses_conflict"]] },
      {
        table: "part",
        columns: ["id", "message_id", "session_id", "data"],
        rows: [
          [
            "prt_conflict",
            "msg_conflict",
            "ses_conflict",
            JSON.stringify({
              type: "tool",
              tool: "read",
              callID: "call_conflict",
              state: {
                status: "completed",
                input: {},
                output: "Original prose",
                title: "Read",
                metadata: { truncated: true, outputPath: file },
                time: { start: 1, end: 2 },
              },
            }),
          ],
        ],
      },
    ]
  }
  const stage = path.join(root, "destination")
  const valid = outputs.parse({
    version: 1,
    files: [item, { ...item, root: other, classification: "orphan" }],
    bindings: [ref],
  })
  const rewritten = await restoreOutputs(valid, stage, stage, sql(ref.path))
  expect(await readFile(path.join(stage, "tool-output", item.name), "utf8")).toBe(item.text)
  const table = rewritten.find((table) => table.table === "part")!
  const part = JSON.parse(String(table.rows[0][3]))
  expect(part.state.metadata.outputPath).toBe(path.join(stage, "tool-output", item.name))
  expect(part.state.output).toBe("Original prose")
  const missing = { ...ref, root: other, path: path.join(other, "tool-output", item.name), state: "missing" }
  await assert.rejects(
    restoreOutputs(
      outputs.parse({ version: 1, files: [{ ...item, classification: "orphan" }], bindings: [missing] }),
      path.join(root, "refused"),
      stage,
      sql(missing.path),
    ),
    /collides/,
  )
  expect(await Bun.file(path.join(root, "refused", "restore-outputs.json")).exists()).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "actual V1 and V2 output writers survive held image, encrypted two-hop restore and exact history remapping",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-profile-outputs-")))
    const inherited = { ...process.env }
    for (const key of Object.keys(inherited))
      if (/^(RAYA|KILO|OPENCODE|OTEL|GIT)_|(?:TOKEN|SECRET|API_KEY)$/.test(key)) delete inherited[key]
    for (const mode of ["setup", "writers", "capture"]) {
      const home = path.join(root, mode === "capture" ? "reader" : "producer")
      await mkdir(home, { recursive: true })
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          "--conditions=browser",
          path.join(import.meta.dir, "fixtures/profile-outputs.ts"),
          root,
          mode,
        ],
        {
          cwd: home,
          env: {
            ...inherited,
            HOME: home,
            USERPROFILE: home,
            LOCALAPPDATA: path.join(home, "local"),
            KILO_TEST_HOME: home,
            XDG_DATA_HOME: path.join(home, "data"),
            XDG_CONFIG_HOME: path.join(home, "config"),
            XDG_STATE_HOME: path.join(home, "state"),
            XDG_CACHE_HOME: path.join(home, "cache"),
            RAYA_DB: path.join(home, "unused.db"),
            KILO_DB: path.join(home, "unused.db"),
            RAYA_AUTH_CONTENT: "{}",
            KILO_AUTH_CONTENT: "{}",
            RAYA_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_MODELS_FETCH: "1",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )
      const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
      const timer = setTimeout(() => child.kill(), 55_000)
      const [code, out, err] = await Promise.all([child.exited, ...streams])
      clearTimeout(timer)
      await writeFile(path.join(root, mode + "-stdout.log"), out)
      await writeFile(path.join(root, mode + "-stderr.log"), err)
      await writeFile(path.join(root, mode + "-process.json"), JSON.stringify({ pid: child.pid, code }))
      expect({ root, mode, code, err: err.slice(-2000) }).toMatchObject({ code: 0 })
      assert.throws(() => process.kill(child.pid, 0))
      expect(await readFile(path.join(root, mode + "-stdout.log"), "utf8")).toContain("PROFILE_")
    }
  },
  180_000,
)
