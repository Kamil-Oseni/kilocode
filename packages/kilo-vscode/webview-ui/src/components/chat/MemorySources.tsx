import { createMemo, For, Show } from "solid-js"
import type { Part } from "@kilocode/sdk/v2"
import { Button } from "@kilocode/kilo-ui/button"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { memorySources } from "../../../../src/shared/memory-source"
import { useVSCode } from "../../context/vscode"

export function MemorySources(props: { part: Part }) {
  const vscode = useVSCode()
  const links = createMemo(() => {
    const part = props.part
    if (part.type !== "tool" || part.tool !== "second_brain_recall" || part.state.status !== "completed") return []
    try {
      return memorySources(part.state.output)
    } catch (err) {
      console.warn("[Raya] Invalid Memory source labels", err)
      return []
    }
  })
  return (
    <Show when={links().length}>
      <Collapsible variant="ghost">
        <Collapsible.Trigger>
          Sources ({links().length})<Collapsible.Arrow />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <ul>
            <For each={links()}>
              {(link) => (
                <li>
                  <Button
                    intent="secondary"
                    scale="compact"
                    onClick={() => {
                      const part = props.part
                      if (part.type !== "tool" || part.state.status !== "completed") return
                      vscode.postMessage({
                        type: "openMemorySource",
                        sessionID: part.sessionID,
                        messageID: part.messageID,
                        partID: part.id,
                        callID: part.callID,
                        source: link.source,
                      })
                    }}
                  >
                    {link.label}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Collapsible.Content>
      </Collapsible>
    </Show>
  )
}
