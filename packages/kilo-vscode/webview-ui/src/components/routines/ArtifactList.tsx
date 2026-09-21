import { For, Show, type Component } from "solid-js"

export type HandoffArtifact = {
  path: string
  sha256: string
  tool: string
  callID: string
}

function valid(value: unknown): value is HandoffArtifact {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    typeof row.path === "string" &&
    !!row.path.trim() &&
    typeof row.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(row.sha256) &&
    typeof row.tool === "string" &&
    !!row.tool.trim() &&
    typeof row.callID === "string" &&
    !!row.callID.trim()
  )
}

export function validArtifacts(value: unknown): value is HandoffArtifact[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(valid))
}

function name(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

export const ArtifactList: Component<{ items?: HandoffArtifact[] }> = (props) => (
  <Show when={props.items?.length}>
    <div class="routines-handoffs">
      <span class="routines-line-meta">Files handed off</span>
      <ul>
        <For each={props.items}>
          {(item) => (
            <li>
              <strong title={item.path}>{name(item.path)}</strong>
              <span title={`SHA-256 ${item.sha256}`}>Verified · {item.sha256.slice(0, 12)}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  </Show>
)
