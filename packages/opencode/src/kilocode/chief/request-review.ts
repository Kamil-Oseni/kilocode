import { Effect } from "effect"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { mutation } from "@/kilocode/goal/mutation"
import { TaskAuthority } from "@/kilocode/tool/task-authority"

/** Dormant review boundary for exact saved request branches; no tools expose it yet. */
export namespace ChiefRequestReview {
  export function make(
    storage: Pick<Storage.Interface, "read" | "create" | "replace" | "remove">,
    sessions: Pick<Session.Interface, "get" | "messages">,
  ) {
    const ledger = ChiefRequestPlan.make(storage, sessions)

    const inspect = Effect.fn("ChiefRequestReview.inspect")(function* (id: SessionID) {
      const plan = yield* ledger.load(id)
      if (!plan) throw new Error("No active Chief request plan")
      const branches = yield* Effect.forEach(plan.branches, (branch) =>
        Effect.gen(function* () {
          const base = {
            id: branch.id,
            name: branch.name,
            specialist: branch.specialist,
            access: branch.access,
            state: branch.state,
            reviewed: !!branch.review,
            ...(branch.callID ? { callID: branch.callID } : {}),
            ...(branch.sessionID ? { sessionID: branch.sessionID } : {}),
            ...(branch.messageID ? { messageID: branch.messageID } : {}),
          }
          if (!branch.sessionID)
            return {
              ...base,
              report: undefined as string | undefined,
              evidence: [] as { messageID: string; partID: string; callID: string; tool: string }[],
            }
          const child = yield* sessions.get(branch.sessionID)
          if (
            child.parentID !== id ||
            child.agent !== branch.specialist ||
            TaskAuthority.read(child.metadata) !== "read"
          )
            throw new Error("Chief request child identity or authority changed")
          const rows = yield* sessions.messages({ sessionID: branch.sessionID })
          const turn = ChiefBranches.turn(rows, branch.messageID)
          const report = turn?.reply.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim()
            .slice(0, 4_000)
          const evidence = (turn?.rows ?? [])
            .flatMap((row) =>
              row.parts.flatMap((part) =>
                part.type === "tool" &&
                part.state.status === "completed" &&
                part.tool !== "task" &&
                part.tool !== "chief_route"
                  ? [{ messageID: row.info.id, partID: part.id, callID: part.callID, tool: part.tool }]
                  : [],
              ),
            )
            .slice(0, 20)
          return { ...base, report, evidence }
        }),
      )
      return { version: 1 as const, identity: plan.identity, branches }
    })

    const review = Effect.fn("ChiefRequestReview.review")(function* (input: {
      sessionID: SessionID
      requestID: MessageID
      revision: string
      branchID: string
      callID: string
      childID: SessionID
      messageID: MessageID
      inspect: { messageID: MessageID; partID: string; callID: string }
      evidence: { messageID: MessageID; partID: string; callID: string }
      assessment: string
    }) {
      return yield* mutation(
        storage,
        input.sessionID,
        Effect.gen(function* () {
          const plan = yield* ledger.load(input.sessionID)
          if (!plan || plan.identity.requestID !== input.requestID || plan.identity.revision !== input.revision)
            throw new Error("Chief request plan changed before review")
          const branch = plan.branches.find((item) => item.id === input.branchID)
          if (
            !branch ||
            branch.state !== "completed" ||
            branch.access !== "read" ||
            branch.callID !== input.callID ||
            branch.sessionID !== input.childID ||
            branch.messageID !== input.messageID
          )
            throw new Error("Only the exact completed read-only branch can be reviewed")
          const assessment = input.assessment.trim()
          if (!assessment || assessment.length > 2_000)
            throw new Error("Chief request review needs a bounded assessment")
          if (branch.review) {
            if (
              branch.review.callID === input.evidence.callID &&
              branch.review.messageID === input.evidence.messageID &&
              branch.review.partID === input.evidence.partID &&
              branch.review.assessment === assessment
            )
              return branch
            throw new Error("Chief request branch already has a different review")
          }
          const view = yield* inspect(input.sessionID)
          const result = view.branches.find((item) => item.id === branch.id)
          if (
            !result?.report ||
            !result.evidence.some(
              (item) =>
                item.messageID === input.evidence.messageID &&
                item.partID === input.evidence.partID &&
                item.callID === input.evidence.callID,
            )
          )
            throw new Error("Chief request review needs exact completed child evidence")
          const rows = yield* sessions.messages({ sessionID: input.sessionID })
          const receipts = rows.flatMap((row) =>
            row.info.role === "assistant" &&
            row.info.id === input.inspect.messageID &&
            row.info.parentID === input.requestID
              ? row.parts.filter(
                  (part) =>
                    part.type === "tool" &&
                    part.id === input.inspect.partID &&
                    part.callID === input.inspect.callID &&
                    part.tool === "chief_inspect" &&
                    part.state.status === "completed",
                )
              : [],
          )
          const receipt = receipts[0]
          if (receipts.length !== 1 || !receipt || receipt.type !== "tool" || receipt.state.status !== "completed")
            throw new Error("Matching saved Chief request inspection receipt was not found")
          if (
            receipt.state.metadata?.requestID !== input.requestID ||
            receipt.state.metadata?.requestRevision !== input.revision ||
            receipt.state.time.end < branch.updatedAt
          )
            throw new Error("Matching saved Chief request inspection receipt was not found")
          const output = receipt.state.output
          const shown = yield* Effect.try({
            try: () => JSON.parse(output) as unknown,
            catch: () => new Error("Chief request inspection receipt is unreadable"),
          })
          if (JSON.stringify(shown) !== JSON.stringify(view))
            throw new Error("Chief request inspection no longer matches saved branch evidence")
          const next: ChiefBranches.Branch = {
            ...branch,
            review: { ...input.evidence, assessment, at: Date.now() },
          }
          yield* storage.replace(ChiefRequestPlan.key(input.sessionID, input.requestID), {
            ...plan,
            branches: plan.branches.map((item) => (item.id === branch.id ? next : item)),
          } satisfies ChiefRequestPlan.Record)
          return next
        }),
      )
    })

    const synthesize = Effect.fn("ChiefRequestReview.synthesize")(function* (input: {
      sessionID: SessionID
      requestID: MessageID
      revision: string
      summary: string
      findings: readonly { branchID: string; conclusion: string }[]
    }) {
      return yield* mutation(
        storage,
        input.sessionID,
        Effect.gen(function* () {
          const plan = yield* ledger.load(input.sessionID)
          if (!plan || plan.identity.requestID !== input.requestID || plan.identity.revision !== input.revision)
            throw new Error("Chief request plan changed before synthesis")
          const summary = input.summary.trim()
          if (!summary || summary.length > 4_000) throw new Error("Chief request synthesis needs a bounded summary")
          if (
            input.findings.length !== plan.branches.length ||
            new Set(input.findings.map((item) => item.branchID)).size !== plan.branches.length ||
            input.findings.some((item) => !plan.branches.some((branch) => branch.id === item.branchID))
          )
            throw new Error("Chief request synthesis must cover every branch exactly once")
          if (plan.branches.some((item) => item.state !== "completed" || !item.review))
            throw new Error("Chief request cannot synthesize incomplete, unknown, or unreviewed branches")
          const view = yield* inspect(input.sessionID)
          if (
            plan.branches.some((branch) => {
              const item = view.branches.find((entry) => entry.id === branch.id)
              return (
                !item?.report ||
                !item.evidence.some(
                  (evidence) =>
                    evidence.callID === branch.review?.callID &&
                    evidence.messageID === branch.review?.messageID &&
                    evidence.partID === branch.review?.partID,
                )
              )
            })
          )
            throw new Error("Chief request reviewed evidence is no longer available")
          const findings = plan.branches.map((branch) => {
            const conclusion = input.findings.find((item) => item.branchID === branch.id)?.conclusion.trim() ?? ""
            if (!conclusion || conclusion.length > 2_000)
              throw new Error(`Chief request synthesis needs a bounded conclusion for ${branch.name}`)
            return { branchID: branch.id, conclusion }
          })
          if (plan.synthesis) {
            if (
              plan.synthesis.summary === summary &&
              JSON.stringify(plan.synthesis.findings) === JSON.stringify(findings)
            )
              return plan.synthesis
            throw new Error("Chief request synthesis already has different conclusions")
          }
          const synthesis = { version: 1 as const, summary, findings, at: Date.now() }
          yield* storage.replace(ChiefRequestPlan.key(input.sessionID, input.requestID), {
            ...plan,
            synthesis,
          } satisfies ChiefRequestPlan.Record)
          return synthesis
        }),
      )
    })

    return { inspect, review, synthesize }
  }
}
