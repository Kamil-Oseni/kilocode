import { For, type Accessor, type JSX } from "solid-js"

/** Keep a direct transcript row mounted while its content changes under the same key. */
export function DirectRows<T>(props: {
  keys: readonly string[]
  get: (key: string) => T
  children: (row: Accessor<T>) => JSX.Element
}) {
  return <For each={props.keys}>{(key) => props.children(() => props.get(key))}</For>
}
