import { expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Layer, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Bus } from "@/bus"
import { Git } from "@/git"
import { Browser } from "@/kilocode/browser/service"
import { Event, type Request } from "@/kilocode/browser/protocol"
import { RayaContactOutbox } from "@/kilocode/contact/outbox"
import * as Artifact from "@/kilocode/goal/artifact"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskDelegation, type Artifact as Handoff } from "@/kilocode/task/delegation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Browser.layer("2 seconds").pipe(Layer.provideMerge(Bus.layer)),
    AppNodeBuilder.build(FSUtil.node),
    AppNodeBuilder.build(Git.node),
  ),
)

it.instance(
  "runs a local website company journey and reconstructs its exact work after restart",
  () =>
    Effect.gen(function* () {
      const root = (yield* TestInstance).directory
      const workspace = path.join(root, "company")
      const storage = path.join(root, "storage")
      const database = path.join(root, "raya.db")
      const fs = yield* FSUtil.Service
      yield* Effect.promise(() => mkdir(path.join(workspace, "site"), { recursive: true }))

      const source = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(
            "<!doctype html><title>Northstar Bakery</title><h1>Northstar Bakery</h1><p>Family bakery. Online ordering is unavailable.</p>",
            { headers: { "content-type": "text/html" } },
          )
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => source.stop(true)))
      const prospect = source.url.toString()
      const browser = yield* Browser.Service
      const bus = yield* Bus.Service
      const requests = yield* Queue.unbounded<Request>()
      const off = yield* bus.subscribeCallback(Event.Requested, (event) =>
        Queue.offerUnsafe(requests, event.properties),
      )
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const navigate = yield* browser
        .request({
          operation: "navigate",
          sessionID: SessionID.make("ses_company_browser_source"),
          url: prospect,
          authorization: {
            version: 1,
            sessionID: SessionID.make("ses_company_browser_source"),
            action: "browser",
            sensitive: false,
            source: "legacy_prompt",
          },
        })
        .pipe(Effect.forkChild)
      const opening = yield* Queue.take(requests)
      const page = yield* Effect.promise(() => fetch(opening.operation === "navigate" ? opening.url : prospect))
      const observed = yield* Effect.promise(() => page.text())
      yield* browser.reply({
        requestID: opening.id,
        result: { operation: "navigate", tabID: "tab_company_source", url: prospect, title: "Northstar Bakery" },
      })
      const opened = yield* Fiber.join(navigate)
      if (opened.operation !== "navigate") throw new Error("Browser returned the wrong result.")
      expect(opened.title).toBe("Northstar Bakery")

      const snapshot = yield* browser
        .request({
          operation: "snapshot",
          sessionID: SessionID.make("ses_company_browser_source"),
          tabID: "tab_company_source",
          authorization: {
            version: 1,
            sessionID: SessionID.make("ses_company_browser_source"),
            action: "observe",
            windowID: "tab_company_source",
            sensitive: false,
            source: "legacy_prompt",
          },
        })
        .pipe(Effect.forkChild)
      const capture = yield* Queue.take(requests)
      yield* browser.reply({
        requestID: capture.id,
        result: {
          operation: "snapshot",
          tabID: "tab_company_source",
          url: prospect,
          title: "Northstar Bakery",
          snapshot: observed,
        },
      })
      const seen = yield* Fiber.join(snapshot)
      if (seen.operation !== "snapshot") throw new Error("Browser returned the wrong snapshot.")
      expect(seen.snapshot).toContain("Online ordering is unavailable")

      const retained = yield* Effect.gen(function* () {
        const db = yield* Database.Service
        const store = yield* Storage.Service
        const tasks = RayaTask.make({ storage: store, database: db })
        const orgs = RayaTaskOrganization.make(db, tasks, store)
        const names = ["Chief", "Research", "Brief", "Design", "Frontend", "Sales", "Success", "Finance"]
        const roles = [
          "generalist",
          "generalist",
          "briefer",
          "designer",
          "coder",
          "generalist",
          "generalist",
          "accountant",
        ]
        const agents: RayaTask.Agent[] = []
        for (let index = 0; index < names.length; index++) {
          agents.push(
            yield* tasks.create({
              name: names[index],
              role: roles[index],
              objective: `${names[index]} owns its stage of the website company workflow.`,
              schedule: { kind: "manual" },
              capabilities: index === names.length - 1 ? ["accounting"] : [],
              dir: workspace,
              access: "full",
              tools: ["read", "write", "browser_*"],
            }),
          )
        }
        const organization = yield* orgs.create({
          name: "Website Builders",
          purpose: "Find, design and prepare websites for local businesses.",
          policy: "Retain source evidence, pass verified files and never send outreach without owner authorization.",
          budget: 500,
          members: agents.map((agent, index) => ({
            agentID: agent.id,
            role: names[index],
            ...(index ? { supervisorID: agents[index - 1].id } : {}),
          })),
          delegations: agents.slice(0, -1).map((agent, index) => ({
            senderID: agent.id,
            recipientID: agents[index + 1].id,
          })),
        })
        const delegations = RayaTaskDelegation.make(db, orgs.authorize, orgs.shares)
        const files = [
          path.join(workspace, "prospect.md"),
          path.join(workspace, "brief.md"),
          path.join(workspace, "design.md"),
          path.join(workspace, "site", "index.html"),
          path.join(workspace, "sales.md"),
          path.join(workspace, "outreach-draft.md"),
          path.join(workspace, "finance.md"),
        ]
        const contents = [
          `# Northstar Bakery\n\nObserved source: ${prospect}\n\nOnline ordering is unavailable.`,
          "# Website brief\n\nAdd accessible online ordering, opening hours and a clear local pickup path.",
          "# Design direction\n\nWarm editorial bakery layout with a prominent Order for pickup action.",
          '<!doctype html><title>Northstar Bakery — Order online</title><main><h1>Fresh bread, ready for pickup</h1><a href="#order">Order for pickup</a></main>',
          "# Sales review\n\nLead with the observed ordering gap and the prepared local preview.",
          "# Outreach draft — unsent\n\nWe noticed customers cannot order online. We prepared a private local preview for your review. This draft has not been sent.",
          "# Finance review\n\nDraft only. No contract, invoice, payment or external commitment exists.",
        ]
        const handoffs: Handoff[] = []
        const records: string[] = []
        let parent: string | undefined
        for (let index = 0; index < agents.length - 1; index++) {
          yield* Effect.promise(() => Bun.write(files[index], contents[index]))
          const revision = yield* Artifact.capture(fs, files[index])
          if (revision.status !== "captured") throw new Error(`Could not capture ${files[index]}`)
          const handoff = {
            path: revision.path,
            sha256: revision.sha256,
            tool: "write",
            callID: `call_company_write_${index}`,
          }
          handoffs.push(handoff)
          const admitted = yield* delegations.admit(
            {
              source: `company_stage_${index}`,
              senderID: agents[index].id,
              recipientID: agents[index + 1].id,
              ...(parent ? { parentID: parent } : {}),
              organizationID: organization.id,
              organizationRevision: organization.revision,
              objective: `Complete the ${names[index + 1]} stage using the verified handoff.`,
              expected: `Return the ${names[index + 1]} stage artifact and a factual status report.`,
              budget: 50 - index,
              artifacts: [handoff],
            },
            agents[index],
            agents[index + 1],
          )
          records.push(admitted.record.id)
          const accepted = (yield* delegations.take(agents[index + 1].id))!
          yield* delegations.attach(
            accepted.id,
            accepted.childRunID!,
            SessionID.make(`ses_company_stage_${index}_00000000000000000000`),
          )
          if (parent) {
            yield* delegations.finish(
              parent,
              "completed",
              agents[index],
              `${names[index]} handed off verified work.`,
              1,
            )
          }
          parent = admitted.record.id
        }
        yield* delegations.finish(parent!, "completed", agents.at(-1)!, "Finance retained the unsent draft.", 1)

        const preview = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(Bun.file(files[3]), { headers: { "content-type": "text/html" } }),
        })
        const html = yield* Effect.promise(() => fetch(preview.url).then((response) => response.text()))
        yield* Effect.promise(() => preview.stop(true))
        expect(html).toContain("Order for pickup")
        expect(yield* RayaContactOutbox.make(db).listMessages(100)).toEqual([])
        return { organization, agents, records, files, handoffs }
      }).pipe(
        Effect.provide(Database.layerFromPath(database)),
        Effect.provide(Storage.layerFromDir(storage)),
        Effect.scoped,
      )

      yield* Effect.gen(function* () {
        const db = yield* Database.Service
        const store = yield* Storage.Service
        const tasks = RayaTask.make({ storage: store, database: db })
        const orgs = RayaTaskOrganization.make(db, tasks, store)
        const delegations = RayaTaskDelegation.make(db, orgs.authorize, orgs.shares)
        const restored = yield* orgs.get(retained.organization.id)
        expect(restored.members.map((member) => member.agentID)).toEqual(retained.agents.map((agent) => agent.id))
        expect(restored.delegations).toHaveLength(7)
        const tree = yield* delegations.tree(retained.records[0])
        expect([tree.record, ...tree.below].map((record) => record.id)).toEqual(retained.records)
        expect([tree.record, ...tree.below].every((record) => record.state === "completed")).toBe(true)
        expect([tree.record, ...tree.below].map((record) => record.artifacts?.[0])).toEqual(retained.handoffs)
        for (let index = 0; index < retained.files.length; index++) {
          expect(
            yield* Artifact.current({
              version: 1,
              status: "captured",
              path: retained.files[index],
              canonical: retained.files[index],
              sha256: retained.handoffs[index].sha256,
              mode: (yield* fs.stat(retained.files[index])).mode,
            }),
          ).toBe(true)
        }
        expect((yield* RayaTaskInbox.make(db).page(retained.agents[0].id)).messages.length).toBeGreaterThan(0)
        expect(yield* RayaContactOutbox.make(db).listMessages(100)).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(retained.files[5]).text())).toContain(
          "This draft has not been sent",
        )
      }).pipe(
        Effect.provide(Database.layerFromPath(database)),
        Effect.provide(Storage.layerFromDir(storage)),
        Effect.scoped,
      )
    }),
  { git: true },
  30_000,
)
