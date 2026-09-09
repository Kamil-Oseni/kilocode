import * as fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execute = promisify(execFile)
export async function git(root: string, args: string[]) {
  return (
    await execute(
      "git",
      [
        "-c",
        "core.hooksPath=disabled-fixture-hooks",
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.smudge=",
        "-c",
        "filter.lfs.clean=",
        "-c",
        "filter.lfs.required=false",
        "-C",
        root,
        ...args,
      ],
      {
        windowsHide: true,
        timeout: 15_000,
        encoding: "utf8",
      },
    )
  ).stdout.trim()
}
export async function checkout(directory: string) {
  const root = path.join(path.dirname(directory), "source")
  await fs.mkdir(path.join(root, "packages", "kilo-vscode"), { recursive: true })
  await fs.mkdir(path.join(root, "packages", "opencode"), { recursive: true })
  for (const [file, value] of [
    ["package.json", { name: "@kilocode/kilo" }],
    ["packages/opencode/package.json", { name: "@kilocode/cli" }],
    ["packages/kilo-vscode/package.json", { name: "raya", publisher: "eden" }],
  ] as const)
    await fs.writeFile(path.join(root, file), JSON.stringify(value))
  await fs.writeFile(path.join(root, "tracked.txt"), "committed content\n")
  await git(root, ["init"])
  await git(root, ["config", "core.autocrlf", "false"])
  await git(root, ["add", "."])
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
  return { root: await fs.realpath(root), commit: await git(root, ["rev-parse", "HEAD"]) }
}

export async function lfs(source: { root: string; commit: string }, mode: "cache" | "source" | "missing" | "corrupt") {
  const bytes = Buffer.from("Verified offline LFS fixture\0binary payload\n")
  const oid = createHash("sha256").update(bytes).digest("hex")
  await fs.writeFile(path.join(source.root, ".gitattributes"), "asset.bin filter=lfs diff=lfs merge=lfs -text\n")
  await fs.writeFile(
    path.join(source.root, "asset.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`,
  )
  await git(source.root, ["add", ".gitattributes", "asset.bin"])
  await git(source.root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "LFS pointer",
  ])
  source.commit = await git(source.root, ["rev-parse", "HEAD"])
  for (const key of ["clean", "smudge", "process"])
    await git(source.root, ["config", `filter.lfs.${key}`, "sh -c 'printf ran > .filter-ran; cat'"])
  const file = path.join(source.root, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid)
  if (mode === "cache" || mode === "corrupt") {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, mode === "cache" ? bytes : Buffer.alloc(bytes.length, 1))
  }
  if (mode === "source") await fs.writeFile(path.join(source.root, "asset.bin"), bytes)
  return bytes
}
