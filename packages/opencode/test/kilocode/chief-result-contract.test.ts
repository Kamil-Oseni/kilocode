import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { BackgroundJob } from "@/background/job"
import { MessageID, PartID } from "@/session/schema"
import { RayaChief } from "@/kilocode/chief"
import { ChiefRefinement } from "@/kilocode/chief/refinement"
import { TaskName } from "@/kilocode/tool/task-name"
import { ResultContract } from "@/kilocode/chief/result-contract"
import { resumeHint } from "@/kilocode/task-resume"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"

afterEach(disposeAllInstances)
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Session.node,
        SessionProjector.node,
        Storage.node,
        Database.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
        BackgroundJob.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)
const model = { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") }

it.live("a result contract requires an actual saved Chief dispatch and refuses changed or copied proof", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Owned result contract" })
        for (let index = 0; index < 130; index++) {
          const id = MessageID.ascending()
          yield* sessions.updateMessage({
            id,
            sessionID: session.id,
            role: "user",
            agent: "auto",
            model,
            time: { created: 0 },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: id,
            type: "text",
            text: `Earlier request ${index}`,
          })
        }
        const user = MessageID.ascending()
        const message = MessageID.ascending()
        const request = "Inspect the owned directory and return its original entries"
        const decision: RayaChief.Decision = {
          request,
          access: "read",
          result: "directory_entries",
          userID: user,
          agent: "generalist",
          model: "fixture/fixture",
          needs_plan: false,
          confidence: 1,
          reason: "Owned fixture",
          latency: 0,
          chiefModel: "fixture/fixture",
          candidates: [],
          prompted: false,
        }
        const metadata = {
          [RayaChief.requestKey]: request,
          [RayaChief.phaseKey]: "task",
          [RayaChief.logKey]: [decision],
        }
        yield* sessions.updateMessage({
          id: user,
          sessionID: session.id,
          role: "user",
          agent: "auto",
          model,
          time: { created: 1 },
        })
        const text = {
          id: PartID.ascending(),
          messageID: user,
          sessionID: session.id,
          type: "text" as const,
          text: request,
        }
        yield* sessions.updatePart(text)
        yield* sessions.updateMessage({
          id: message,
          sessionID: session.id,
          role: "assistant",
          parentID: user,
          agent: "auto",
          mode: "auto",
          providerID: model.providerID,
          modelID: model.modelID,
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        })
        yield* sessions.setMetadata({ sessionID: session.id, metadata })
        const missing = yield* ResultContract.load(sessions, session.id).pipe(Effect.exit)
        expect(missing._tag).toBe("Failure")
        const part = {
          id: PartID.ascending(),
          messageID: message,
          sessionID: session.id,
          type: "tool" as const,
          tool: "chief_route",
          callID: "owned-route",
          state: {
            status: "completed" as const,
            input: { access: "read", result: "directory_entries", objective: request },
            title: "Owned route",
            output: JSON.stringify(decision),
            metadata: {},
            time: { start: 2, end: 3 },
          },
        }
        yield* sessions.updatePart(part)
        const dispatch = { sessionID: session.id, userID: user, messageID: message }
        const dispatched = yield* ResultContract.load(sessions, dispatch)
        if (!dispatched) throw new Error("Owned dispatch unavailable")
        dispatch.messageID = MessageID.ascending()
        yield* ResultContract.check(sessions, dispatched)
        const value = yield* ResultContract.load(sessions, session.id)
        if (!value) throw new Error("Owned contract unavailable")
        expect(value.kind).toBe("directory_entries")
        expect(ResultContract.context(value)).toEqual({
          selected: session.id,
          input: user,
          current: user,
          inputs: [user],
        })
        const child = yield* sessions.create({ parentID: session.id, title: "Owned child contract" })
        const first = MessageID.ascending()
        const call = "owned-task"
        const task = { sessionID: child.id, inputID: first, parentMessageID: message, callID: call }
        const owner: TaskName.Identity = {
          version: 1,
          displayName: "Owned child",
          baseName: "Owned child",
          ordinal: 1,
          specialist: "generalist",
          selection: "auto",
          provenance: { source: "objective", parentSessionID: session.id, parentMessageID: message, callID: call },
        }
        const input = {
          id: first,
          sessionID: child.id,
          role: "user" as const,
          agent: "generalist",
          model,
          time: { created: 3 },
        }
        const prompt = {
          id: PartID.ascending(),
          messageID: first,
          sessionID: child.id,
          type: "text" as const,
          text: request,
        }
        yield* sessions.updateMessage(input)
        yield* sessions.updatePart(prompt)
        yield* sessions.setMetadata({
          sessionID: child.id,
          metadata: { [TaskName.key]: owner, [ResultContract.key]: ResultContract.child(value, task) },
        })
        const original = {
          id: PartID.ascending(),
          messageID: message,
          sessionID: session.id,
          type: "tool" as const,
          tool: "task",
          callID: call,
          state: {
            status: "completed" as const,
            input: { access: "read", prompt: request },
            title: "Owned task",
            output: "Original completed child",
            metadata: { sessionId: child.id, childMessageID: first },
            time: { start: 3, end: 4 },
          },
        }
        yield* sessions.updatePart(original)
        const reviewed = yield* ResultContract.load(sessions, child.id)
        if (!reviewed) throw new Error("Owned child contract unavailable")
        yield* sessions.updatePart({ ...prompt, text: "same-ID child source changed" })
        expect((yield* ResultContract.check(sessions, reviewed).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.updatePart(prompt)
        expect(yield* ResultContract.recovery(sessions, session.id)).toBe(false)
        const records = yield* sessions.messages({ sessionID: session.id, limit: 129 })
        const author = records.find((row) => row.info.id === message)
        if (author?.info.role !== "assistant") throw new Error("Owned root assistant unavailable")
        const terminal = yield* sessions.updateMessage({
          ...author.info,
          id: MessageID.ascending(),
          sessionID: child.id,
          parentID: first,
          agent: "generalist",
          mode: "generalist",
          time: { created: 4, completed: 5 },
          error: { name: "UnknownError", data: { message: ResultContract.unavailable } },
        })
        const failure = {
          ...original,
          state: {
            status: "error" as const,
            input: original.state.input,
            error: `${ResultContract.unavailable}\n${resumeHint(child.id)}`,
            metadata: original.state.metadata,
            time: original.state.time,
          },
        }
        yield* sessions.updatePart(failure)
        expect(yield* ResultContract.recovery(sessions, session.id)).toBe(true)
        expect(yield* ResultContract.recovery(sessions, session.id, child.id)).toBe(true)
        expect(yield* ResultContract.recovery(sessions, session.id, session.id)).toBe(false)
        expect(yield* ResultContract.recovery(sessions, child.id)).toBe(false)
        yield* sessions.updatePart({ ...failure, state: { ...failure.state, error: ResultContract.unavailable } })
        expect(yield* ResultContract.recovery(sessions, session.id)).toBe(false)
        yield* sessions.updatePart({
          ...failure,
          state: { ...failure.state, error: `${ResultContract.unavailable}\n${resumeHint(session.id)}` },
        })
        expect(yield* ResultContract.recovery(sessions, session.id)).toBe(false)
        yield* sessions.updatePart(failure)
        yield* sessions.updateMessage({
          ...terminal,
          error: { name: "UnknownError", data: { message: "Interrupted" } },
        })
        expect((yield* ResultContract.recovery(sessions, session.id).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.updateMessage(terminal)
        yield* sessions.updatePart({ ...failure, state: { ...failure.state, error: "Unknown failure" } })
        expect(yield* ResultContract.recovery(sessions, session.id)).toBe(false)
        yield* sessions.updatePart(original)
        expect(yield* ResultContract.recovery(sessions, session.id)).toBe(false)
        const resumed = yield* ResultContract.resume(sessions, value, child.id)
        const next = MessageID.ascending()
        const second = MessageID.ascending()
        const info = {
          id: next,
          sessionID: session.id,
          role: "assistant" as const,
          parentID: user,
          agent: "auto",
          mode: "auto",
          providerID: model.providerID,
          modelID: model.modelID,
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 5 },
        }
        yield* sessions.updateMessage(info)
        yield* sessions.updateMessage({ ...input, id: second, time: { created: 6 } })
        yield* sessions.updatePart({ ...prompt, id: PartID.ascending(), messageID: second })
        const continuation = ResultContract.child(resumed, {
          sessionID: child.id,
          inputID: second,
          parentMessageID: next,
          callID: "resumed-task",
        })
        yield* sessions.setMetadata({
          sessionID: child.id,
          metadata: { [TaskName.key]: owner, [ResultContract.key]: continuation },
        })
        yield* sessions.updatePart({
          ...original,
          id: PartID.ascending(),
          messageID: next,
          callID: "resumed-task",
          state: {
            ...original.state,
            input: { access: "read", task_id: child.id, prompt: request },
            metadata: { sessionId: child.id, childMessageID: second },
            time: { start: 5, end: 7 },
          },
        })
        const current = yield* ResultContract.load(sessions, child.id)
        if (!current) throw new Error("Owned resumed contract unavailable")
        expect(ResultContract.context(current).input).toBe(second)
        expect(continuation.origin).toEqual(task)
        expect(continuation.continuations).toEqual([task])
        yield* sessions.setMetadata({
          sessionID: child.id,
          metadata: {
            [TaskName.key]: owner,
            [ResultContract.key]: { ...continuation, origin: { ...task, callID: "substituted" } },
          },
        })
        expect((yield* ResultContract.check(sessions, current).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.setMetadata({
          sessionID: child.id,
          metadata: { [TaskName.key]: owner, [ResultContract.key]: continuation },
        })
        const prior = ChiefRefinement.fingerprint(metadata)
        expect(
          ChiefRefinement.fingerprint({ ...metadata, [RayaChief.logKey]: [{ ...decision, result: "narrative" }] }),
        ).not.toBe(prior)
        const copied = yield* ResultContract.check(sessions, structuredClone(value)).pipe(Effect.exit)
        expect(copied._tag).toBe("Failure")
        dispatch.messageID = MessageID.ascending()
        yield* ResultContract.check(sessions, value)
        yield* sessions.updatePart({ ...text, synthetic: false })
        // The authored words still match; changing the same retained part must invalidate its private snapshot.
        expect((yield* ResultContract.check(sessions, value).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.updatePart(text)
        yield* ResultContract.check(sessions, value)
        yield* sessions.updatePart({
          ...part,
          state: { ...part.state, input: { ...part.state.input, objective: "changed" } },
        })
        expect((yield* ResultContract.check(sessions, value).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.updatePart(part)
        const background = yield* BackgroundJob.Service
        const parents = yield* sessions.messages({ sessionID: session.id, limit: 129 })
        const parent = parents.find((row) => row.info.id === next)
        if (parent?.info.role !== "assistant") throw new Error("Actual background parent unavailable")
        yield* sessions.updateMessage({
          ...parent.info,
          finish: "tool-calls",
          time: { ...parent.info.time, completed: Date.now() },
        })
        const completions = []
        for (let index = 0; index < 2; index++) {
          const worker = yield* sessions.create({ parentID: session.id, title: `Actual background ${index}` })
          const input = MessageID.ascending()
          const call = `actual-background-${index}`
          yield* sessions.setMetadata({
            sessionID: worker.id,
            metadata: {
              [ResultContract.key]: ResultContract.child(value, {
                sessionID: worker.id,
                inputID: input,
                parentMessageID: next,
                callID: call,
              }),
            },
          })
          const receipt = {
            ...original,
            id: PartID.ascending(),
            messageID: next,
            callID: call,
            state: {
              ...original.state,
              input: { ...original.state.input, background: true },
              metadata: { sessionId: worker.id, childMessageID: input, jobId: worker.id, background: true },
            },
          }
          yield* sessions.updatePart(receipt)
          const finish = yield* Deferred.make<string>()
          const job = yield* background.start({
            id: worker.id,
            type: "task",
            origin: {
              sessionID: session.id,
              messageID: next,
              callID: call,
              childSessionID: worker.id,
              childMessageID: input,
            },
            run: Deferred.await(finish),
          })
          expect(yield* ResultContract.park(sessions, background, session.id, next)).toBe(true)
          expect(yield* ResultContract.park(sessions, background, worker.id, next)).toBe(false)
          yield* sessions.updatePart({
            ...receipt,
            state: { ...receipt.state, metadata: { ...receipt.state.metadata, jobId: "foreign-job" } },
          })
          expect((yield* ResultContract.park(sessions, background, session.id, next).pipe(Effect.exit))._tag).toBe(
            "Failure",
          )
          yield* sessions.updatePart({
            ...receipt,
            state: { ...receipt.state, input: { ...receipt.state.input, branch_id: "planned-branch" } },
          })
          expect(yield* ResultContract.park(sessions, background, session.id, next)).toBe(false)
          yield* sessions.updatePart(receipt)
          const planned = { ...decision, needs_plan: true }
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: { ...metadata, [RayaChief.logKey]: [planned] },
          })
          yield* sessions.updatePart({ ...part, state: { ...part.state, output: JSON.stringify(planned) } })
          expect(yield* ResultContract.park(sessions, background, session.id, next)).toBe(false)
          yield* sessions.setMetadata({ sessionID: session.id, metadata })
          yield* sessions.updatePart(part)
          yield* Deferred.succeed(finish, `Actual completion ${index}`)
          const completed = yield* background.wait({ id: job.id })
          expect(completed.info?.status).toBe("completed")
          expect(yield* ResultContract.park(sessions, background, session.id, next)).toBe(true)
          const text = completed.info?.output
          if (!text) throw new Error("Actual background completion absent")
          const token = yield* ResultContract.notice(sessions, background, value, job.id, text)
          completions.push({ token, text })
        }
        const published = []
        for (const completion of completions) {
          const info = {
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user" as const,
            agent: "auto",
            model,
            time: { created: 4 },
          }
          const part = {
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: info.id,
            type: "text" as const,
            synthetic: true,
            text: completion.text,
          }
          const row = { info, parts: [part] }
          expect((yield* ResultContract.validateNotice(sessions, {}, row).pipe(Effect.exit))._tag).toBe("Failure")
          yield* ResultContract.validateNotice(sessions, completion.token, row)
          yield* sessions.updateMessage(info)
          yield* sessions.updatePart(part)
          yield* ResultContract.publishNotice(sessions, completion.token, row)
          published.push(row)
        }
        const continued = yield* ResultContract.load(sessions, session.id)
        if (!continued) throw new Error("Actual two-completion continuation absent")
        expect(ResultContract.context(continued).inputs).toEqual([user, ...published.map((row) => row.info.id)])
        expect(ResultContract.context(continued).current).toBe(published[1]!.info.id)
        const foreign = MessageID.ascending()
        const reply = MessageID.ascending()
        yield* sessions.updateMessage({
          id: foreign,
          sessionID: session.id,
          role: "user",
          agent: "auto",
          model,
          time: { created: 5 },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: foreign,
          type: "text",
          synthetic: true,
          text: "Unregistered completion notice",
        })
        const collection = yield* sessions.messages({ sessionID: session.id, limit: 129 })
        const source = collection.find((row) => row.info.role === "assistant")
        if (source?.info.role !== "assistant") throw new Error("Original contract assistant unavailable")
        yield* sessions.updateMessage({ ...source.info, id: reply, parentID: foreign, time: { created: 5 } })
        expect(
          (yield* ResultContract.load(sessions, { sessionID: session.id, userID: foreign, messageID: reply }).pipe(
            Effect.exit,
          ))._tag,
        ).toBe("Failure")
        yield* sessions.removeMessage({ sessionID: session.id, messageID: reply })
        yield* sessions.removeMessage({ sessionID: session.id, messageID: foreign })
        yield* ResultContract.check(sessions, continued)
        const notice = published[0]!.parts[0]!
        yield* sessions.updatePart({ ...notice, text: "Substituted same-ID notice" })
        expect((yield* ResultContract.check(sessions, continued).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.updatePart(notice)
        yield* ResultContract.check(sessions, continued)
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: { ...metadata, [RayaChief.logKey]: [{ ...decision, result: "narrative" }] },
        })
        expect((yield* ResultContract.check(sessions, value).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.setMetadata({ sessionID: session.id, metadata })
        const newest = MessageID.ascending()
        yield* sessions.updateMessage({
          id: newest,
          sessionID: session.id,
          role: "user",
          agent: "auto",
          model,
          time: { created: 4 },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: newest,
          type: "text",
          text: "A genuinely new request",
        })
        expect((yield* ResultContract.check(sessions, value).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* ResultContract.load(sessions, session.id).pipe(Effect.exit))._tag).toBe("Failure")
        const authored = {
          id: newest,
          sessionID: session.id,
          role: "user" as const,
          agent: "generalist",
          model,
          time: { created: 4 },
        }
        yield* sessions.updateMessage(authored)
        expect(yield* ResultContract.load(sessions, session.id)).toBeUndefined()
        // The historical private review still cannot authorize this new authored request.
        expect((yield* ResultContract.check(sessions, value).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.updateMessage({ ...authored, agent: "auto" })
        expect((yield* ResultContract.load(sessions, session.id).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.setMetadata({ sessionID: session.id, metadata: { ...metadata, [RayaChief.phaseKey]: "route" } })
        expect(yield* ResultContract.load(sessions, session.id)).toBeUndefined()
        yield* sessions.setMetadata({ sessionID: session.id, metadata })
        const rows = yield* sessions.messages({ sessionID: session.id, limit: 129 })
        const assistant = rows.find((row) => row.info.role === "assistant")
        if (assistant?.info.role !== "assistant") throw new Error("Owned assistant unavailable")
        for (let index = 0; index < 129; index++)
          yield* sessions.updateMessage({ ...assistant.info, id: MessageID.ascending(), time: { created: 5 + index } })
        expect((yield* ResultContract.load(sessions, session.id).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    )
  }),
)

it.live("an uncontracted synthetic Routine dispatch does not require a background result notice", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Original uncontracted continuation" })
        const user = MessageID.ascending()
        const message = MessageID.ascending()
        yield* sessions.updateMessage({
          id: user,
          sessionID: session.id,
          role: "user",
          agent: "generalist",
          model,
          time: { created: 1 },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: user,
          type: "text",
          synthetic: true,
          text: "An active persistent goal must continue. Call get_goal before performing work.",
        })
        const assistant = {
          id: message,
          sessionID: session.id,
          role: "assistant" as const,
          parentID: user,
          agent: "generalist",
          mode: "generalist",
          providerID: model.providerID,
          modelID: model.modelID,
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        }
        yield* sessions.updateMessage(assistant)
        const dispatch = { sessionID: session.id, userID: user, messageID: message }
        expect(yield* ResultContract.load(sessions, dispatch)).toBeUndefined()
        expect(yield* ResultContract.load(sessions, session.id)).toBeUndefined()
        yield* sessions.updateMessage({ ...assistant, parentID: MessageID.ascending() })
        expect((yield* ResultContract.load(sessions, dispatch).pipe(Effect.exit))._tag).toBe("Failure")
        yield* sessions.updateMessage(assistant)
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: { [RayaChief.logKey]: [{ result: "directory_entries" }] },
        })
        expect((yield* ResultContract.load(sessions, dispatch).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    )
  }),
)
