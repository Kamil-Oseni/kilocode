import { Index, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { Output } from "../../../../src/shared/routine-output"

export const OutputEditor: Component<{ value: Output; onChange: (value: Output) => void; disabled?: boolean }> = (
  props,
) => {
  let root: HTMLFieldSetElement | undefined
  const remove = (id: string) => {
    props.onChange({ ...props.value, criteria: props.value.criteria.filter((item) => item.id !== id) })
    queueMicrotask(() => {
      if (root?.isConnected) root.querySelector<HTMLButtonElement>("[data-add-criterion]")?.focus()
    })
  }
  const add = () => {
    props.onChange({
      ...props.value,
      criteria: [
        ...props.value.criteria,
        {
          id: `criterion-${crypto.randomUUID()}`,
          description: "",
          verification: "",
        },
      ],
    })
    queueMicrotask(() => {
      if (root?.isConnected) [...root.querySelectorAll("fieldset")].at(-1)?.querySelector("textarea")?.focus()
    })
  }
  const change = (id: string, patch: Partial<Output["criteria"][number]>) =>
    props.onChange({
      ...props.value,
      criteria: props.value.criteria.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })
  return (
    <fieldset ref={root} class="routines-schedule" disabled={props.disabled}>
      <legend>Where should the result go?</legend>
      <p class="routines-hint">
        Results stay in this run’s conversation. Describe the deliverable and the checks it must satisfy.
      </p>
      <label class="routines-field">
        Required output
        <textarea
          required
          maxLength={4000}
          rows={3}
          value={props.value.description}
          onInput={(event) => props.onChange({ ...props.value, description: event.currentTarget.value })}
        />
      </label>
      <Index each={props.value.criteria}>
        {(item, index) => (
          <fieldset class="routines-schedule">
            <legend>Criterion {index + 1}</legend>
            <label class="routines-field">
              What must be true?
              <textarea
                required
                maxLength={4000}
                rows={2}
                value={item().description}
                onInput={(event) => change(item().id, { description: event.currentTarget.value })}
              />
            </label>
            <label class="routines-field">
              How should Raya verify it?
              <textarea
                required
                maxLength={4000}
                rows={2}
                value={item().verification}
                onInput={(event) => change(item().id, { verification: event.currentTarget.value })}
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              disabled={props.disabled || props.value.criteria.length === 1}
              onClick={() => remove(item().id)}
            >
              Remove criterion {index + 1}
            </Button>
          </fieldset>
        )}
      </Index>
      <Button
        data-add-criterion
        type="button"
        variant="secondary"
        disabled={props.disabled || props.value.criteria.length >= 20}
        onClick={add}
      >
        Add criterion
      </Button>
      <p class="routines-hint">
        Use evidence such as source references or test results. If a person must judge the result, specify that review
        here.
      </p>
    </fieldset>
  )
}
