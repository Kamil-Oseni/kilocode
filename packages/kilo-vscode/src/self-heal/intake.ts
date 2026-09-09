import * as fs from "node:fs/promises"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { selfHealPrompt } from "../shared/self-heal"
import { current, resolve } from "./source"

export async function capture(input: {
  client: KiloClient
  store: string
  configured: string
  extension: string
  description: string
  reporter: string
  platform?: string
  model?: { providerID: string; modelID: string }
  snapshotInitialization?: "wait"
  metadata: (directory: string) => Promise<Record<string, unknown> | undefined>
}) {
  await fs.mkdir(input.store, { recursive: true })
  const { data: item } = await input.client.kilocode.selfHeal.create(
    { directory: input.store, description: input.description, reporterSessionID: input.reporter },
    { throwOnError: true },
  )
  const source = await resolve({ configured: input.configured, extension: input.extension })
  if (!source.ok)
    return { item, notice: `Report ${item.id} saved to the global backlog. Repair was not started. ${source.reason}` }
  const metadata = await input.metadata(source.source.root)
  if (!(await current(source.source, { configured: input.configured, extension: input.extension }))) {
    return {
      item,
      notice: `Report ${item.id} saved to the global backlog. Repair was not started because the verified Raya source changed or became unavailable. Check raya.selfHeal.sourcePath and retry.`,
    }
  }
  const directory = source.source.root
  const { data: session } = await input.client.session.create(
    {
      directory,
      platform: input.platform,
      metadata: { ...metadata, rayaSelfHealSource: source.source },
    },
    { throwOnError: true },
  )
  const objective = `Repair Raya self-heal item ${item.id}: ${item.title}. Done when the report is reproduced, the root cause is fixed, and authoritative tests plus relevant runtime or visual evidence pass.`
  await input.client.kilocode.goal.create(
    { sessionID: session.id, directory, objective, selfHealID: item.id },
    { throwOnError: true },
  )
  await input.client.kilocode.selfHeal.update(
    { itemID: item.id, directory: input.store, status: "in_progress", workSessionID: session.id },
    { throwOnError: true },
  )
  await input.client.session.promptAsync(
    {
      sessionID: session.id,
      directory,
      parts: [
        {
          type: "text",
          text:
            selfHealPrompt(item) +
            `\nVerified Raya source: ${directory}\nSource commit at admission: ${source.source.commit}`,
          synthetic: true,
        },
      ],
      model: input.model,
      agent: "chief",
      snapshotInitialization: input.snapshotInitialization,
    },
    { throwOnError: true },
  )
  return {
    item,
    session: session.id,
    source: source.source,
    notice: `Captured ${item.id} as ${item.category}/${item.severity}. Repair session ${session.id} started in the verified Raya source checkout at ${directory}.`,
  }
}
