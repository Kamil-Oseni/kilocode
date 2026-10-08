import { visit } from "jsonc-parser"
import { check } from "../control/frames"

type Value = null | boolean | number | string | Value[] | { [key: string]: Value }

/** Validate large plans without retaining a second tree of every property and token. */
export function parse(raw: Uint8Array, limit = 16777216, nodes = 1000000) {
  check(raw.length > 0 && raw.length <= limit, "Bounded JSON document required")
  check(!(raw[0] === 239 && raw[1] === 187 && raw[2] === 191), "JSON BOM refused")
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw)
  const stack: { value: Value[] | { [key: string]: Value }; depth: number; key?: string }[] = []
  let result: Value | undefined
  let count = 0
  function bound(depth: number, size = 1) {
    count += size
    check(count <= nodes && depth <= 32, "JSON structure bound exceeded")
  }
  function append(value: Value) {
    const parent = stack.at(-1)
    const depth = parent ? parent.depth + (Array.isArray(parent.value) ? 1 : 2) : 0
    bound(depth)
    if (!parent) {
      result = value
      return depth
    }
    if (Array.isArray(parent.value)) {
      parent.value.push(value)
      return depth
    }
    check(parent.key !== undefined, "Strict JSON required")
    parent.value[parent.key] = value
    parent.key = undefined
    return depth
  }
  visit(
    text,
    {
      onObjectBegin() {
        const value: { [key: string]: Value } = Object.create(null)
        stack.push({ value, depth: append(value) })
      },
      onObjectProperty(key) {
        const parent = stack.at(-1)!
        check(!Array.isArray(parent.value), "Strict JSON required")
        bound(parent.depth + 2, 2)
        check(!Object.hasOwn(parent.value, key), "Duplicate JSON field")
        parent.key = key
      },
      onObjectEnd() {
        stack.pop()
      },
      onArrayBegin() {
        const value: Value[] = []
        stack.push({ value, depth: append(value) })
      },
      onArrayEnd() {
        stack.pop()
      },
      onLiteralValue(value: null | boolean | number | string) {
        if (typeof value === "number") check(Number.isFinite(value), "Finite JSON number required")
        append(value)
      },
      onError() {
        throw new Error("Strict JSON required")
      },
    },
    { disallowComments: true, allowTrailingComma: false },
  )
  check(result !== null && typeof result === "object" && !Array.isArray(result), "Object required")
  return result
}
