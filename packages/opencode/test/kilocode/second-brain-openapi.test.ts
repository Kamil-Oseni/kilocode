import type { JSONSchema7Definition } from "@ai-sdk/provider"
import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Schema as EffectSchema } from "effect"
import { PublicApi } from "@/server/routes/instance/httpapi/public"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Command, Result } from "@/kilocode/second-brain/protocol"

type Node = { type?: string; anyOf?: Node[]; properties?: Record<string, Node>; items?: Node }

test("actual public OpenAPI preserves proposal nulls and closed read statuses", () => {
  const spec = OpenApi.fromApi(PublicApi)
  const schemas = spec.components.schemas as Record<string, Node>
  const draft = schemas.SecondBrainCommand.anyOf?.find((row) => row.properties?.request)?.properties?.request
  const proposal = schemas.SecondBrainResult.properties?.proposals?.items
  for (const row of [draft, proposal]) {
    expect(row).toBeDefined()
    for (const field of ["expected", "content"]) {
      expect(row?.properties?.changes?.items?.properties?.[field]?.anyOf).toContainEqual({ type: "null" })
    }
    expect(row?.properties?.sources?.items?.properties?.event_time?.anyOf).toContainEqual({ type: "null" })
  }
  expect(proposal?.properties?.changes?.items?.properties?.before?.anyOf).toContainEqual({ type: "null" })
  const id = "14cf4181-5ae8-42ae-8f09-7f02ca07f1c8"
  const source = { path: "source.txt", sha256: "a".repeat(64), kind: "document", event_time: null }
  expect(
    EffectSchema.decodeUnknownExit(Command)({
      action: "propose",
      id,
      request: { sources: [source], changes: [{ path: "Projects/note.md", expected: null, content: null }] },
    })._tag,
  ).toBe("Success")
  for (const status of ["pending", "cancelled", "applying", "applied"]) {
    expect(
      EffectSchema.decodeUnknownExit(Result)({
        action: "read",
        project: "project",
        proposals: [
          {
            format: "raya.memory.proposal.v1",
            id,
            project: "project",
            digest: "b".repeat(64),
            status,
            capture_enabled: false,
            sources: [source],
            changes: [{ path: "Projects/note.md", expected: null, content: null, before: null }],
            provenance: "Review required",
          },
        ],
      })._tag,
    ).toBe("Success")
  }
})

test("actual model tool schema preserves null creation and source timestamps", () => {
  const node = (value: JSONSchema7Definition | JSONSchema7Definition[] | undefined) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  const wire = ToolJsonSchema.fromSchema(Command)
  const branch = wire.anyOf?.map(node).find((row) => row?.properties?.request)
  const draft = node(branch?.properties?.request)
  const changes = node(node(draft?.properties?.changes)?.items)
  const sources = node(node(draft?.properties?.sources)?.items)
  expect(draft).toBeDefined()
  for (const field of ["expected", "content"]) {
    expect(node(changes?.properties?.[field])?.anyOf).toContainEqual({ type: "null" })
  }
  expect(node(sources?.properties?.event_time)?.anyOf).toContainEqual({ type: "null" })
})
