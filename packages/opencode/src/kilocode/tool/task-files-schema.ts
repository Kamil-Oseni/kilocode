import path from "node:path"
import { Schema } from "effect"
import { Outputs } from "../task/output-scope"

export const key = "raya.task.files"
const local = (file: string) => {
  if (!file || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return false
  if (/[\x00-\x1f\x7f*?\[\]{}<>:"|]/.test(file)) return false
  return file
    .split(/[\\/]/)
    .every(
      (part) =>
        !!part &&
        part !== "." &&
        part !== ".." &&
        !/[ .]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
}
export const normalize = (file: string) => {
  const value = file.replaceAll("\\", "/")
  return process.platform === "win32" ? value.toLowerCase() : value
}

/** Exact relative files in the child's actual directory; empty means no file mutations. */
export const Declared = Schema.Array(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
    Schema.makeFilter((file) => (local(file) ? undefined : "Declare exact relative local files without aliases.")),
  ),
).check(
  Schema.isMaxLength(16),
  Schema.makeFilter((files) =>
    new Set(files.map(normalize)).size === files.length ? undefined : "Declared files must be distinct.",
  ),
)
export type Declared = typeof Declared.Type
export function overlap(left: Declared, right: Declared) {
  const files = new Set(left.map(normalize))
  return right.some((file) => files.has(normalize(file)))
}

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
export const Binding = Schema.Struct({
  version: Schema.Literal(1),
  child: identity,
  parent: identity,
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  declared: Declared,
  canonical: Outputs,
  branch: Schema.optional(identity),
}).check(
  Schema.makeFilter((value) =>
    value.child !== value.parent ? undefined : "Assigned file scopes require a distinct parent session.",
  ),
)
export type Binding = typeof Binding.Type
