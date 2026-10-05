import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { schema } from "../../src/kilocode/migration/profile-store-schema"
import { DraftLegacy } from "../../src/kilocode/session/composer-codec"

test("independent content rejects cross-store roots, sessions, output calls and undeclared drafts", () => {
  const data = path.join(os.tmpdir(), "store-content-codec")
  const workspace = path.join(data, "workspace")
  const file = path.join(data, "tool-output", "tool_shared")
  const part = {
    type: "tool",
    callID: "call_shared",
    tool: "read",
    state: {
      status: "completed",
      input: {},
      output: "kept",
      title: "Read",
      metadata: { truncated: true, outputPath: file },
      time: { start: 1, end: 2 },
    },
  }
  const parser = schema(["session", "part"]).stores
  const content = { text: "draft café 日本語 😀", comments: [], images: [], scroll: 0 }
  const draft = {
    identity: { key: "session:ses_shared", box: "main", workspace, sessionID: "ses_shared" },
    token: { generation: crypto.randomUUID(), revision: 1 },
    content,
    mutation: "test",
    digest: DraftLegacy.hash(content),
  }
  const value = {
    kind: "raya",
    id: "a".repeat(64),
    source: path.join(data, "raya.db"),
    schema: "b".repeat(64),
    workspaces: [workspace],
    sql: [
      { table: "session", columns: ["id", "directory"], rows: [["ses_shared", workspace]] },
      {
        table: "part",
        columns: ["id", "session_id", "message_id", "data"],
        rows: [["prt_shared", "ses_shared", "msg_shared", JSON.stringify(part)]],
      },
    ],
    content: {
      version: 1,
      source: { data, storage: path.join(data, "storage") },
      composers: { version: 1, entries: [draft] },
      notes: {
        version: 1,
        plans: [],
        reverts: [{ root: data, session: "ses_shared", files: ["file.txt"] }],
        history: [],
      },
      outputs: {
        version: 1,
        files: [],
        bindings: [
          {
            table: "part",
            row: "prt_shared",
            session: "ses_shared",
            message: "msg_shared",
            call: "call_shared",
            slot: 0,
            index: 0,
            path: file,
            root: data,
            name: "tool_shared",
            state: "missing",
          },
        ],
        history: [],
      },
      reviewOnly: true,
      activation: "held",
    },
  }
  expect(parser.safeParse([value]).success).toBe(true)
  expect(parser.safeParse([{ ...value, source: path.join(data, "other", "raya.db") }]).success).toBe(false)
  expect(
    parser.safeParse([
      {
        ...value,
        content: {
          ...value.content,
          notes: { ...value.content.notes, reverts: [{ root: data, session: "ses_foreign", files: ["file.txt"] }] },
        },
      },
    ]).success,
  ).toBe(false)
  expect(
    parser.safeParse([
      {
        ...value,
        content: {
          ...value.content,
          outputs: {
            ...value.content.outputs,
            bindings: value.content.outputs.bindings.map((item) => ({ ...item, call: "call_foreign" })),
          },
        },
      },
    ]).success,
  ).toBe(false)
  expect(
    parser.safeParse([
      {
        ...value,
        content: {
          ...value.content,
          composers: {
            version: 1,
            entries: [{ ...draft, identity: { ...draft.identity, workspace: path.join(data, "foreign") } }],
          },
        },
      },
    ]).success,
  ).toBe(false)
  // Equal logical IDs stay independent when their physical store/data roots differ.
  const other = path.join(os.tmpdir(), "store-content-codec-other")
  const second = {
    ...value,
    id: "c".repeat(64),
    source: path.join(other, "raya.db"),
    content: {
      ...value.content,
      source: { data: other, storage: path.join(other, "storage") },
      notes: { ...value.content.notes, reverts: [{ root: other, session: "ses_shared", files: ["file.txt"] }] },
      outputs: { ...value.content.outputs, bindings: [] },
    },
    sql: [{ ...value.sql[0] }, { ...value.sql[1], rows: [] }],
  }
  expect(parser.safeParse([value, second]).success).toBe(true)
})
