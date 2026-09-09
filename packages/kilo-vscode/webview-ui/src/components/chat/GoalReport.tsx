import { createEffect, createSignal, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useClipboard } from "@kilocode/kilo-ui/context/clipboard"
import { report } from "../../../../src/shared/goal-report"

export function GoalReport(props: { goal: Parameters<typeof report>[0]; sessionID?: string }) {
  const clipboard = useClipboard()
  const [state, setState] = createSignal("idle")
  let version = 0
  createEffect(() => {
    void props.goal
    void props.sessionID
    version++
    setState("idle")
  })
  onCleanup(() => version++)
  const copy = async () => {
    const current = ++version
    setState("copying")
    try {
      await clipboard.write(report(props.goal, props.sessionID))
      if (current === version) setState("copied")
    } catch {
      if (current === version) setState("failed")
    }
  }
  return (
    <div>
      <Button size="small" variant="secondary" disabled={state() === "copying"} onClick={copy}>
        Copy goal report
      </Button>
      <span role="status">
        {state() === "copying"
          ? " Copying…"
          : state() === "copied"
            ? " Report copied."
            : state() === "failed"
              ? " Copy failed. Try again."
              : ""}
      </span>
    </div>
  )
}
