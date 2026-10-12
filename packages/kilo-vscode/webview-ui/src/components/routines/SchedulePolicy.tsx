import type { Component } from "solid-js"
import { Select } from "@kilocode/kilo-ui/select"
import { summary, type Policy } from "../../../../src/shared/routine-policy"

const overlaps = [
  { value: "", label: "Keep existing behavior" },
  { value: "skip", label: "Skip this occurrence" },
  { value: "queue", label: "Keep one pending run" },
] as const
const missed = [
  { value: "", label: "Keep existing behavior" },
  { value: "skip", label: "Skip missed times" },
  { value: "latest", label: "Catch up one eligible occurrence" },
] as const

export const SchedulePolicy: Component<{
  value: Policy
  onChange: (value: Policy) => void
  disabled?: boolean
}> = (props) => (
  <fieldset class="routines-schedule" disabled={props.disabled}>
    <legend>Scheduled run handling</legend>
    <div class="routines-field">
      <span>If the previous run is still active</span>
      <Select
        options={[...overlaps]}
        current={overlaps.find((item) => item.value === (props.value.overlap ?? ""))}
        value={(item) => item.value || "existing"}
        label={(item) => item.label}
        triggerProps={{ "aria-label": "If the previous run is still active" }}
        disabled={props.disabled}
        variant="secondary"
        size="small"
        onSelect={(item) => {
          if (!item) return
          const next = { ...props.value }
          if (item.value === "") delete next.overlap
          if (item.value === "skip" || item.value === "queue") next.overlap = item.value
          props.onChange(next)
        }}
      />
      <span class="routines-hint">{summary(props.value).overlap} Runs never overlap.</span>
    </div>
    <div class="routines-field">
      <span>If Raya misses a scheduled time</span>
      <Select
        options={[...missed]}
        current={missed.find((item) => item.value === (props.value.missed ?? ""))}
        value={(item) => item.value || "existing"}
        label={(item) => item.label}
        triggerProps={{ "aria-label": "If Raya misses a scheduled time" }}
        disabled={props.disabled}
        variant="secondary"
        size="small"
        onSelect={(item) => {
          if (!item) return
          const next = { ...props.value }
          if (item.value === "") delete next.missed
          if (item.value === "skip" || item.value === "latest") next.missed = item.value
          props.onChange(next)
        }}
      />
      <span class="routines-hint">{summary(props.value).missed}</span>
    </div>
    <p class="routines-hint">Review these choices before saving. Earlier run records are preserved.</p>
  </fieldset>
)
