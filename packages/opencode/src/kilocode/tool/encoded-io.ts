import { dirname, extname } from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import {
  batchMutations,
  enabled,
  ensureDirectory,
  inspectFile,
  validateFile,
  writeChecked as checkedWrite,
} from "@kilocode/sandbox"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import * as Encoding from "../encoding"
import * as Bom from "@/util/bom"

/**
 * Encoding-aware file operations routed through the application's filesystem
 * capability so active sandbox profiles apply to tool writes.
 */

const wrap = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

export const read = (fs: FSUtil.Interface, path: string) =>
  Effect.gen(function* () {
    const bytes = yield* fs.readFile(path).pipe(Effect.mapError(wrap))
    const data = Buffer.from(bytes)
    const encoding = Encoding.detect(data)
    return { text: Encoding.decode(data, encoding), encoding, sha256: createHash("sha256").update(data).digest("hex") }
  })

export const identity = (path: string) => inspectFile(path).pipe(Effect.mapError(wrap))

export const validate = (path: string, proof: { readonly dev: string; readonly ino: string }, sha256: string) =>
  validateFile(path, proof, sha256).pipe(Effect.mapError(wrap))

export const write = (fs: FSUtil.Interface, path: string, text: string, encoding: string = Encoding.DEFAULT) =>
  Effect.gen(function* () {
    const data = Encoding.encode(text, encoding)
    if (!(yield* enabled)) return yield* fs.writeWithDirs(path, data)
    return yield* batchMutations(
      Effect.gen(function* () {
        yield* ensureDirectory(fs, dirname(path))
        yield* fs.writeFile(path, data)
      }),
    )
  }).pipe(Effect.mapError(wrap))

export const checked = (
  path: string,
  text: string,
  encoding: string,
  proof: { readonly dev: string; readonly ino: string },
  sha256: string,
) => checkedWrite(path, Encoding.encode(text, encoding), proof, sha256).pipe(Effect.mapError(wrap))

export const stage = (
  fs: FSUtil.Interface,
  path: string,
  text: string,
  encoding: string,
  run: (path: string) => Effect.Effect<boolean>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* fs.makeTempFileScoped({ prefix: "raya-format-", suffix: extname(path) })
      yield* fs.writeFile(temp, Encoding.encode(text, encoding))
      if (!(yield* run(temp))) return Bom.split(text).text
      return (yield* read(fs, temp)).text
    }),
  ).pipe(Effect.mapError(wrap))

export const sync = (fs: FSUtil.Interface, path: string, bom: boolean, encoding: string) =>
  Effect.gen(function* () {
    const current = yield* read(fs, path)
    const target =
      encoding === Encoding.UTF8_BOM && !bom
        ? Encoding.DEFAULT
        : encoding === Encoding.DEFAULT && bom
          ? Encoding.UTF8_BOM
          : encoding
    yield* write(fs, path, Bom.join(current.text, bom), target)
    return current.text
  })
