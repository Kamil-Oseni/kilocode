import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Complete records enter the enumerated namespace exclusively; abandoned staging is inert. */
export function publish(file: string, record: string) {
  const stage = path.join(path.dirname(path.dirname(file)), `.record-${randomUUID()}.pending`)
  const fd = openSync(stage, "wx", 0o600)
  const errors: unknown[] = []
  try {
    writeFileSync(fd, record, "utf8")
    fsyncSync(fd)
  } catch (err) {
    errors.push(err)
  }
  try {
    closeSync(fd)
  } catch (err) {
    errors.push(err)
  }
  if (!errors.length) {
    try {
      linkSync(stage, file)
    } catch (err) {
      errors.push(err)
    }
  }
  try {
    unlinkSync(stage)
  } catch (err) {
    errors.push(err)
  }
  if (errors.length) throw new AggregateError(errors, "Profile record publication failed")
}
