const Trusted = Symbol("raya.trustedTool")

export function mark<A extends object>(value: A, trusted: boolean): A {
  if (trusted) Object.defineProperty(value, Trusted, { value: true })
  return value
}

export function check(value: object) {
  return Trusted in value
}

export * as ToolTrust from "./trust"
