import { For, Show, type Component } from "solid-js"
import type { Draft } from "../../../../src/shared/routine-schedule"

const modes = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Selected weekdays" },
  { value: "monthly", label: "Day of the month" },
  { value: "once", label: "Once after a delay" },
  { value: "date", label: "Once on a date" },
  { value: "event", label: "When an event arrives" },
  { value: "manual", label: "Only when I ask" },
  { value: "cron", label: "Advanced: cron expression" },
] as const
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export const ScheduleEditor: Component<{ value: Draft; onChange: (value: Draft) => void; disabled?: boolean }> = (
  props,
) => {
  const change = (patch: Partial<Draft>) => props.onChange({ ...props.value, ...patch })
  const calendar = () => ["daily", "weekly", "monthly", "cron", "date"].includes(props.value.mode)
  return (
    <fieldset class="routines-schedule" disabled={props.disabled}>
      <legend>Schedule</legend>
      <label class="routines-field">
        Repeat
        <select
          value={props.value.mode}
          onChange={(e) => {
            const mode = modes.find((item) => item.value === e.currentTarget.value)
            if (mode) change({ mode: mode.value })
          }}
        >
          <For each={modes}>{(mode) => <option value={mode.value}>{mode.label}</option>}</For>
        </select>
      </label>
      <Show when={calendar() && props.value.mode !== "cron" && props.value.mode !== "date"}>
        <label class="routines-field">
          Time of day
          <input
            type="time"
            required
            value={props.value.time}
            onInput={(e) => change({ time: e.currentTarget.value })}
          />
        </label>
      </Show>
      <Show when={props.value.mode === "weekly"}>
        <fieldset class="routines-weekdays">
          <legend>Run on</legend>
          <For each={days}>
            {(day, index) => (
              <label>
                <input
                  type="checkbox"
                  checked={props.value.days.includes(index())}
                  onChange={(e) => {
                    change({
                      days: e.currentTarget.checked
                        ? [...props.value.days, index()]
                        : props.value.days.filter((day) => day !== index()),
                    })
                  }}
                />
                {day}
              </label>
            )}
          </For>
        </fieldset>
      </Show>
      <Show when={props.value.mode === "monthly"}>
        <label class="routines-field">
          Day of the month
          <input
            type="number"
            required
            min="1"
            max="31"
            step="1"
            value={props.value.day}
            onInput={(e) => change({ day: e.currentTarget.value })}
          />
          <span class="routines-hint">
            Months without this date are skipped. For example, the 31st does not run in April.
          </span>
        </label>
      </Show>
      <Show when={props.value.mode === "once"}>
        <label class="routines-field">
          Delay from preview
          <input
            type="number"
            required
            min="1"
            step="1"
            value={props.value.delay}
            onInput={(e) => change({ delay: e.currentTarget.value })}
          />
        </label>
        <label class="routines-field">
          Delay unit
          <select
            value={props.value.unit}
            onChange={(e) => {
              if (e.currentTarget.value === "minutes" || e.currentTarget.value === "hours")
                change({ unit: e.currentTarget.value })
            }}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
          <span class="routines-hint">Preview fixes the exact time. Confirming later keeps that time.</span>
        </label>
      </Show>
      <Show when={props.value.mode === "date"}>
        <label class="routines-field">
          Date and time
          <input
            type="datetime-local"
            required
            step="0.001"
            value={props.value.local}
            onInput={(e) => change({ local: e.currentTarget.value })}
          />
          <span class="routines-hint">
            Enter the time in the timezone below. Existing one-shot schedules are shown in your current timezone.
          </span>
        </label>
        <label class="routines-field">
          If the clock repeats this time
          <select
            value={props.value.fold}
            onChange={(e) => {
              const fold = e.currentTarget.value
              if (fold === "reject" || fold === "earlier" || fold === "later") change({ fold })
            }}
          >
            <option value="reject">Ask me to choose</option>
            <option value="earlier">First occurrence</option>
            <option value="later">Second occurrence</option>
          </select>
          <span class="routines-hint">
            Preview rejects times skipped by a clock change. For repeated times, choose an occurrence and check the
            preview.
          </span>
        </label>
      </Show>
      <Show when={props.value.mode === "event"}>
        <label class="routines-field">
          Event source
          <input required value={props.value.source} onInput={(e) => change({ source: e.currentTarget.value })} />
          <span class="routines-hint">A connected integration must send this event. Use ci for CI events.</span>
        </label>
        <label class="routines-field">
          Event filter
          <select
            value={props.value.filtered ? "exact" : "any"}
            onChange={(e) => change({ filtered: e.currentTarget.value === "exact" })}
          >
            <option value="any">Any value</option>
            <option value="exact">Exact match</option>
          </select>
        </label>
        <Show when={props.value.filtered}>
          <label class="routines-field">
            Exact filter value (branch for CI)
            <input value={props.value.branch} onInput={(e) => change({ branch: e.currentTarget.value })} />
            <span class="routines-hint">
              Case and spaces are significant. An empty value matches only an empty filter.
            </span>
          </label>
        </Show>
      </Show>
      <Show when={props.value.mode === "cron"}>
        <label class="routines-field">
          Cron expression
          <input required value={props.value.expr} onInput={(e) => change({ expr: e.currentTarget.value })} />
          <span class="routines-hint">
            Minute, hour, day of month, month, weekday. The backend validates the expression during preview.
          </span>
        </label>
      </Show>
      <Show when={calendar()}>
        <label class="routines-field">
          Calendar timezone
          <input
            required
            value={props.value.zone}
            onInput={(e) => change({ zone: e.currentTarget.value })}
            placeholder="America/Toronto"
          />
          <span class="routines-hint">Calendar times use this timezone, including its daylight-saving changes.</span>
        </label>
      </Show>
    </fieldset>
  )
}
