export class Failure extends Error {
  constructor(
    readonly code: string,
    readonly uncertain = false,
  ) {
    super(`Home Assistant: ${code}`)
    this.name = "HomeAssistantFailure"
  }
}

const originals = new WeakMap<Error, unknown>()
export function safe(error: unknown, uncertain: boolean): Error {
  if (error instanceof AggregateError)
    return new AggregateError(
      error.errors.map((value) => safe(value, uncertain)),
      "Home Assistant original failures retained",
    )
  const result =
    error instanceof Failure
      ? new Failure(error.code, uncertain || error.uncertain)
      : new Failure("transport_or_cleanup_failed", uncertain)
  originals.set(result, error instanceof Error ? (originals.get(error) ?? error) : error)
  return result
}
