import { expect } from "bun:test"
import type { JSONSchema7 } from "@ai-sdk/provider"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { eq } from "drizzle-orm"
import {
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineJobContractTable as Contracts,
  RayaRoutineMessageTable as Inbox,
} from "@opencode-ai/core/kilocode/routine.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { MessageID, PartID } from "@/session/schema"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation, prompt, type Record as Request } from "@/kilocode/task/delegation"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { final } from "@/kilocode/task/final-report"
import * as JobContract from "@/kilocode/task/job-contract"
import { required as contractRequired } from "@/kilocode/task/job-contract-request"
import { continuation, owned } from "@/kilocode/task/continuation"
import { routineManagementTools } from "@/kilocode/tool/routine-management"
import * as Artifact from "@/kilocode/goal/artifact"
import * as AssignmentRefusal from "@/kilocode/task/assignment-refusal"
import { ownerContext } from "@/kilocode/task/request"
import * as RoutineWait from "@/kilocode/goal/routine-wait"
import * as RoutineEvidence from "@/kilocode/goal/routine-evidence"
import { RayaChief } from "@/kilocode/chief"
import { ToolRegistry } from "@/tool/registry"
import * as TaskSchema from "@/kilocode/tool/task-schema"
import * as ToolJsonSchema from "@/tool/json-schema"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"
import { provideTmpdirInstance } from "../fixture/fixture"
import type * as Tool from "@/tool/tool"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Truncate.node,
      Permission.node,
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      Storage.node,
      Database.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      ToolRegistry.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

it.live(
  "native contracted Routine completion requires its actual completed exact child stage",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        for (const text of [
          "Use native assign_organization_work without a contract.",
          "Do not use native assign_organization_work with a version1 contract.",
          "Explain how to use native assign_organization_work with a version1 contract.",
          '"Use native assign_organization_work with a version1 contract."',
          "```\nUse native assign_organization_work with a version1 contract.\n```",
          "~~~\nUse native assign_organization_work with a version1 contract.\n~~~",
          "\u201cExample:\nUse native assign_organization_work with a version1 contract.\u201d",
          "> Use native assign_organization_work with a version1 contract.",
          "Read-only status review. Use native assign_organization_work with a version1 contract.",
        ])
          expect(contractRequired(text)).toBe(false)
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const fs = yield* FSUtil.Service
        const tasks = RayaTask.make({ storage, database })
        const goals = RayaGoal.make({ storage, database, sessions })
        const starts = RayaTaskSnapshot.make({ storage })
        const catalog = yield* (yield* ToolRegistry.Service).all()
        const assign = catalog.find((tool) => tool.id === "assign_organization_work")
        const delegate = catalog.find((tool) => tool.id === "delegate_work")
        const update = catalog.find((tool) => tool.id === "update_goal")
        const read = catalog.find((tool) => tool.id === "read")
        const write = catalog.find((tool) => tool.id === "write")
        if (!assign || !delegate || !update || !read || !write)
          throw new Error("Actual native registry tools unavailable")
        const source = path.join(directory, "source.txt")
        yield* fs.writeFileString(source, "Actual approved source; no child completion is implied.\n")
        const criteria = [
          { id: "read", description: "Read the approved source", verification: "Cite the actual source Read receipt" },
        ]
        const busy = (agent: RayaTask.Agent) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({ title: "Reserved fixture; no inference" })
            return yield* tasks.record({
              id: crypto.randomUUID(),
              agentID: agent.id,
              sessionID: session.id,
              at: Date.now(),
              status: "running",
              trigger: { kind: "manual" },
              scheduleVersion: 1,
            })
          })
        const context = (
          sessionID: Session.Info["id"],
          messageID: MessageID,
          agent: string,
          callID: string,
        ): Tool.Context => ({
          sessionID,
          messageID,
          callID,
          agent,
          abort: AbortSignal.any([]),
          messages: [],
          extra: {},
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })
        for (const mode of ["failed", "completed"]) {
          const output = path.join(directory, `${mode}-builder.md`)
          const workers: RayaTask.Agent[] = []
          for (const name of ["Dispatch", "Researcher", "Builder"])
            workers.push(
              yield* tasks.create({
                name: `${mode} ${name}`,
                role: "generalist",
                objective: "Perform only the exact assigned stage",
                dir: directory,
                access: "full",
                tools: ["read", "write", "get_goal", "update_goal", "delegate_work", "inspect_team"],
                enabled: true,
                schedule: { kind: "manual" },
              }),
            )
          const dispatch = workers[0]
          const researcher = workers[1]
          const builder = workers[2]
          const organizations = RayaTaskOrganization.make(database, tasks, storage)
          const team = yield* organizations.create({
            name: `${mode} contract team`,
            purpose: "Verify exact native required-stage completion",
            members: workers.map((item) => ({ agentID: item.id, role: item.name })),
            delegations: [
              { senderID: dispatch.id, recipientID: researcher.id },
              { senderID: researcher.id, recipientID: builder.id },
            ],
          })
          const errands = RayaTaskDelegation.make(database, organizations.authorize, organizations.shares)
          const held = yield* busy(researcher)
          const reserved = yield* busy(builder)
          const proposal = yield* JobContract.decode({
            version: 1,
            entry: "research",
            stages: [
              {
                id: "research",
                recipientID: researcher.id,
                objective: "Read the approved source for the original stage",
                expected: "Verified original source and the actual completed required Builder stage",
                outputs: [],
                criteria,
                next: [{ stageID: "build", required: true }],
              },
              {
                id: "build",
                recipientID: builder.id,
                objective: "Read the approved source for the required child stage",
                expected: "Verified approved source and the exact own output when declared",
                outputs: mode === "completed" ? [output] : [],
                criteria:
                  mode === "completed"
                    ? [
                        {
                          id: "content",
                          description: "The own final file contains the required literal",
                          verification: "Cite a fresh complete native Read of the exact own output",
                          check: { kind: "file-content", path: output, literals: ["Builder consumed research."] },
                        },
                      ]
                    : criteria,
                next: [],
              },
            ],
          })
          const entry = proposal.stages[0]
          const next = proposal.stages[1]
          const owner = `Run one manual saved local team job through Dispatch -> Researcher -> Builder. Each stage reads ${source}; Builder must complete before Researcher completes. Use only ${directory}. Use native assign_organization_work with a version1 contract. Omit budget, deadline and context. Do not start an uncontracted legacy job.`
          const chat = yield* sessions.create({
            agent: "auto",
            metadata: { [RayaChief.requestKey]: owner, [RayaChief.phaseKey]: "route" },
          })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            role: "user",
            agent: "auto",
            model,
            time: { created: Date.now() },
          })
          const original = yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: user.id,
            type: "text",
            text: owner,
          })
          const sealed = InputReceipt.seal(user, [original])
          if (!sealed) throw new Error("Native original input publication could not be sealed")
          yield* sessions.updatePart(sealed)
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            parentID: user.id,
            role: "assistant",
            agent: "auto",
            mode: "auto",
            providerID: model.providerID,
            modelID: model.modelID,
            cost: 0,
            path: { cwd: directory, root: directory },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const wire = ToolJsonSchema.fromTool(assign)
          const fixed = yield* TaskSchema.prepare("assign_organization_work", wire, chat.id, assistant.id, "auto")
          expect(fixed.anyOf).toBeUndefined()
          expect(fixed.additionalProperties).toBe(false)
          expect(fixed.required).toEqual(
            expect.arrayContaining(["organizationID", "expectedRevision", "senderID", "contract"]),
          )
          for (const field of [
            "recipientID",
            "objective",
            "expected",
            "outputs",
            "criteria",
            "budget",
            "deadline",
            "context",
          ]) {
            expect(fixed.properties?.[field]).toBeUndefined()
            expect(fixed.required).not.toContain(field)
          }
          expect(fixed.properties?.contract).toMatchObject({
            properties: {
              stages: {
                items: {
                  required: expect.arrayContaining(["expected"]),
                  properties: {
                    expected: {
                      description: expect.stringContaining("Preserve the owner's exact expected result"),
                    },
                  },
                },
              },
            },
          })
          if (mode === "completed") {
            const scratch = yield* sessions.create({ agent: "auto" })
            const inspect = (text: string) =>
              Effect.gen(function* () {
                const source = yield* sessions.updateMessage({
                  ...user,
                  id: MessageID.ascending(),
                  sessionID: scratch.id,
                  time: { created: Date.now() },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  sessionID: scratch.id,
                  messageID: source.id,
                  type: "text",
                  text,
                })
                const response = yield* sessions.updateMessage({
                  ...assistant,
                  id: MessageID.ascending(),
                  sessionID: scratch.id,
                  parentID: source.id,
                  time: { created: Date.now() },
                })
                const schema: JSONSchema7 = yield* TaskSchema.prepare(
                  "assign_organization_work",
                  wire,
                  scratch.id,
                  response.id,
                  "auto",
                )
                return { response, schema }
              })
            const generic = yield* inspect(
              "Run one manual saved local team job through Dispatch -> Researcher -> Builder. Omit budget, deadline and context.",
            )
            expect(generic.schema.type).toBe("object")
            expect(generic.schema.additionalProperties).toBeUndefined()
            expect(generic.schema.anyOf).toHaveLength(2)
            const branches = generic.schema.anyOf
            if (!branches || branches.some((branch) => typeof branch !== "object"))
              throw new Error("Actual root assignment alternatives unavailable")
            const contract = branches[0]
            const legacy = branches[1]
            if (typeof contract !== "object" || typeof legacy !== "object")
              throw new Error("Actual complete assignment alternatives unavailable")
            expect(contract.required).toContain("contract")
            expect(contract.properties?.contract).toEqual(fixed.properties?.contract)
            for (const field of ["recipientID", "objective", "expected", "outputs", "criteria"]) {
              expect(contract.properties?.[field]).toBeUndefined()
              expect(contract.required).not.toContain(field)
            }
            expect(legacy.required).toEqual(expect.arrayContaining(["recipientID", "objective", "criteria", "outputs"]))
            expect(legacy.properties?.contract).toBeUndefined()
            for (const branch of [contract, legacy]) {
              expect(branch.additionalProperties).toBe(false)
              for (const field of ["budget", "deadline", "context"]) {
                expect(branch.properties?.[field]).toBeUndefined()
                expect(branch.required).not.toContain(field)
              }
            }
            const question = yield* inspect("Ask the saved Researcher which dated source it used.")
            expect(question.schema.anyOf).toHaveLength(2)
            const answer = question.schema.anyOf?.[1]
            if (!answer || typeof answer !== "object") throw new Error("Actual legacy question schema unavailable")
            expect(answer.required).toEqual(expect.arrayContaining(["recipientID", "objective"]))
            expect(answer.required).not.toContain("criteria")
            expect(answer.required).not.toContain("outputs")
            expect(
              yield* TaskSchema.prepare("assign_organization_work", wire, scratch.id, generic.response.id, "auto"),
            ).toEqual(wire)
            expect(
              yield* TaskSchema.prepare("assign_organization_work", wire, scratch.id, assistant.id, "auto"),
            ).toEqual(wire)
          }
          const invoke = (ctx: Tool.Context, tool: Tool.Def, input: Record<string, unknown>) =>
            Effect.gen(function* () {
              const id = PartID.ascending()
              const start = Date.now()
              yield* sessions.updatePart({
                id,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "tool",
                tool: tool.id,
                callID: ctx.callID!,
                state: { status: "running", input, time: { start } },
              })
              const session = yield* sessions.get(ctx.sessionID)
              const result = yield* owned({ database, storage, sessions, session }, tool.execute(input, ctx))
              if (!result) throw new Error("Actual original tool execution was not admitted")
              yield* sessions.updatePart({
                id,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                type: "tool",
                tool: tool.id,
                callID: ctx.callID!,
                state: {
                  status: "completed",
                  input,
                  output: result.output,
                  title: result.title,
                  metadata: result.metadata,
                  time: { start, end: Date.now() },
                },
              })
              return result
            })
          const minimal = {
            organizationID: team.id,
            expectedRevision: team.revision,
            senderID: dispatch.id,
            contract: proposal,
          }
          const params = {
            ...minimal,
            recipientID: entry.recipientID,
            objective: entry.objective,
            expected: entry.expected,
            outputs: entry.outputs,
            criteria: entry.criteria,
          }
          const pending = yield* database.db.select().from(Delegation).all()
          const captures = yield* database.db.select().from(Contracts).all()
          const history = yield* tasks.runsFor(researcher.id)
          const omitted = Object.fromEntries(Object.entries(params).filter((entry) => entry[0] !== "contract"))
          const refused = yield* invoke(
            context(chat.id, assistant.id, "auto", `omit-contract-${mode}`),
            assign,
            omitted,
          )
          expect(refused.metadata.requestStatus).toBe("unresolved")
          expect(refused.output).toContain("requires an immutable job contract")
          expect(yield* database.db.select().from(Delegation).all()).toEqual(pending)
          expect(yield* database.db.select().from(Contracts).all()).toEqual(captures)
          expect(yield* tasks.runsFor(researcher.id)).toEqual(history)
          const mixed = yield* invoke(context(chat.id, assistant.id, "auto", `conflict-${mode}`), assign, {
            ...minimal,
            objective: "Replace the frozen entry objective",
          })
          expect(mixed.metadata.requestStatus).toBe("unresolved")
          expect(yield* database.db.select().from(Delegation).all()).toEqual(pending)
          expect(yield* database.db.select().from(Contracts).all()).toEqual(captures)
          expect(yield* tasks.runsFor(researcher.id)).toEqual(history)
          const selected = mode === "completed" ? minimal : params
          const admitted = yield* invoke(context(chat.id, assistant.id, "auto", `assign-${mode}`), assign, selected)
          expect(admitted.metadata.requestStatus).toBe("complete")
          const published = (yield* sessions.messages({ sessionID: chat.id }))
            .flatMap((item) => item.parts)
            .find((part) => part.type === "tool" && part.callID === `assign-${mode}`)
          expect(published?.type === "tool" ? published.state.input : undefined).toEqual(selected)
          const metadata: Record<string, unknown> = admitted.metadata
          if (typeof metadata.delegationID !== "string") throw new Error("Native contract admission has no request")
          const row = yield* errands.get(metadata.delegationID)
          expect(row.recipientID).toBe(entry.recipientID)
          expect(row.objective).toBe(entry.objective)
          expect(row.expected).toBe(entry.expected)
          expect(row.outputs).toEqual(entry.outputs)
          expect(row.criteria).toEqual(entry.criteria)
          const reference = yield* Schema.decodeUnknownEffect(JobContract.Reference)(
            "contract" in row ? row.contract : undefined,
          )
          expect(reference.stageID).toBe("research")
          const open = (agent: RayaTask.Agent, row: Request, sender: RayaTask.Agent, held: RayaTask.Run) =>
            Effect.gen(function* () {
              yield* tasks.transition(held, { ...held, status: "complete" })
              const selected = yield* errands.take(agent.id)
              if (!selected?.childRunID || selected.id !== row.id) throw new Error("Exact declared stage not reserved")
              const contract = yield* Schema.decodeUnknownEffect(JobContract.Reference)(
                "contract" in selected ? selected.contract : undefined,
              )
              const session = yield* sessions.create({
                agent: "generalist",
                permission: RayaTask.rules(agent, directory),
                metadata: {
                  rayaRoutine: {
                    version: 3,
                    agentID: agent.id,
                    runID: selected.childRunID,
                    scheduleVersion: 1,
                    trigger: { kind: "manual" },
                    delegationID: row.id,
                    organizationID: team.id,
                    organizationRevision: team.revision,
                    outputs: row.outputs,
                    contract,
                  },
                },
              })
              const input = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                agent: "generalist",
                model,
                time: { created: Date.now() },
              })
              const objective = prompt(sender, agent, row)
              yield* sessions.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: input.id,
                type: "text",
                text: objective,
              })
              const goal = yield* goals.create(
                session.id,
                objective,
                input.id,
                undefined,
                undefined,
                row.criteria,
                undefined,
                undefined,
                { agentID: agent.id, runID: selected.childRunID, sessionID: session.id, contract },
              )
              yield* goals.initial(session.id, goal.intent!, "actual-contract-fixture")
              const run = yield* tasks.record({
                id: selected.childRunID,
                agentID: agent.id,
                sessionID: session.id,
                at: Date.now(),
                status: "running",
                scheduleVersion: 1,
                trigger: { kind: "manual" },
                goalCreatedAt: goal.createdAt,
                contract,
              })
              const snapshot = yield* Schema.decodeUnknownEffect(RayaTaskSnapshot.Info)({
                version: 3,
                runID: run.id,
                sessionID: session.id,
                agentID: agent.id,
                at: run.at,
                definition: agent,
                objective,
                outputs: row.outputs,
                contract,
              })
              yield* starts.save(snapshot)
              yield* errands.attach(row.id, run.id, session.id)
              const reply = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: input.id,
                role: "assistant",
                agent: "generalist",
                mode: "generalist",
                providerID: model.providerID,
                modelID: model.modelID,
                cost: 0,
                path: { cwd: directory, root: directory },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now() },
              })
              const admission = { database, storage, sessions, session }
              expect(yield* continuation(admission)).toBe(true)
              expect(yield* owned(admission, Effect.succeed("actual-contract-body"))).toBe("actual-contract-body")
              return { session, input, reply, goal, run, contract }
            })
          const root = yield* open(researcher, row, dispatch, held)
          const delegation = ToolJsonSchema.fromTool(delegate)
          const grammar = yield* TaskSchema.prepare(
            "delegate_work",
            delegation,
            root.session.id,
            root.reply.id,
            "generalist",
          )
          expect(grammar.required).toEqual(["stageID"])
          expect(grammar.additionalProperties).toBe(false)
          expect(grammar.properties?.stageID).toEqual({ type: "string", enum: ["build"] })
          for (const field of [
            "organizationID",
            "expectedRevision",
            "recipientID",
            "objective",
            "expected",
            "context",
            "outputs",
            "criteria",
          ])
            expect(grammar.properties?.[field]).toBeUndefined()
          expect(grammar.properties?.artifacts).toEqual(delegation.properties?.artifacts)
          const envelope = ToolEnvelope.schema(
            [{ function: { name: "delegate_work", parameters: { ...grammar } } }],
            "required",
          )
          expect(envelope.anyOf[0]).toMatchObject({
            properties: { arguments: { required: ["stageID"], properties: { stageID: { enum: ["build"] } } } },
          })
          const legacy = yield* TaskSchema.prepare("delegate_work", delegation, chat.id, assistant.id, "auto")
          expect(legacy.properties?.objective).toEqual(delegation.properties?.objective)
          expect(legacy.properties?.stageID).toEqual(delegation.properties?.stageID)
          expect(legacy.required).not.toContain("stageID")
          const marker = root.session.metadata?.rayaRoutine
          if (!marker || typeof marker !== "object") throw new Error("Actual parent Routine identity missing")
          yield* sessions.setMetadata({
            sessionID: root.session.id,
            metadata: {
              ...root.session.metadata,
              rayaRoutine: { ...marker, contract: { ...root.contract, stageID: "build" } },
            },
          })
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                TaskSchema.prepare("delegate_work", delegation, root.session.id, root.reply.id, "generalist"),
              ),
            ),
          ).toBe(true)
          yield* sessions.setMetadata({ sessionID: root.session.id, metadata: root.session.metadata ?? {} })
          const ctx = (target: typeof root, callID: string) =>
            context(target.session.id, target.reply.id, "generalist", callID)
          yield* invoke(ctx(root, "root-read"), read, { filePath: source })
          const complete = (callID: string, criterion = criteria[0]) => ({
            status: "complete",
            summary: "Actual source read verified",
            requirements: [
              {
                criterionID: criterion.id,
                requirement: criterion.description,
                passed: true,
                evidence: [{ callID, summary: "Native Read returned the actual approved source" }],
              },
            ],
          })
          const missing = yield* invoke(ctx(root, "missing-required-stage"), update, complete("root-read"))
          expect(missing.title).toBe("Completion audit rejected")
          expect((yield* goals.get(root.session.id))?.status).toBe("active")
          expect((yield* goals.get(root.session.id))?.auditAttempt?.accepted).toBe(false)
          const unknown = yield* invoke(ctx(root, "wrong-child-stage"), delegate, { stageID: "unknown" })
          expect(unknown.metadata.requestStatus).not.toBe("complete")
          const conflict = yield* invoke(ctx(root, "changed-child-stage"), delegate, {
            stageID: next.id,
            objective: "Replace the owner's frozen objective",
          })
          expect(conflict.metadata.requestStatus).not.toBe("complete")
          const handoff = yield* invoke(ctx(root, "exact-child-stage"), delegate, {
            stageID: next.id,
          })
          expect(handoff.metadata.requestStatus).toBe("complete")
          const receipt: Record<string, unknown> = handoff.metadata
          if (typeof receipt.delegationID !== "string") throw new Error("Actual child admission has no request")
          const assigned = yield* errands.get(receipt.delegationID)
          expect(assigned.recipientID).toBe(next.recipientID)
          expect(assigned.objective).toBe(next.objective)
          expect(assigned.criteria).toEqual(next.criteria)
          expect(assigned.outputs).toEqual(next.outputs)
          const child = yield* open(builder, assigned, researcher, reserved)
          expect(child.contract).toEqual({ ...reference, stageID: "build" })
          expect(child.goal.criteria).toEqual(next.criteria)
          const snapshot = yield* starts.get(child.run.id)
          expect(snapshot.contract).toEqual(child.contract)
          expect(snapshot.outputs).toEqual(next.outputs)
          const stored = yield* database.db.select().from(Contracts).where(eq(Contracts.id, reference.id)).get()
          if (!stored) throw new Error("Actual immutable contract missing")
          const captured = yield* JobContract.decode(JSON.parse(stored.proposal))
          expect(captured.stages.find((stage) => stage.id === next.id)?.criteria).toEqual(next.criteria)
          const leaf = yield* TaskSchema.prepare(
            "delegate_work",
            delegation,
            child.session.id,
            child.reply.id,
            "generalist",
          )
          expect(leaf.required).toEqual(["stageID"])
          expect(leaf.properties?.stageID).toEqual({
            type: "string",
            description: "This is a final stage with no allowed next stage. Do not call delegate_work.",
          })
          const terminal = ToolEnvelope.schema(
            [{ function: { name: "delegate_work", parameters: { ...leaf } } }],
            "required",
          )
          expect(terminal.anyOf[0]).toMatchObject({
            properties: { arguments: { properties: { stageID: { type: "string" } } } },
          })
          expect(JSON.stringify(terminal)).not.toContain('"enum":[]')
          const extra = yield* invoke(ctx(child, "no-onward-stage"), delegate, { stageID: "research" })
          expect(extra.metadata.requestStatus).not.toBe("complete")
          const running = yield* invoke(ctx(root, "running-required-stage"), update, complete("root-read"))
          expect(running.title).toBe("Completion audit rejected")
          yield* invoke(ctx(child, "child-read"), read, { filePath: source })
          if (mode === "failed") {
            yield* tasks.transition(child.run, {
              ...child.run,
              status: "error",
              outcome: { kind: "notify", summary: "Required native child did not complete", cost: 0 },
            })
            yield* errands.finish(assigned.id, "failed", builder, undefined, 0, "Required child failed")
            const failed = yield* invoke(ctx(root, "failed-required-stage"), update, complete("root-read"))
            expect(failed.title).toBe("Completion audit rejected")
            expect((yield* goals.get(root.session.id))?.status).toBe("active")
            expect((yield* errands.get(assigned.id)).state).toBe("failed")
            continue
          }
          yield* invoke(ctx(child, "wrong-child-write"), write, {
            filePath: output,
            content: "Actual child output omits its required literal.\n",
          })
          yield* invoke(ctx(child, "wrong-child-read"), read, { filePath: output })
          const literal = yield* invoke(
            ctx(child, "missing-child-literal"),
            update,
            complete("wrong-child-read", next.criteria[0]),
          )
          expect(literal.title).toBe("Completion audit rejected")
          expect((yield* goals.get(child.session.id))?.status).toBe("active")
          expect((yield* goals.get(child.session.id))?.auditAttempt?.accepted).toBe(false)
          yield* invoke(ctx(child, "correct-child-write"), write, {
            filePath: output,
            content: "Builder consumed research.\n",
          })
          const stale = yield* invoke(
            ctx(child, "stale-child-read"),
            update,
            complete("wrong-child-read", next.criteria[0]),
          )
          expect(stale.title).toBe("Completion audit rejected")
          expect((yield* goals.get(child.session.id))?.status).toBe("active")
          expect((yield* goals.get(child.session.id))?.auditAttempt?.accepted).toBe(false)
          yield* invoke(ctx(child, "fresh-child-read"), read, { filePath: output })
          const audited = yield* invoke(
            ctx(child, "complete-child"),
            update,
            complete("fresh-child-read", next.criteria[0]),
          )
          expect(audited.metadata.status).toBe("complete")
          expect(audited.output).toContain("Summarize only this stage's actual completed findings")
          expect(audited.output).toContain("approved final-file bytes")
          expect(audited.output).toContain("preserve those requirements instead of the default concise summary")
          expect(audited.output).toContain("Literal file-content requirements apply to the declared files")
          expect(audited.output).not.toContain(child.goal.objective)
          expect(audited.output).not.toContain("Original goal objective:")
          const summary = "The declared child stage read the approved source; no further work is claimed."
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: child.session.id,
            messageID: child.reply.id,
            type: "text",
            text: summary,
          })
          yield* sessions.updateMessage({
            ...child.reply,
            finish: "stop",
            time: { ...child.reply.time, completed: Date.now() },
          })
          yield* goals.finished(child.session.id, child.reply.id)
          const done = yield* goals.get(child.session.id)
          if (!done) throw new Error("Actual completed child Goal missing")
          const result = final(child.run, done, yield* sessions.messages({ sessionID: child.session.id }))
          if (!result) throw new Error("Actual child final report is not authenticated")
          yield* tasks.transition(child.run, {
            ...child.run,
            status: "complete",
            outcome: { kind: "notify", summary, report: result.report, cost: 0 },
          })
          yield* errands.finish(assigned.id, "completed", builder, summary, 0)
          const saved = child.session.metadata
          const identity = saved?.rayaRoutine
          if (!identity || typeof identity !== "object" || Array.isArray(identity))
            throw new Error("Actual child Routine identity missing")
          yield* sessions.setMetadata({
            sessionID: child.session.id,
            metadata: {
              ...saved,
              rayaRoutine: { ...identity, contract: { ...child.contract, stageID: "research" } },
            },
          })
          const prior = yield* goals.get(root.session.id)
          const attempted = Date.now()
          const wrong = yield* invoke(ctx(root, "wrong-child-stage"), update, complete("root-read"))
          expect(wrong.title).toBe("Completion audit rejected")
          const rejected = yield* goals.get(root.session.id)
          expect(rejected?.status).toBe("active")
          expect(rejected?.auditAttempt?.accepted).toBe(false)
          expect(rejected?.auditAttempt?.at).toBeGreaterThanOrEqual(attempted)
          expect(rejected?.auditAttempt?.reason).toContain("unavailable or changed")
          expect(rejected?.auditAttempt?.reason).not.toBe(prior?.auditAttempt?.reason)
          yield* sessions.setMetadata({ sessionID: child.session.id, metadata: saved ?? {} })
          const accepted = yield* invoke(ctx(root, "complete-original-stage"), update, complete("root-read"))
          expect(accepted.metadata.status).toBe("complete")
          expect((yield* goals.get(root.session.id))?.auditAttempt?.accepted).toBe(true)
          expect((yield* errands.get(assigned.id)).state).toBe("completed")
        }
      }),
    ),
  120000,
)

it.live(
  "irreducible original owner context produces a native refusal without another model or assignment",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const info = yield* routineManagementTools({ storage, database, sessions }).assignOrganizationWork
        const tool = yield* info.init()
        const prefix = "Run one manual saved local team job through Dispatch -> Researcher -> Builder -> Sales. "
        for (const length of [4200, 3990, 100]) {
          const owner = prefix.padEnd(length, "x")
          const session = yield* sessions.create({
            agent: "auto",
            metadata: { [RayaChief.requestKey]: owner, [RayaChief.phaseKey]: "route" },
          })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "auto",
            model,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: user.id,
            type: "text",
            text: owner,
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            parentID: user.id,
            role: "assistant",
            agent: "auto",
            mode: "auto",
            providerID: model.providerID,
            modelID: model.modelID,
            cost: 0,
            path: { cwd: directory, root: directory },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const callID = `owner-limit-${length}`
          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: assistant.id,
            callID,
            agent: "auto",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.die("Pre-admission refusal must not ask for permission"),
          }
          const params = {
            organizationID: `org_${"a".repeat(32)}`,
            expectedRevision: 1,
            senderID: "sender",
            recipientID: "recipient",
            objective: "Read the assigned source",
            outputs: [],
            criteria: [
              { id: "read", description: "Read the approved source", verification: "Cite the actual Read receipt" },
            ],
            ...(length === 100 ? { context: "y".repeat(3990) } : {}),
          }
          const id = PartID.ascending()
          const start = Date.now()
          yield* sessions.updatePart({
            id,
            sessionID: session.id,
            messageID: assistant.id,
            type: "tool",
            tool: "assign_organization_work",
            callID,
            state: { status: "running", input: params, time: { start } },
          })
          const result = yield* tool.execute(params, ctx)
          expect(result.metadata.requestStatus).toBe("unresolved")
          expect(result.output).toContain("4000-character context limit")
          yield* sessions.updatePart({
            id,
            sessionID: session.id,
            messageID: assistant.id,
            type: "tool",
            tool: "assign_organization_work",
            callID,
            state: {
              status: "completed",
              input: params,
              output: result.output,
              title: result.title,
              metadata: result.metadata,
              time: { start, end: Date.now() },
            },
          })
          yield* sessions.updateMessage({
            ...assistant,
            finish: "tool-calls",
            time: { created: assistant.time.created, completed: Date.now() },
          })
          const metadata: Record<string, unknown> = result.metadata
          if (length === 100) {
            expect(metadata[AssignmentRefusal.key]).toBeUndefined()
            expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(false)
            continue
          }
          expect(metadata[AssignmentRefusal.key]).toMatchObject({ userID: user.id, messageID: assistant.id, callID })
          expect(ownerContext(owner).length).toBeGreaterThan(4000)
          const failed = yield* sessions.updateMessage({
            ...assistant,
            id: MessageID.ascending(),
            error: { name: "UnknownError", data: { message: "Later parent failure" } },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: failed.id,
            type: "tool",
            tool: "assign_organization_work",
            callID: "accepted-before-error",
            state: {
              status: "completed",
              input: params,
              output: "Actually accepted",
              title: "Assignment",
              metadata: { requestStatus: "complete", delegationID: "actual-side-effect" },
              time: { start, end: Date.now() },
            },
          })
          expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(false)
          yield* sessions.removeMessage({ sessionID: session.id, messageID: failed.id })
          expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(true)
          const after = yield* sessions.messages({ sessionID: session.id })
          const last = after.at(-1)
          expect(last?.info.role).toBe("assistant")
          expect(last?.parts.find((part) => part.type === "text")?.text).toContain(
            `requires ${ownerContext(owner).length} characters`,
          )
          expect(last?.parts.find((part) => part.type === "text")?.text).toContain("This team job was not started")
          expect(yield* AssignmentRefusal.finish(sessions, session.id, user.id)).toBe(true)
          expect((yield* sessions.messages({ sessionID: session.id })).length).toBe(after.length)
          expect(
            (yield* sessions.messages({ sessionID: session.id }))
              .find((row) => row.info.id === user.id)
              ?.parts.find((part) => part.type === "text")?.text,
          ).toBe(owner)
        }
        expect(yield* database.db.select().from(Delegation).all()).toEqual([])
        expect(yield* RayaTask.make({ storage, database }).list()).toEqual([])
      }),
    ),
  60000,
)

it.live(
  "resumed Routine goal can audit actual current-run child handoff without granting output ownership",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const fs = yield* FSUtil.Service
        const tasks = RayaTask.make({ storage, database })
        const goals = RayaGoal.make({ storage, database, sessions })
        const starts = RayaTaskSnapshot.make({ storage })
        const workers: RayaTask.Agent[] = []
        for (const name of ["Dispatch", "Researcher", "Builder", "Sales"])
          workers.push(
            yield* tasks.create({
              name,
              role: "generalist",
              objective: "Perform assigned work",
              capabilities: [],
              dir: directory,
              access: "full",
              tools: ["get_goal", "update_goal", "read", "write", "delegate_work", "inspect_team"],
              schedule: { kind: "manual" },
              output: {
                destination: "conversation",
                description: "Produce assigned files and handoff",
                criteria: [
                  {
                    id: "handoff",
                    description: "Hand off the produced files",
                    verification: "Use an accepted delegate_work receipt with actual file artifacts",
                  },
                ],
              },
            }),
          )
        const dispatch = workers[0]
        const researcher = workers[1]
        const builder = workers[2]
        const sales = workers[3]
        const organizations = RayaTaskOrganization.make(database, tasks, storage)
        const team = yield* organizations.create({
          name: "Evidence team",
          purpose: "Read-only evidence bridge fixture",
          members: workers.map((item) => ({ agentID: item.id, role: item.name })),
          delegations: [
            { senderID: dispatch.id, recipientID: researcher.id },
            { senderID: researcher.id, recipientID: builder.id },
            { senderID: builder.id, recipientID: sales.id },
          ],
        })
        const errands = RayaTaskDelegation.make(database, organizations.authorize, organizations.shares)
        const criteria = [
          {
            id: "handoff",
            description: "Hand off the produced files",
            verification: "Use an accepted delegate_work receipt with actual file artifacts",
          },
        ]
        const files = ["research.md", "index.html", "builder-brief.md"].map((file) => path.join(directory, file))
        const seed = yield* errands.admit(
          {
            source: "test:original-owner",
            senderID: dispatch.id,
            recipientID: researcher.id,
            organizationID: team.id,
            organizationRevision: team.revision,
            objective:
              "Create research.md and hand it to Builder; accept Builder's actual two-file onward handoff receipt",
            criteria,
            outputs: [files[0]],
          },
          dispatch,
          researcher,
        )
        const open = (agent: RayaTask.Agent, row: Request, sender: RayaTask.Agent) =>
          Effect.gen(function* () {
            const admitted = yield* errands.take(agent.id)
            if (!admitted?.childRunID || admitted.id !== row.id)
              throw new Error("Actual queued delegation was not reserved")
            const rid = admitted.childRunID
            const session = yield* sessions.create({
              agent: "generalist",
              metadata: {
                rayaRoutine: {
                  version: 1,
                  agentID: agent.id,
                  runID: rid,
                  scheduleVersion: 1,
                  trigger: { kind: "manual" },
                  delegationID: row.id,
                  organizationID: team.id,
                  organizationRevision: team.revision,
                  outputs: row.outputs,
                },
              },
              permission: RayaTask.rules(agent, directory),
            })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: "generalist",
              model,
              time: { created: Date.now() },
            })
            const objective = prompt(sender, agent, row)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: user.id,
              type: "text",
              text: objective,
            })
            const goal = yield* goals.create(
              session.id,
              objective,
              user.id,
              undefined,
              undefined,
              row.criteria,
              undefined,
              undefined,
              { agentID: agent.id, runID: rid, sessionID: session.id },
            )
            yield* goals.initial(session.id, goal.intent!, "actual-fixture")
            const run = yield* tasks.record({
              id: rid,
              agentID: agent.id,
              sessionID: session.id,
              at: Date.now(),
              status: "running",
              trigger: { kind: "manual" },
              scheduleVersion: 1,
              goalCreatedAt: goal.createdAt,
            })
            yield* starts.save({
              version: 2,
              runID: rid,
              sessionID: session.id,
              agentID: agent.id,
              at: run.at,
              definition: agent,
              objective,
              outputs: row.outputs,
            })
            yield* errands.attach(row.id, rid, session.id)
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              parentID: user.id,
              role: "assistant",
              agent: "generalist",
              mode: "generalist",
              providerID: model.providerID,
              modelID: model.modelID,
              cost: 0,
              path: { cwd: directory, root: directory },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            })
            const ctx = (callID: string): Tool.Context => ({
              sessionID: session.id,
              messageID: assistant.id,
              callID,
              agent: "generalist",
              abort: AbortSignal.any([]),
              messages: [],
              extra: {},
              metadata: () => Effect.void,
              ask: () => Effect.void,
            })
            return { session, user, assistant, run, goal, ctx }
          })
        const root = yield* open(researcher, seed.record, dispatch)
        const busy = (agent: RayaTask.Agent) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({ title: "Busy fixture prevents inference" })
            return yield* tasks.record({
              id: crypto.randomUUID(),
              agentID: agent.id,
              sessionID: session.id,
              at: Date.now(),
              status: "running",
              trigger: { kind: "manual" },
              scheduleVersion: 1,
            })
          })
        const held = yield* busy(builder)
        yield* busy(sales)
        const write = (target: typeof root, file: string, callID: string) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(file, `Actual authored ${path.basename(file)}\n`)
            const revision = yield* Artifact.capture(fs, file)
            if (revision.status !== "captured") throw new Error("Actual file capture failed")
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: target.session.id,
              messageID: target.assistant.id,
              type: "tool",
              tool: "write",
              callID,
              state: {
                status: "completed",
                input: { filePath: file },
                output: "Actual file saved",
                title: "Saved file",
                metadata: { rayaRevision: revision },
                time: { start: Date.now(), end: Date.now() },
              },
            })
          })
        const tools = routineManagementTools({ storage, database, sessions })
        const tool = yield* tools.delegateWork
        const delegate = yield* tool.init()
        const handoff = (
          target: typeof root,
          agent: RayaTask.Agent,
          input: string[],
          outputs: string[],
          callID: string,
        ) =>
          Effect.gen(function* () {
            const params = {
              organizationID: team.id,
              expectedRevision: team.revision,
              recipientID: agent.id,
              objective: "Save assigned files and pass actual produced files onward",
              artifacts: input,
              outputs,
              criteria,
            }
            const id = PartID.ascending()
            const start = Date.now()
            yield* sessions.updatePart({
              id,
              sessionID: target.session.id,
              messageID: target.assistant.id,
              type: "tool",
              tool: "delegate_work",
              callID,
              state: { status: "running", input: params, time: { start } },
            })
            const result = yield* delegate.execute(params, target.ctx(callID))
            expect(result.metadata.requestStatus).toBe("complete")
            yield* sessions.updatePart({
              id,
              sessionID: target.session.id,
              messageID: target.assistant.id,
              type: "tool",
              tool: "delegate_work",
              callID,
              state: {
                status: "completed",
                input: params,
                output: result.output,
                title: result.title,
                metadata: result.metadata,
                time: { start, end: Date.now() },
              },
            })
            const metadata: Record<string, unknown> = result.metadata
            if (typeof metadata.delegationID !== "string") throw new Error("Actual delegation ID unavailable")
            return yield* errands.get(metadata.delegationID)
          })
        yield* write(root, files[0], "research-write")
        const assigned = yield* handoff(root, builder, [files[0]], files.slice(1), "research-handoff")
        yield* tasks.transition(held, { ...held, status: "complete" })
        const child = yield* open(builder, assigned, researcher)
        const catalog = yield* (yield* ToolRegistry.Service).all()
        const update = catalog.find((tool) => tool.id === "update_goal")
        const get = catalog.find((tool) => tool.id === "get_goal")
        if (!update || !get) throw new Error("Production model-facing Goal tools are unavailable")
        const premature = {
          status: "complete" as const,
          summary: "Claimed finished from the accepted initial handoff",
          requirements: [
            {
              criterionID: "handoff",
              requirement: criteria[0].description,
              passed: true,
              evidence: [
                { callID: "research-handoff", summary: "Researcher handed its actual research file to Builder." },
              ],
            },
          ],
        }
        const at = Date.now()
        const attempt = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: root.session.id,
          messageID: root.assistant.id,
          type: "tool",
          tool: "update_goal",
          callID: "premature-complete",
          state: { status: "running", input: premature, time: { start: at } },
        })
        const refused = yield* update.execute(premature, root.ctx("premature-complete"))
        const refusal = yield* goals.get(root.session.id)
        expect(refused.title).toBe("Completion audit rejected")
        expect(refused.output).toContain("still owns accepted child work")
        expect(refused.output).toContain(assigned.id)
        expect(refused.output).toContain('status="blocked"')
        expect(refusal?.status).toBe("active")
        expect(refusal?.auditAttempt?.accepted).toBe(false)
        expect(refusal?.auditAttempt?.requirements[0].passed).toBe(true)
        expect((yield* errands.get(assigned.id)).state).toBe("running")
        yield* sessions.updatePart({
          ...attempt,
          state: {
            status: "completed",
            input: premature,
            title: refused.title,
            output: refused.output,
            metadata: refused.metadata,
            time: { start: at, end: Date.now() },
          },
        })
        const blocked = { status: "blocked" as const, reason: "Awaiting Builder" }
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: root.session.id,
          messageID: root.assistant.id,
          type: "tool",
          tool: "update_goal",
          callID: "wait-for-builder",
          state: { status: "running", input: blocked, time: { start: Date.now() } },
        })
        const current = yield* goals.get(root.session.id)
        if (!current) throw new Error("Current Goal disappeared before streaming fixture")
        let reads = 0
        const streamed = yield* RoutineEvidence.observe({
          database,
          storage,
          goal: current,
          rows: yield* sessions.messages({ sessionID: root.session.id }),
          sessions: {
            get: sessions.get,
            messages: (input) =>
              sessions.messages(input).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (input.sessionID !== root.session.id || ++reads !== 1) return
                    yield* sessions.updateMessage({
                      ...root.assistant,
                      finish: "tool-calls",
                      tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                    })
                    yield* sessions.updatePart({
                      id: PartID.ascending(),
                      sessionID: root.session.id,
                      messageID: root.assistant.id,
                      type: "text",
                      text: "Streaming completion; no additional work receipt.",
                    })
                  }),
                ),
              ),
          },
        }).pipe(Effect.exit)
        expect(Exit.isSuccess(streamed)).toBe(true)
        const receipt = (yield* sessions.messages({ sessionID: root.session.id }))
          .flatMap((row) => row.parts)
          .find((part) => part.type === "tool" && part.callID === "research-handoff")
        if (!receipt || receipt.type !== "tool" || receipt.state.status !== "completed")
          throw new Error("Actual accepted receipt disappeared")
        const state = receipt.state
        let changed = false
        const spliced = yield* RoutineEvidence.observe({
          database,
          storage,
          goal: current,
          rows: yield* sessions.messages({ sessionID: root.session.id }),
          sessions: {
            get: sessions.get,
            messages: (input) =>
              sessions.messages(input).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (input.sessionID !== root.session.id || changed) return
                    changed = true
                    yield* sessions.updatePart({
                      ...receipt,
                      state: { ...state, metadata: { ...state.metadata, parentRunID: "foreign-run" } },
                    })
                  }),
                ),
              ),
          },
        }).pipe(Effect.exit)
        expect(Exit.isFailure(spliced)).toBe(true)
        yield* sessions.updatePart(receipt)
        const output = yield* update.execute(blocked, root.ctx("wait-for-builder"))
        const waiting = yield* goals.get(root.session.id)
        if (!waiting) throw new Error("Model-facing Goal update removed the Goal")
        expect(output.metadata.status).toBe("paused")
        expect(output.title).toBe("Waiting for delegated worker")
        expect(output.output).toContain("This same run and its accepted child remain active")
        expect(output.output).toContain("Do not resume this goal yourself, repeat the handoff, or poll for updates")
        expect(output.output).not.toContain("You paused this goal yourself")
        const rejected = yield* update.execute({ status: "complete" }, root.ctx("audit-while-waiting"))
        expect(rejected.title).toBe("Waiting for delegated worker")
        expect(rejected.metadata.status).toBe("paused")
        expect(rejected.output).toBe(output.output)
        expect(rejected.output).not.toContain("You paused this goal yourself")
        expect(waiting.status).toBe("paused")
        expect(waiting.pause).toBe("agent")
        expect((yield* errands.get(seed.record.id)).state).toBe("running")
        yield* sessions.updatePart({
          ...part,
          type: "tool",
          tool: "update_goal",
          callID: "wait-for-builder",
          state: {
            status: "completed",
            input: blocked,
            output: "Waiting for the original child",
            title: "Waiting",
            metadata: { status: "paused" },
            time: { start: Date.now(), end: Date.now() },
          },
        })
        expect(yield* RoutineWait.parked(storage, root.session.id, root.user.id)).toBe(true)
        yield* goals.control(root.session.id, "paused")
        expect(
          (yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))).resumed,
        ).toBe(false)
        expect((yield* goals.get(root.session.id))?.pause).toBe("user-control")
        yield* storage.replace(["raya", "goal", root.session.id], waiting)
        yield* write(child, files[1], "builder-html")
        yield* write(child, files[2], "builder-brief")
        const privatefile = path.join(directory, "private-source.txt")
        yield* fs.writeFileString(privatefile, "PRIVATE INPUT MUST NOT CROSS THE ROUTINE BRIDGE\n")
        const privateproof = yield* Artifact.capture(fs, privatefile)
        if (privateproof.status !== "captured") throw new Error("Actual private input capture failed")
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.session.id,
          messageID: child.assistant.id,
          type: "tool",
          tool: "read",
          callID: "builder-private-input",
          state: {
            status: "completed",
            input: { filePath: privatefile },
            output: yield* fs.readFileString(privatefile),
            title: "Private source read",
            metadata: { rayaRevision: privateproof },
            time: { start: Date.now(), end: Date.now() },
          },
        })
        const onward = yield* handoff(child, sales, files.slice(1), [], "builder-sales-handoff")
        expect(onward.artifacts).toHaveLength(2)
        const continuation = yield* sessions.updateMessage({
          ...child.user,
          id: MessageID.ascending(),
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.session.id,
          messageID: continuation.id,
          type: "text",
          synthetic: true,
          text: "Continue the same accepted assignment.",
        })
        yield* goals.follow(child.session.id, child.goal.intent!, continuation.id, "actual-child-continuation")
        child.assistant = yield* sessions.updateMessage({
          ...child.assistant,
          id: MessageID.ascending(),
          parentID: continuation.id,
          time: { created: Date.now() },
        })
        expect((yield* goals.get(child.session.id))?.inputs).toHaveLength(2)
        yield* goals.update(child.session.id, {
          status: "complete",
          summary: "Actual child handoff",
          requirements: [
            {
              criterionID: "handoff",
              requirement: criteria[0].description,
              passed: true,
              evidence: [{ callID: "builder-sales-handoff", summary: "Actual two-file accepted handoff" }],
            },
          ],
        })
        const summary = "Builder handed both actual files to Sales."
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.session.id,
          messageID: child.assistant.id,
          type: "text",
          text: summary,
        })
        yield* sessions.updateMessage({
          ...child.assistant,
          finish: "stop",
          time: { created: child.assistant.time.created, completed: Date.now() },
        })
        yield* goals.finished(child.session.id, child.assistant.id)
        const complete = yield* goals.get(child.session.id)
        if (!complete) throw new Error("Child Goal disappeared")
        const result = final(child.run, complete, yield* sessions.messages({ sessionID: child.session.id }))
        if (!result) throw new Error("Actual final reply was not bound")
        const childhistory = yield* storage.read<unknown>(["raya", "agent-runs", builder.id])
        const running = yield* database.db.select().from(Delegation).where(eq(Delegation.id, assigned.id)).get()
        if (!running) throw new Error("Original child delegation disappeared")
        const terminal = (yield* tasks.runsFor(builder.id)).find((run) => run.id === child.run.id)
        if (!terminal) throw new Error("Original child run disappeared")
        const failure = "The original Builder could not finish its accepted assignment."
        expect(
          yield* tasks.transition(terminal, {
            ...terminal,
            status: "error",
            blockedReason: failure,
            outcome: { kind: "code", summary: failure, cost: 0 },
          }),
        ).toBe(true)
        yield* errands.finish(assigned.id, "failed", builder, failure, 0, failure)
        const failed = yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))
        expect(failed.resumed).toBe(true)
        expect(failed.state.status).toBe("active")
        expect((yield* goals.evidence(root.session.id)).some((item) => item.callID === "builder-sales-handoff")).toBe(
          false,
        )
        yield* storage.replace(["raya", "goal", root.session.id], waiting)
        yield* storage.replace(["raya", "agent-runs", builder.id], childhistory)
        yield* database.db.update(Delegation).set(running).where(eq(Delegation.id, assigned.id)).run()
        yield* database.db
          .delete(Inbox)
          .where(eq(Inbox.source, `reply:${running.source}`))
          .run()
        yield* tasks.transition(
          child.run,
          { ...child.run, status: "complete", outcome: { kind: "code", summary, report: result.report, cost: 0 } },
          complete,
        )
        yield* errands.finish(assigned.id, "completed", builder, summary, 0)
        const parenthistory = yield* storage.read<unknown>(["raya", "agent-runs", researcher.id])
        yield* tasks.transition(root.run, {
          ...root.run,
          status: "stopped",
          stop: { version: 1, intent: crypto.randomUUID(), at: Date.now() },
        })
        expect(
          Exit.isFailure(
            yield* goals
              .delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* goals.get(root.session.id))?.status).toBe("paused")
        yield* storage.replace(["raya", "agent-runs", researcher.id], parenthistory)
        const retained = yield* goals.get(root.session.id)
        yield* storage.replace(["raya", "goal", root.session.id], { ...retained, dependencyWait: undefined })
        expect(
          (yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))).resumed,
        ).toBe(false)
        yield* storage.replace(["raya", "goal", root.session.id], retained)
        const awakened = yield* goals.delegated(root.session.id, root.run.id, (next) => Effect.succeed(next.revision!))
        expect(awakened.resumed).toBe(true)
        expect(awakened.state.status).toBe("active")
        const observed = yield* get.execute({}, root.ctx("observe-real-child"))
        expect(observed.output).toContain("builder-sales-handoff")
        const before = yield* goals.get(root.session.id)
        yield* goals.update(root.session.id, { status: "paused", reason: "Waiting for Builder" })
        yield* goals.update(root.session.id, { status: "active" })
        const resumed = yield* goals.get(root.session.id)
        expect(resumed?.intent).not.toBe(before?.intent)
        const evidence = yield* goals.evidence(root.session.id)
        const actual = evidence.find((item) => item.callID === "builder-sales-handoff")
        expect(evidence.some((item) => item.callID === "builder-private-input")).toBe(false)
        expect(JSON.stringify(evidence)).not.toContain("PRIVATE INPUT MUST NOT CROSS")
        expect(actual?.sessionID).toBe(child.session.id)
        expect(actual?.delegation?.artifacts).toHaveLength(2)
        expect(evidence.find((item) => item.callID === "research-handoff")?.delegation?.reply).toBe(summary)
        expect(evidence.find((item) => item.callID === "research-handoff")?.delegation?.workerAuthored).toBe(true)
        yield* database.db
          .update(SessionTable)
          .set({ agent: "foreign-mode" })
          .where(eq(SessionTable.id, child.session.id))
          .run()
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
        yield* database.db
          .update(SessionTable)
          .set({ agent: "generalist" })
          .where(eq(SessionTable.id, child.session.id))
          .run()
        const savedgoal = yield* storage.read<RayaGoal.State>(["raya", "goal", child.session.id])
        yield* storage.replace(["raya", "goal", child.session.id], { ...savedgoal, inputs: [root.user.id] })
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
        yield* storage.replace(["raya", "goal", child.session.id], savedgoal)
        for (const change of [
          { response: "A spliced worker report" },
          { session_id: root.session.id },
          { parent_run_id: "foreign-run" },
          { source: "delegate:foreign-invocation" },
        ]) {
          const saved = yield* database.db.select().from(Delegation).where(eq(Delegation.id, assigned.id)).get()
          if (!saved) throw new Error("Delegation fixture disappeared")
          yield* database.db.update(Delegation).set(change).where(eq(Delegation.id, assigned.id)).run()
          expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
          yield* database.db.update(Delegation).set(saved).where(eq(Delegation.id, assigned.id)).run()
        }
        const savedrow = yield* database.db.select().from(Delegation).where(eq(Delegation.id, assigned.id)).get()
        if (!savedrow) throw new Error("Actual delegation disappeared before overflow test")
        const overflow = Array.from({ length: 4 }, (_, index) => ({
          ...savedrow,
          id: `overflow-${index}`,
          source: `test:overflow-${index}`,
        }))
        yield* database.db.insert(Delegation).values(overflow).run()
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
        for (const row of overflow) yield* database.db.delete(Delegation).where(eq(Delegation.id, row.id)).run()
        yield* fs.writeFileString(files[1], "Changed after receipt capture\n")
        const stale = yield* goals
          .update(root.session.id, {
            status: "complete",
            summary: "Must refuse stale child bytes",
            requirements: [
              {
                criterionID: "handoff",
                requirement: criteria[0].description,
                passed: true,
                evidence: [
                  { callID: "builder-html", sessionID: child.session.id, summary: "Old child bytes" },
                  { callID: "builder-sales-handoff", sessionID: child.session.id, summary: "Actual handoff" },
                ],
              },
            ],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        expect((yield* goals.get(root.session.id))?.status).toBe("active")
        const downstream = yield* errands.take(sales.id)
        expect(downstream?.id).toBe(onward.id)
        expect(downstream?.state).toBe("accepted")
        const onwardproof = (yield* goals.evidence(root.session.id)).find(
          (item) => item.callID === "builder-sales-handoff",
        )
        expect(onwardproof?.delegation?.state).toBe("accepted")
        yield* goals.update(root.session.id, {
          status: "complete",
          summary: "Research and genuine onward handoff evidenced",
          requirements: [
            {
              criterionID: "handoff",
              requirement: criteria[0].description,
              passed: true,
              evidence: [
                {
                  callID: "builder-sales-handoff",
                  sessionID: child.session.id,
                  summary: "Actual accepted two-file handoff",
                },
              ],
            },
          ],
        })
        const done = yield* goals.get(root.session.id)
        expect(done?.status).toBe("complete")
        expect(done?.deliverables ?? []).toEqual([])
        expect(
          yield* tasks.transition(root.run, {
            ...root.run,
            status: "stopped",
            stop: { version: 1, intent: crypto.randomUUID(), at: Date.now() },
          }),
        ).toBe(true)
        expect(Exit.isFailure(yield* goals.evidence(root.session.id).pipe(Effect.exit))).toBe(true)
      }),
    ),
  60000,
)
