import * as fs from "node:fs/promises"
import * as path from "node:path"
import { exec } from "../util/process"
import { createGitExecutable } from "../util/git-executable"

export type Source = { root: string; commit: string }
const binary = createGitExecutable()
const setup = "Set raya.selfHeal.sourcePath to the absolute root of Raya's Git checkout."
const identities = [
  ["package.json", "@kilocode/kilo"],
  ["packages/opencode/package.json", "@kilocode/cli"],
  ["packages/kilo-vscode/package.json", "raya"],
] as const

function same(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function manifest(raw: string, name: string) {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object" || !("name" in value) || value.name !== name) return false
  return name !== "raya" || ("publisher" in value && value.publisher === "eden")
}

export async function resolve(input: {
  configured: string
  extension: string
}): Promise<{ ok: true; source: Source } | { ok: false; reason: string }> {
  const configured = input.configured.trim()
  const candidate =
    configured ||
    (() => {
      const ext = path.normalize(input.extension)
      if (path.basename(ext) !== "kilo-vscode" || path.basename(path.dirname(ext)) !== "packages") return
      return path.resolve(ext, "../..")
    })()
  if (!candidate) return { ok: false, reason: `No Raya source checkout is configured. ${setup}` }
  if (!path.isAbsolute(candidate)) return { ok: false, reason: `The Raya source path must be absolute. ${setup}` }
  try {
    const root = await fs.realpath(candidate)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")))
    const git = async (args: string[]) =>
      (
        await exec(await binary(), ["--no-pager", "-C", root, ...args], {
          cwd: root,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        })
      ).stdout.trim()
    const top = await fs.realpath(await git(["rev-parse", "--show-toplevel"]))
    if (!same(root, top))
      return { ok: false, reason: `The Raya source path must identify the Git repository root. ${setup}` }
    const commit = await git(["rev-parse", "--verify", "HEAD^{commit}"])
    if (!/^[0-9a-f]{40,64}$/.test(commit))
      return { ok: false, reason: `The Raya checkout has no supported source commit. ${setup}` }
    const matches = await Promise.all(
      identities.map(async ([file, name]) => {
        const target = await fs.realpath(path.join(root, file))
        const relative = path.relative(root, target)
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false
        const stat = await fs.stat(target)
        if (!stat.isFile() || stat.size > 1024 * 1024) return false
        const [working, committed] = await Promise.all([
          fs.readFile(target, "utf8"),
          git(["show", `${commit}:${file}`]),
        ])
        return manifest(working, name) && manifest(committed, name)
      }),
    )
    if (!matches.every(Boolean))
      return { ok: false, reason: `The selected Git checkout does not identify Raya's source packages. ${setup}` }
    if ((await git(["rev-parse", "--verify", "HEAD^{commit}"])) !== commit) {
      return {
        ok: false,
        reason: "The Raya source revision changed during verification. Retry after repository operations finish.",
      }
    }
    return { ok: true, source: { root, commit } }
  } catch {
    return {
      ok: false,
      reason: `The Raya source checkout could not be verified. Check that Git, the path, and a committed Raya source revision are available. ${setup}`,
    }
  }
}

export async function current(source: Source, input = { configured: source.root, extension: "" }) {
  const result = await resolve(input)
  return result.ok && same(result.source.root, source.root) && result.source.commit === source.commit
}
