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
  const admission = await input.client.kilocode.selfHeal
    .admit({ itemID: item.id, directory: input.store, source: source.source }, { throwOnError: true })
    .then(
      (result) => result.data,
      () => undefined,
    )
  if (!admission)
    return {
      item,
      notice: `Report ${item.id} saved to the global backlog. Repair admission could not be confirmed. Inspect the retained backlog outcome before retrying; no repair side effects were requested.`,
    }
  const claim = admission
  if (!claim.owned || !claim.token)
    return {
      item,
      notice: `Report ${item.id} saved to the global backlog. Repair attempt ${claim.outcome.id} is ${claim.outcome.phase}${claim.outcome.sessionID ? ` in session ${claim.outcome.sessionID}` : ""}. ${claim.outcome.reason ?? "No additional repair was started. Inspect the existing attempt before recovery."}`,
    }
  let outcome = claim.outcome
  let session: string | undefined
  const step = async (phase: typeof outcome.phase, id?: string) => {
    const result = await input.client.kilocode.selfHeal.advance(
      {
        itemID: item.id,
        directory: input.store,
        token: claim.token!,
        revision: outcome.revision,
        phase,
        ...(id ? { sessionID: id } : {}),
      },
      { throwOnError: true },
    )
    outcome = result.data
  }
  try {
    if (!(await current(source.source, { configured: input.configured, extension: input.extension })))
      throw new Error("Source changed before repair creation")
    await step("session_creating")
    const result = await input.client.session.create(
      {
        directory,
        platform: input.platform,
        metadata: { ...metadata, rayaSelfHealSource: source.source, rayaSelfHealAttempt: claim.outcome.id },
      },
      { throwOnError: true },
    )
    session = result.data.id
    await step("session_created", session)
    await step("goal_creating")
    const objective = `Repair Raya self-heal item ${item.id}: ${item.title}. Done when the report is reproduced, the root cause is fixed, and authoritative tests plus relevant runtime or visual evidence pass.`
    await input.client.kilocode.goal.create(
      { sessionID: session, directory, objective, selfHealID: item.id },
      { throwOnError: true },
    )
    await step("goal_created")
    await input.client.kilocode.selfHeal.update(
      { itemID: item.id, directory: input.store, status: "in_progress", workSessionID: session },
      { throwOnError: true },
    )
    await step("dispatching")
    await input.client.session.promptAsync(
      {
        sessionID: session,
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
    await step("submitted")
  } catch {
    // A failed acknowledgement can hide a completed transition. Never replay its side effect.
    const failure = outcome.phase === "dispatching" ? "dispatch_unknown" : "blocked"
    const recorded = await step(failure).then(
      () => true,
      () => false,
    )
    return {
      item,
      notice: `Report ${item.id} saved to the global backlog. Repair startup needs review${session ? ` in session ${session}` : ""}. ${recorded ? (outcome.reason ?? "Inspect the retained repair attempt before recovery.") : "The last durable phase remains readable in the backlog; a startup operation may have completed without acknowledgement."} Use /self-heal inspect ${item.id} to read its retained outcome. No automatic retry was attempted.`,
    }
  }
  return {
    item,
    session,
    source: source.source,
    notice: `Captured ${item.id} as ${item.category}/${item.severity}. Repair session ${session} submitted in the verified Raya source checkout at ${directory}.`,
  }
}
