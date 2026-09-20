import type { RoutineRecovery } from "../../../src/shared/routine-error"

export function routineFailure(error?: string, recovery?: RoutineRecovery, preserved?: string) {
  const message = error?.trim()
  const next = recovery?.next.trim()
  return [message, preserved?.trim(), next]
    .filter((part, index, parts): part is string => !!part && !parts.slice(0, index).some((prior) => prior?.includes(part)))
    .join(" ")
}
