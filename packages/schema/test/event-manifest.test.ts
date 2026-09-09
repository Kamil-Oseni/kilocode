import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"
import surface from "./kilocode/fixtures/event-surface.json" // kilocode_change - reviewed event names/versions, independent of manifest order

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    // kilocode_change start - compare compact identities rather than stale counts or huge schema-object diffs
    expect(EventManifest.ServerDefinitions.map<string>((item) => item.type).sort()).toEqual(surface.server)
    expect(EventManifest.Definitions.map<string>((item) => item.type).sort()).toEqual(surface.all)
    // kilocode_change end
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    // kilocode_change start
    expect([...EventManifest.Latest.keys()].sort()).toEqual(surface.all)
    expect([...EventManifest.Durable.keys()].sort()).toEqual(surface.durable)
    // kilocode_change end
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    // kilocode_change start - these compatibility events retain identity without positional assumptions
    for (const item of [SessionV1.Event.PartDelta, SessionV1.Event.Diff, SessionV1.Event.Error]) {
      expect(EventManifest.Latest.get(item.type)).toBe(item)
      expect(EventManifest.ServerDefinitions.some((entry) => entry.type === item.type)).toBe(false)
    }
    for (const item of Object.values(SessionEvent.RevertEvent)) {
      expect(EventManifest.Latest.get(item.type)).toBe(item)
      expect(EventManifest.ServerDefinitions.some((entry) => entry === item)).toBe(true)
      expect(EventManifest.Durable.get(`${item.type}.1`)).toBe(item)
    }
    // kilocode_change end
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
