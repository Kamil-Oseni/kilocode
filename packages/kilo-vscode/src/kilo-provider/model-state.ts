/**
 * Per-mode model selection persistence via the CLI's model.json.
 *
 * Reads/writes ~/.local/state/kilo/model.json (same file the CLI TUI uses)
 * so per-mode model choices are shared between CLI and extension.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import { validateModelSelections } from "../provider-actions"
import { writer } from "./model-state-writer"
export { retire, captureSnapshot } from "./model-state-writer"

type PostMessage = (msg: unknown) => void

/**
 * Handle a model-state webview message. Returns true if handled.
 */
export async function handleMessage(
  type: string,
  message: Record<string, unknown>,
  client: KiloClient | null,
  post: PostMessage,
  current: () => boolean = () => true,
): Promise<boolean> {
  if (type === "persistModelSelection") {
    const agent = message.agent
    const selection = validateModelSelections({
      selected: {
        providerID: message.providerID as string,
        modelID: message.modelID as string,
      },
    }).selected
    if (typeof agent !== "string" || !agent || !selection) throw new Error("Invalid model preference selection")
    await writer(client, current).run((data) => ({
      ...data,
      model: { ...validateModelSelections(data.model), [agent]: selection },
    }))
    return true
  }
  if (type === "clearModelSelection") {
    const agent = message.agent
    if (typeof agent !== "string" || !agent) throw new Error("Invalid model preference agent")
    await writer(client, current).run((data) => {
      const model = validateModelSelections(data.model)
      delete model[agent]
      return { ...data, model }
    })
    return true
  }
  if (type === "requestModelSelections") {
    const data = await writer(client, current).run()
    const selections = validateModelSelections(data.model)
    post({ type: "modelSelectionsLoaded", selections })
    return true
  }
  return false
}

export async function reset(
  client: KiloClient | null,
  post: PostMessage,
  current: () => boolean = () => true,
): Promise<void> {
  await writer(client, current).run((data) => ({ ...data, model: {} }))
  post({ type: "modelSelectionsLoaded", selections: {} })
}
