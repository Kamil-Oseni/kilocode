import { localConfig } from "./local-scheduler"

/** An explicitly local request retains its selected model for helper work. */
export function substitute(options: Readonly<Record<string, unknown>> | undefined) {
  return !localConfig(options ?? {}).enabled
}
