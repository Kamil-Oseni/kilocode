import { Show } from "solid-js"
import type { GoalSource } from "../../../../src/shared/goal"

export function GoalInspection(props: { inspection: GoalSource["inspection"] }) {
  const description = () => {
    const value = props.inspection
    if (!value) return
    if (value.kind === "directory")
      return "This result listed directory entries; it did not inspect their file contents."
    if (value.coverage === "unknown") return "The scope of this inspection was not recorded or could not be verified."
    if (value.reportedLines === 0) return "The recorded text extraction was empty."
    return `Displayed lines ${value.lineStart}–${value.lineEnd}; the read reported ${value.reportedLines} lines. ${value.coverage === "partial" ? "Only part of the text was displayed." : "The recorded text range was displayed."}`
  }
  return (
    <Show when={description()}>
      {(text) => (
        <div aria-label="Recorded inspection coverage">
          <strong>Inspection coverage</strong>
          <p>{text()}</p>
          <p>This does not establish a full review of the file or confirm its current contents.</p>
        </div>
      )}
    </Show>
  )
}
