import { Show } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import type { AdminRecovery } from "../../../../src/shared/admin"

export function Recovery(props: { value?: AdminRecovery }) {
  const available = () => (props.value?.status === "available" ? props.value : undefined)
  const message = () => {
    const value = props.value
    if (!value) return "Rollback availability has not been checked."
    if (value.status === "in-progress")
      return "An installation needs recovery before rollback availability can be confirmed."
    if (value.status === "invalid")
      return "The retained rollback could not be verified. Inspect the recovery record before restoring a version."
    if (value.status === "absent")
      return value.reason === "active-unavailable"
        ? "The current package is not recorded in the recovery vault."
        : "No earlier package is retained."
    return "An earlier package has been verified against its saved checksums."
  }
  return (
    <Card>
      <h2>Rollback availability</h2>
      <p role="status">{message()}</p>
      <Show when={available()}>
        {(value) => (
          <>
            <p>
              Earlier version: {value().version} · {value().target}
            </p>
            <p>Verified {new Date(value().observedAt).toLocaleTimeString()}</p>
            <details class="raya-recovery-data">
              <summary>Verified package checksums</summary>
              <p>Package SHA-256: {value().artifact.digest}</p>
              <p>CLI SHA-256: {value().binary.digest}</p>
            </details>
            <p>This verifies retained files. Restoring the version is a separate action.</p>
          </>
        )}
      </Show>
    </Card>
  )
}
