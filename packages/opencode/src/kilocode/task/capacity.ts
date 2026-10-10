import { Effect } from "effect"
import type { Storage } from "@/storage/storage"

export const roster = 16 * 1024 * 1024
export const legacy = 64 * 1024 * 1024
export const definition = 16 * 1024 * 1024

export const read = (storage: Pick<Storage.Interface, "readBounded">, key: string[], maximum: number) =>
  storage
    .readBounded<unknown>(key, maximum)
    .pipe(
      Effect.catchTag("RayaStorage.LimitError", () =>
        Effect.fail(
          new Error(
            `Saved routine evidence exceeds its ${maximum} byte capacity. Preserve the original file and review its size before retrying.`,
          ),
        ),
      ),
    )

/** Count compact JSON bytes without serializing an uncapped roster first. */
export function check(value: unknown, maximum: number, label: string) {
  let total = 0
  const add = (bytes: number) => {
    total += bytes
    if (total > maximum)
      throw new Error(
        `${label} exceeds its ${maximum} byte capacity. Preserve the saved evidence and review its size before retrying.`,
      )
  }
  const text = (value: string) => {
    add(2)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
        add(2)
        continue
      }
      if (code < 32) {
        add(6)
        continue
      }
      if (code < 128) {
        add(1)
        continue
      }
      if (code < 2048) {
        add(2)
        continue
      }
      if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        add(4)
        i++
        continue
      }
      add(code >= 0xd800 && code <= 0xdfff ? 6 : 3)
    }
  }
  const visit = (value: unknown): void => {
    if (typeof value === "string") return text(value)
    if (value === null || typeof value !== "object") return add(JSON.stringify(value)?.length ?? 4)
    if (Array.isArray(value)) {
      add(2 + Math.max(0, value.length - 1))
      for (const item of value) visit(item)
      return
    }
    add(2)
    let count = 0
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      const item: unknown = Reflect.get(value, key)
      if (item === undefined) continue
      if (count++) add(1)
      text(key)
      add(1)
      visit(item)
    }
  }
  visit(value)
  return total
}
