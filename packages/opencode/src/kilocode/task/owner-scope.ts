import path from "node:path"
import { Effect, Schema } from "effect"
import { Outputs } from "./output-scope"

const marker = "Raya owner output directory: "
const key = (value: string) =>
  process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)

/** This reserved restriction is host-produced, never supplied by model context. */
export function unmarked(context?: string): Effect.Effect<void, Error> {
  return context?.includes(marker.trim())
    ? Effect.fail(new Error("Model context cannot supply the reserved owner output directory marker."))
    : Effect.void
}

function valid(dir: string) {
  return (
    Schema.is(Outputs)([path.join(dir, "raya-scope-probe")]) &&
    path.isAbsolute(dir) &&
    !dir.split(/[\\/]/).some((part) => part === "." || part === "..")
  )
}

/** Recognize only an explicit, unambiguous current-owner absolute-folder sentence. */
export const directory = Effect.fn("RoutineOwnerScope.directory")(function* (request?: string) {
  const text = request?.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "") ?? ""
  const clauses = [...text.matchAll(/(?:^|[.!?]\s+)\s*use only\s+([^\r\n]+?)(?=\.(?:\s|$)|$)/gim)]
    .map((match) => match[1].trim())
    .filter((value) => /^(?:["'`])?(?:[a-z]:|[\\/]|\.\.?[\\/])/i.test(value))
  if (!clauses.length) return undefined
  const dirs = clauses.map((value) => value.replace(/^(["'`])([\s\S]*)\1$/, "$2"))
  if (dirs.some((dir) => !valid(dir)) || new Set(dirs.map(key)).size !== 1)
    return yield* Effect.fail(
      new Error("The owner output directory is ambiguous or invalid. Use one absolute local folder."),
    )
  return path.normalize(dirs[0])
})

/** Read only the singleton host restriction already saved on the incoming request. */
export const retained = Effect.fn("RoutineOwnerScope.retained")(function* (context?: string) {
  if (!context?.includes(marker.trim())) return undefined
  const lines = context.split("\n").filter((line) => line.includes(marker.trim()))
  if (lines.length !== 1 || !context.startsWith(marker) || !lines[0].startsWith(marker))
    return yield* Effect.fail(new Error("The saved owner output directory marker is malformed or duplicated."))
  const parsed = yield* Effect.try({
    try: () => JSON.parse(lines[0].slice(marker.length)) as unknown,
    catch: () => new Error("The saved owner output directory marker is invalid."),
  })
  if (typeof parsed !== "string" || !valid(parsed))
    return yield* Effect.fail(new Error("The saved owner output directory marker is invalid."))
  return path.normalize(parsed)
})

export function context(dir: string | undefined, text?: string): Effect.Effect<string | undefined, Error> {
  const value = dir === undefined ? text : [`${marker}${JSON.stringify(dir)}`, text].filter(Boolean).join("\n\n")
  return value && value.length > 4000
    ? Effect.fail(new Error("The owner output directory and context exceed the 4000-character context limit."))
    : Effect.succeed(value)
}

export function body(context?: string) {
  if (!context?.startsWith(marker)) return context
  const end = context.indexOf("\n")
  return end < 0 ? undefined : context.slice(end + 1).trimStart()
}

/** Restrict explicit outputs; this never grants access to any file or tool. */
export function check(dir: string | undefined, outputs?: Outputs): Effect.Effect<void, Error> {
  if (dir === undefined) return Effect.void
  if (outputs === undefined)
    return Effect.fail(
      new Error("An owner output directory requires explicit outputs, including [] for read-only work."),
    )
  const foreign = outputs.find((file) => {
    const relative = path.relative(key(dir), key(file))
    return !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  })
  return foreign === undefined
    ? Effect.void
    : Effect.fail(new Error(`Output file is outside the owner's output directory ${dir}: ${foreign}`))
}
