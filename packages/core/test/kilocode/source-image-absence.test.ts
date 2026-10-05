import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { NativeProcess } from "../../src/kilocode/process-host"
import { withImage, assertImage } from "../../src/kilocode/source-offline"
import { plan, negative } from "../../src/kilocode/source-image-plan"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-image-absence-"))
  const data = path.join(root, "workspace")
  await mkdir(data)
  await writeFile(path.join(data, "unchanged.json"), '{"preserved":true}')
  const executable = process.env.RAYA_OFFLINE_TEST_HELPER ?? (await NativeProcess.source())
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex")
  return {
    root,
    data,
    helper: { executable, digest },
    policy: { version: 1 as const, directories: [data], files: [] },
    registry: path.join(root, "registry"),
  }
}
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  )
function acl(file: string) {
  const child = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Acl -LiteralPath '${file.replaceAll("'", "''")}').Sddl`],
    {
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        PSModulePath: path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      },
    },
  )
  if (child.status !== 0) throw new Error("Synthetic namespace ACL observation failed")
  return child.stdout.trim()
}

test.skipIf(process.platform !== "win32")(
  "native namespace preserves missing logical JSON roots, blocks foreign creation and expires negative evidence",
  async () => {
    const cfg = await fixture()
    const roots = [
      { kind: "json" as const, path: path.join(cfg.data, ".kilo", "agent-manager.json") },
      { kind: "json" as const, path: path.join(cfg.data, "unpublished.json") },
    ]
    let held: unknown
    await withImage({ ...cfg, roots }, async (image) => {
      held = image
      const value = assertImage(image, roots)
      expect(value.roots.map((item) => item.original)).toEqual(roots.map((item) => item.path))
      expect(value.roots.map((item) => item.absence?.namespace)).toEqual([cfg.data, cfg.data])
      expect(value.roots[0].absence!.stagedNamespace).not.toBe(value.roots[1].absence!.stagedNamespace)
      expect(value.roots.every((item) => !value.files.some((file) => file.original === item.original))).toBeTrue()
      expect(() => assertImage(JSON.parse(JSON.stringify(image)), roots)).toThrow("expired")
      const script =
        "const fs=require('node:fs');const r=process.argv[1];let blocked=0;try{fs.mkdirSync(r+'/.kilo')}catch{blocked++}try{fs.writeFileSync(r+'/unpublished.json','{}')}catch{blocked++}console.log(blocked);if(blocked!==2)process.exitCode=1"
      const child = Bun.spawn([process.execPath, "-e", script, cfg.data], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()])
      expect(code).toBe(0)
      expect(out.trim()).toBe("2")
      expect(await readdir(value.roots[0].staged)).toEqual([])
      expect(await readdir(value.roots[1].staged)).toEqual([])
      expect(value.files).toEqual([])
    })
    expect(() => assertImage(held, roots)).toThrow("expired")
    expect(await exists(roots[0].path)).toBeFalse()
    expect(await exists(path.dirname(roots[0].path))).toBeFalse()
    expect(await readFile(path.join(cfg.data, "unchanged.json"), "utf8")).toBe('{"preserved":true}')
    await mkdir(path.dirname(roots[0].path))
    await writeFile(roots[0].path, "{}")
    expect(await exists(roots[0].path)).toBeTrue()
  },
)

test.skipIf(process.platform !== "win32")(
  "actual appearance after planning is refused under the subsequently held native namespace",
  async () => {
    const cfg = await fixture()
    const file = path.join(cfg.data, "appeared.json")
    const roots = [{ kind: "json" as const, path: file }]
    const selected = await plan(roots, cfg.policy)
    await writeFile(file, "{}")
    await withImage({ ...cfg, roots: [{ kind: "json", path: cfg.data }] }, async (image) => {
      const value = assertImage(image, [{ kind: "json", path: cfg.data }])
      await assert.rejects(negative(selected.entries[0], value.roots[0].staged), /appeared/)
    })
    expect(await readFile(file, "utf8")).toBe("{}")
  },
)

test.skipIf(process.platform !== "win32")(
  "actual namespace replacement after planning cannot mint negative evidence",
  async () => {
    const cfg = await fixture()
    const selected = await plan([{ kind: "json", path: path.join(cfg.data, "absent.json") }], cfg.policy)
    await rename(cfg.data, cfg.data + "-old")
    await mkdir(cfg.data)
    const roots = [{ kind: "json" as const, path: cfg.data }]
    await withImage({ ...cfg, roots }, async (image) => {
      await assert.rejects(
        negative(selected.entries[0], assertImage(image, roots).roots[0].staged),
        /namespace changed/,
      )
    })
    expect(await exists(path.join(cfg.data, "absent.json"))).toBeFalse()
  },
)

test.skipIf(process.platform !== "win32")(
  "missing JSON exact policy holds parent without capturing its unrelated contents",
  async () => {
    const cfg = await fixture()
    const file = path.join(cfg.data, "absent.json")
    await withImage(
      { ...cfg, roots: [{ kind: "json", path: file }], policy: { version: 1, directories: [], files: [file] } },
      async (image) => {
        const value = assertImage(image, [{ kind: "json", path: file }])
        expect(value.files).toEqual([])
        expect(await readdir(value.roots[0].staged)).toEqual([])
        expect(value.roots[0].original).toBe(file)
        expect(value.roots[0].absence?.namespace).toBe(cfg.data)
        expect(await readFile(path.join(cfg.data, "unchanged.json"), "utf8")).toBe('{"preserved":true}')
      },
    )
    expect(await exists(file)).toBeFalse()
  },
)

test.skipIf(process.platform !== "win32")(
  "captured ancestor deduplicates physical JSON images while preserving exact declared logical roots",
  async () => {
    const cfg = await fixture()
    const nested = path.join(cfg.data, "nested")
    await mkdir(nested)
    await writeFile(path.join(nested, "state.json"), '{"value":1}')
    const roots = [nested, cfg.data, path.join(nested, "state.json")].map((file) => ({
      kind: "json" as const,
      path: file,
    }))
    const selected = await plan(roots, cfg.policy)
    expect(selected.roots).toHaveLength(1)
    await withImage({ ...cfg, roots }, async (image) => {
      const value = assertImage(image, roots)
      expect(value.roots.map((root) => root.original)).toEqual(roots.map((root) => root.path))
      expect(value.roots[0].staged).toBe(path.join(value.roots[1].staged, "nested"))
      expect(value.roots[2].staged).toBe(path.join(value.roots[0].staged, "state.json"))
      expect(value.files).toHaveLength(2)
      expect(await readFile(value.roots[2].staged, "utf8")).toBe('{"value":1}')
    })
  },
)

test.skipIf(process.platform !== "win32")(
  "absent home compatibility roles fence missing ancestors without reading or staging sibling credentials",
  async () => {
    const cfg = await fixture()
    const home = path.join(cfg.root, "private-home")
    await mkdir(home)
    await writeFile(path.join(home, "unrelated-auth.json"), '{"synthetic":"excluded"}')
    const before = acl(home)
    const roots = [path.join(home, ".kilocode"), path.join(home, ".config", "kilo")].map((file) => ({
      kind: "json" as const,
      path: file,
    }))
    const policy = {
      version: 1 as const,
      directories: roots.map((root) => root.path).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      files: [],
    }
    await withImage({ ...cfg, roots, policy }, async (image) => {
      const value = assertImage(image, roots)
      expect(value.files).toHaveLength(0)
      expect(value.roots.every((root) => root.absence?.namespace === home)).toBeTrue()
      expect(await Promise.all(value.roots.map((root) => readdir(root.staged)))).toEqual([[], []])
      await assert.rejects(mkdir(roots[0].path))
      await assert.rejects(mkdir(path.join(home, ".config")))
      await assert.rejects(rename(home, home + "-moved"))
      expect(await readFile(path.join(home, "unrelated-auth.json"), "utf8")).toBe('{"synthetic":"excluded"}')
    })
    expect(await Promise.all(roots.map((root) => exists(root.path)))).toEqual([false, false])
    expect(acl(home)).toBe(before)
    await mkdir(path.join(home, ".config"))
    await mkdir(roots[1].path)
    expect(await exists(roots[1].path)).toBeTrue()
  },
)

test.skipIf(process.platform !== "win32")(
  "hold-only namespace restores exact ACL even when the callback refuses",
  async () => {
    const cfg = await fixture()
    const file = path.join(cfg.data, ".config", "kilo")
    const roots = [{ kind: "json" as const, path: file }]
    const before = acl(cfg.data)
    await assert.rejects(
      withImage({ ...cfg, roots }, async () => {
        throw new Error("Synthetic callback refusal")
      }),
      /Offline image\/rollback refused/,
    )
    expect(acl(cfg.data)).toBe(before)
    expect(await exists(file)).toBeFalse()
    await mkdir(path.dirname(file))
    await mkdir(file)
    expect(await exists(file)).toBeTrue()
  },
)

test.skipIf(process.platform !== "win32")(
  "v2 negative stages preserve independent SQLite WAL and existing positive images",
  async () => {
    const cfg = await fixture()
    const live = path.join(cfg.root, "live.db")
    const db = new Database(live)
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('retained-wal')",
    )
    const file = path.join(cfg.data, "raya.db")
    try {
      for (const suffix of ["", "-wal", "-shm"]) await cp(live + suffix, file + suffix)
    } finally {
      db.close()
    }
    const roots = [
      { kind: "sqlite" as const, path: file },
      { kind: "json" as const, path: path.join(cfg.data, "absent") },
    ]
    await withImage({ ...cfg, roots }, async (image) => {
      const value = assertImage(image, roots)
      expect(value.files.some((entry) => entry.original === file + "-wal")).toBeTrue()
      expect(await readdir(value.roots[1].staged)).toEqual([])
      const read = new Database(value.roots[0].staged, { readonly: true })
      try {
        expect(read.query("SELECT value FROM evidence").get()).toEqual({ value: "retained-wal" })
      } finally {
        read.close()
      }
    })
    expect(await exists(roots[1].path)).toBeFalse()
  },
)
