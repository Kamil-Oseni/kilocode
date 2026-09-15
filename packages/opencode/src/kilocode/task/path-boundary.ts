import path from "node:path"
import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

export namespace RayaPath {
  const find: (fs: FSUtil.Interface, file: string, tail?: string) => Effect.Effect<string> = Effect.fn(
    "RayaPath.find",
  )(function* (fs: FSUtil.Interface, file: string, tail = "") {
    const found = yield* fs.realPath(file).pipe(Effect.option)
    if (Option.isSome(found)) return path.join(found.value, tail)
    const parent = path.dirname(file)
    if (parent === file) return path.join(file, tail)
    return yield* find(fs, parent, path.join(path.basename(file), tail))
  })

  export const canonical = Effect.fn("RayaPath.canonical")(function* (fs: FSUtil.Interface, file: string) {
    const target = yield* find(fs, path.resolve(file))
    return process.platform === "win32" ? FSUtil.normalizePath(target) : path.normalize(target)
  })

  export const check = Effect.fn("RayaPath.check")(function* (fs: FSUtil.Interface, file: string, expected: string) {
    if ((yield* canonical(fs, file)) === expected) return
    yield* Effect.fail(new Error("File target changed after approval."))
  })

  export function patterns(worktree: string, files: readonly string[]) {
    return [...new Set(files.map((file) => path.relative(worktree, file).replaceAll("\\", "/")))]
  }
}
