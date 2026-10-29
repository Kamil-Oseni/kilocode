import { For, Show } from "solid-js"
import type { GoalState } from "../../../../src/shared/goal"

export function GoalBinding(props: { check: NonNullable<GoalState["criteria"]>[number]["check"]; label?: string }) {
  const command = () => (props.check?.kind === "command" ? props.check : undefined)
  const equality = () => (props.check?.kind === "byte-equality" ? props.check : undefined)
  const content = () => (props.check?.kind === "file-content" ? props.check : undefined)
  return (
    <>
      <Show when={content()}>
        {(check) => (
          <div aria-label="Saved file-content binding">
            <p>This saved check is read-only here; editing the description does not change it.</p>
            <p>
              File: <code>{check().path}</code>
            </p>
            <p>
              Requires a fresh full native Read of the file, at most 8192 UTF-8 bytes. Checks literal presence only, not
              factual accuracy.
            </p>
            <For each={check().literals}>
              {(text) => (
                <p>
                  Required literal (JSON): <code>{JSON.stringify(text)}</code>
                </p>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={command()}>
        {(check) => (
          <div aria-label={props.label ?? "Saved command binding"}>
            <p>
              Required command: <code>{check().command}</code>
            </p>
            <p>
              Working directory: <code>{check().directory}</code>
            </p>
          </div>
        )}
      </Show>
      <Show when={equality()}>
        {(check) => (
          <div aria-label="Saved byte-equality binding">
            <p>
              Exact file bytes must match the saved source baseline. This binding is read-only here; editing the
              description does not change it.
            </p>
            <p>
              Source: <code>{check().source.path}</code>
            </p>
            <p>
              Canonical source: <code>{check().source.canonical}</code>
            </p>
            <p>
              Source SHA-256: <code>{check().source.sha256}</code>
            </p>
            <p>
              Source bytes: <code>{check().source.bytes}</code>
            </p>
            <p>
              Target: <code>{check().target.path}</code>
            </p>
            <p>
              Canonical target: <code>{check().target.canonical}</code>
            </p>
          </div>
        )}
      </Show>
    </>
  )
}
