import type { InstallRecord } from "./update-installation"

/** Describe the retained journal, including a retry that never dispatched an installer. */
export function outcome(record: InstallRecord) {
  if (record.phase.startsWith("rollback-"))
    return {
      warning: true,
      message: `Raya's rollback to ${record.previous} is waiting for reload verification. The ${record.version} update was not dispatched again. Reload the window to verify which version is active.`,
    }
  if (record.phase === "installing")
    return {
      warning: true,
      message: `Raya already dispatched the ${record.version} installer, but completion was not confirmed. Reload the window to verify which version is active.`,
    }
  return { warning: false, message: `Raya ${record.version} installed. Reload the window to apply it.` }
}
