import { createUniqueId, type Component } from "solid-js"
import { Select } from "@kilocode/kilo-ui/select"

/** The host supplies same-workspace destinations and preserves the saved default. */
export const ReportingChoice: Component<{
  value: string
  choices: readonly { id: string; label: string }[]
  onChange: (id: string) => void
  disabled?: boolean
}> = (props) => {
  const label = createUniqueId()
  return (
    <fieldset class="routines-schedule" disabled={props.disabled}>
      <legend>Reports</legend>
      <div class="routines-field">
        <span id={label}>Report conversation</span>
        <Select
          options={[...props.choices]}
          current={props.choices.find((choice) => choice.id === props.value)}
          value={(choice) => choice.id}
          label={(choice) => choice.label}
          onSelect={(choice) => choice && props.onChange(choice.id)}
          triggerProps={{ "aria-labelledby": label }}
          disabled={props.disabled}
          variant="secondary"
          size="small"
        />
      </div>
      <p class="routines-hint">Choose where this routine posts progress and its final report.</p>
    </fieldset>
  )
}
