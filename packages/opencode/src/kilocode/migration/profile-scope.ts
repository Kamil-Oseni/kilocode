import { lstat, realpath, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { scopePaths } from "@opencode-ai/core/kilocode/source-scopes"
import { covers, type SourcePolicy } from "@opencode-ai/core/kilocode/source-policy"

const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
type Root = Readonly<{ kind: "json" | "sqlite"; path: string }>

/** Identity metadata is usable only with authenticated historical roots and physical policy. */
export async function namespaceScopes(raw: unknown, roots: readonly Root[], policy: SourcePolicy, required = true) {
  const { value: scopes, paths, origins } = scopePaths(raw)
  if (required && (scopes.version !== 4 || scopes.configStatus !== "complete" || scopes.globals.length === 0))
    throw new Error("Source export lacks authenticated complete configuration and full Global namespace identities")
  const canonical = async (file: string): Promise<string> =>
    realpath(file).catch(async (err: unknown) => {
      if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT" || path.dirname(file) === file)
        throw err
      return path.join(await canonical(path.dirname(file)), path.basename(file))
    })
  for (const state of paths) {
    if (!covers(policy, state)) throw new Error("Source namespace scope is not a canonical policy directory")
    if (key(await canonical(state)) !== key(state)) throw new Error("Source namespace scope canonical identity changed")
    const info = await lstat(state).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    if (!info && scopes.version === 1) throw new Error("Source state scope is not a canonical policy directory")
    // Absent roles stay declared. The held-image planner must later bind their actual
    // authorized nearest existing namespace; this observation does not grant an image.
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Source namespace scope is not a canonical policy directory")
    }
    if (
      !roots.some((root) => {
        if (root.kind !== "json") return false
        const relative = path.relative(key(root.path), key(state))
        return (
          relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        )
      })
    )
      throw new Error("Source namespace scope lacks authenticated historical ownership")
  }
  if (scopes.version === 3 || scopes.version === 4)
    for (const graph of scopes.configs) {
      if (
        graph.directory &&
        (!covers(policy, graph.directory) || key(await canonical(graph.directory)) !== key(graph.directory))
      )
        throw new Error("Configuration graph directory escapes canonical producer policy")
      for (const document of [...graph.documents, ...("markdown" in graph ? graph.markdown : [])]) {
        if (!covers(policy, document.path) || key(await realpath(document.path)) !== key(document.path))
          throw new Error("Configuration origin escapes canonical producer policy")
        if (
          !roots.some((root) => {
            if (root.kind !== "json") return false
            const relative = path.relative(key(root.path), key(document.path))
            return (
              relative === "" ||
              (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
            )
          })
        )
          throw new Error("Configuration origin lacks authenticated historical ownership")
        const before = await lstat(document.path, { bigint: true })
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1n ||
          before.dev.toString() !== document.identity.dev ||
          before.ino.toString() !== document.identity.ino ||
          before.size !== BigInt(document.bytes)
        )
          throw new Error("Configuration origin physical identity changed")
        const bytes = await readFile(document.path)
        const after = await lstat(document.path, { bigint: true })
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.nlink !== 1n ||
          after.size !== before.size ||
          bytes.length !== document.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== document.digest
        )
          throw new Error("Configuration origin bytes changed after loading")
      }
    }
  return Object.freeze({
    states: Object.freeze(scopes.states.map((state) => Object.freeze({ kind: "json" as const, path: state }))),
    globals: Object.freeze(scopes.version !== 1 ? scopes.globals.map((roles) => Object.freeze(roles)) : []),
    roots: Object.freeze(paths.map((file) => Object.freeze({ kind: "json" as const, path: file }))),
    configs: Object.freeze(scopes.version === 3 || scopes.version === 4 ? scopes.configs : []),
    origins: Object.freeze(origins.map((file) => Object.freeze({ kind: "json" as const, path: file }))),
  })
}

/** Legacy state readers share validation without treating state-only metadata as a full inventory. */
export async function stateScopes(raw: unknown, roots: readonly Root[], policy: SourcePolicy, required = false) {
  return (await namespaceScopes(raw, roots, policy, required)).states
}
