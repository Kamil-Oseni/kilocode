import { NativeProcess } from "../../../src/kilocode/process-host"
import { withImage, assertImage, recoverPending } from "../../../src/kilocode/source-offline"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile, rename, readdir, cp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await mkdtemp(path.join(os.tmpdir(), "raya-offline-long-"))
const data = path.join(root, ...Array.from({ length: 7 }, (_, n) => `${n}-source-漢字-${"a".repeat(24)}`))
const registry = path.join(root, ...Array.from({ length: 6 }, (_, n) => `${n}-registry-${"b".repeat(30)}`))
const pack = path.join(data, ".git", "objects", "pack")
await mkdir(pack, { recursive: true })
const file = path.join(pack, `pack-${"c".repeat(40)}.pack`)
const bytes = Buffer.from([0, 255, 13, 10, ...Buffer.from("保持Unicode")])
await writeFile(file, bytes)
const repo = path.join(root, "repo")
await mkdir(repo)
async function git(args: string[]) {
  const child = Bun.spawn(
    ["git", "-c", "core.hooksPath=NUL", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    {
      cwd: repo,
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    },
  )
  if ((await child.exited) !== 0) throw new Error("Private Git fixture failed")
}
await git(["init"])
await writeFile(path.join(repo, "Unicode.txt"), "保持 Git bytes\n")
await git(["add", "Unicode.txt"])
await git(["commit", "-m", "private fixture"])
await git(["repack", "-ad"])
const store = path.join(repo, ".git", "objects", "pack")
const names = await readdir(store)
for (const name of names) await cp(path.join(store, name), path.join(pack, name))
const actual = names.find((name) => name.endsWith(".pack"))
if (!actual) throw new Error("Native Git pack absent")
const packed = await readFile(path.join(pack, actual))
const helper = await NativeProcess.source()
const digest = createHash("sha256")
  .update(await readFile(helper))
  .digest("hex")
const roots = [{ kind: "json" as const, path: data }]
const policy = { version: 1 as const, directories: [data], files: [] }
const result = await withImage({ registry, roots, policy, helper: { executable: helper, digest } }, async (image) => {
  const value = assertImage(image, roots)
  const item = value.files.find((item) => item.original === file)
  if (!item || item.original.length <= 260 || item.staged.length <= 260) throw new Error("Long paths not exercised")
  if (value.files.some((item) => item.original.startsWith("\\\\?\\") || item.staged.startsWith("\\\\?\\")))
    throw new Error("Native spelling leaked into metadata")
  if (!(await readFile(item.staged)).equals(bytes)) throw new Error("Long path bytes differ")
  const gitpack = value.files.find((item) => item.original === path.join(pack, actual))
  if (
    !gitpack ||
    gitpack.original.length <= 260 ||
    gitpack.staged.length <= 260 ||
    !(await readFile(gitpack.staged)).equals(packed)
  )
    throw new Error("Actual long Git pack bytes differ")
  const denied: boolean[] = []
  for (const target of [file, path.join(data, "new.json"), item.staged, path.join(value.roots[0].staged, "new.json")]) {
    await writeFile(target, "wrong").then(
      () => denied.push(false),
      () => denied.push(true),
    )
  }
  await rename(value.roots[0].staged, value.roots[0].staged + "-moved").then(
    () => denied.push(false),
    () => denied.push(true),
  )
  if (denied.some((item) => !item)) throw new Error("Held long namespace accepted mutation")
  return { source: item.original.length, staged: item.staged.length, denied, bytes: true, gitPack: true }
})
if (!(await readFile(file)).equals(bytes)) throw new Error("Source changed after rollback")
await writeFile(path.join(data, "after.json"), "{}")
const recovered = await recoverPending(registry, { executable: helper, digest })
const repeated = await recoverPending(registry, { executable: helper, digest })
console.log(JSON.stringify({ ...result, writable: true, recovered, repeated, portableCaptureAuthorized: false }))
