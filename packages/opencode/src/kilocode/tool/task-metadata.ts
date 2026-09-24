import { TaskAuthority } from "./task-authority"

/** Client session metadata cannot mint or erase a server-issued child authority. */
export namespace TaskMetadata {
  const keys = [TaskAuthority.key, TaskAuthority.computerKey]

  export function reserved(metadata: Record<string, unknown> | undefined): boolean {
    return !!metadata && keys.some((key) => Object.hasOwn(metadata, key))
  }

  export function preserve(
    current: Record<string, unknown> | undefined,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...incoming,
      ...Object.fromEntries(
        keys.filter((key) => current && Object.hasOwn(current, key)).map((key) => [key, current?.[key]]),
      ),
    }
  }
}
