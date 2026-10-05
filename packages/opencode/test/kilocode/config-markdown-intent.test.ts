import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { projectMarkdown, markdownDigest } from "@opencode-ai/core/kilocode/config-markdown-schema"
import matter from "gray-matter"

test("Markdown review retains inert Unicode while excluding substituted bodies, credentials and execution fields", () => {
  const value = projectMarkdown(
    "---\ndescription: Helper\npermission: allow\noptions:\n  apiKey: SYNTHETIC_SECRET\n---\nDo {env:SECRET} then !`echo unsafe`",
  )
  expect(value.safe).toEqual({ description: "Helper" })
  expect(value.body).toBe("")
  expect(value.excluded).toEqual([
    { field: "permission", reason: "credential-or-execution" },
    { field: "options", reason: "credential-or-execution" },
    { field: "body", reason: "substitution" },
  ])
  expect(JSON.stringify(value)).not.toContain("SYNTHETIC_SECRET")
  expect(projectMarkdown("---\nmodel: synthetic/local\n---\nCafé 日本語 😀").body).toBe("Café 日本語 😀")
  expect(markdownDigest(value)).toMatch(/^[a-f0-9]{64}$/)
  const raw = "---\ndescription: Cache check\n---\n{env:CACHED_PRIVATE}"
  matter(raw).content = "SYNTHETIC_RESOLVED_CACHED_SECRET"
  expect(projectMarkdown(raw).body).toBe("")
  expect(JSON.stringify(projectMarkdown(raw))).not.toContain("SYNTHETIC_RESOLVED_CACHED_SECRET")
  expect(projectMarkdown("apiKey=SYNTHETIC_LITERAL_KEY")).toEqual({
    safe: {},
    body: "",
    excluded: [{ field: "body", reason: "recognized-credential" }],
  })
  expect(projectMarkdown("---\ndescription: Human text: Unicode café\n---\n日本語 😀").safe.description).toBe(
    "Human text: Unicode café",
  )
})
for (const mode of ["actual", "lifecycle", "overflow"])
  test(`actual Markdown ${mode} loader observes original physical sources and retirement`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-markdown-intent-"))
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(RAYA|KILO|OPENCODE|OTEL)_|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET/.test(key)) delete env[key]
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      KILO_TEST_HOME: root,
      LOCALAPPDATA: path.join(root, "local"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      RAYA_DB: path.join(root, "data/kilo/raya.db"),
      KILO_DB: path.join(root, "data/kilo/raya.db"),
      KILO_AUTH_CONTENT: "{}",
      RAYA_AUTH_CONTENT: "{}",
      RAYA_MARKDOWN_PRIVATE: "SYNTHETIC_EXPANDED_PRIVATE",
    })
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(import.meta.dir, "fixtures/config-markdown-intent.ts"),
        root,
        mode,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env,
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
    }, 30000)
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    await writeFile(path.join(root, "stdout.log"), out)
    await writeFile(path.join(root, "stderr.log"), err)
    expect({ root, code, forced, err: err.slice(-1200) }).toMatchObject({ code: 0, forced: false })
    assert.throws(() => process.kill(child.pid, 0))
    expect(out).toContain("MARKDOWN_INTENT_OK")
  }, 35000)
