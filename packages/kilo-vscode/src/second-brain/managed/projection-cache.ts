import { isDeepStrictEqual } from "node:util"

const states = new WeakMap<
  object,
  {
    rows: { owner: object; inputs: Buffer[]; args: unknown; outputs: Buffer[]; bytes: number }[]
    bytes: number
    closed: boolean
  }
>()
const maximum = 256 * 1024 * 1024

/** Request-owned pure bytes only; native authority is never retained here. */
export function scope() {
  const value = Object.freeze({})
  states.set(value, { rows: [], bytes: 0, closed: false })
  return value
}

export function dispose(value: object) {
  const state = states.get(value)
  if (!state) return
  state.rows.length = 0
  state.bytes = 0
  state.closed = true
}

export function paired(
  value: object | undefined,
  owner: object,
  inputs: readonly Buffer[],
  args: unknown,
  produce: () => Buffer[],
) {
  const state = value ? states.get(value) : undefined
  if (!state || state.closed) return produce()
  const found = state.rows.find(
    (row) =>
      row.owner === owner &&
      row.inputs.length === inputs.length &&
      row.inputs.every((raw, index) => raw.equals(inputs[index])) &&
      isDeepStrictEqual(row.args, args),
  )
  if (found) return found.outputs.map((raw) => Buffer.from(raw))
  const outputs = produce()
  const copied = structuredClone(args)
  const bytes = [...inputs, ...outputs].reduce(
    (size, raw) => size + raw.length,
    Buffer.byteLength(JSON.stringify(copied)),
  )
  if (bytes > maximum) return outputs
  while (state.rows.length >= 12 || state.bytes + bytes > maximum) {
    const removed = state.rows.shift()!
    state.bytes -= removed.bytes
  }
  state.rows.push({
    owner,
    inputs: inputs.map((raw) => Buffer.from(raw)),
    args: copied,
    outputs: outputs.map((raw) => Buffer.from(raw)),
    bytes,
  })
  state.bytes += bytes
  return outputs
}
