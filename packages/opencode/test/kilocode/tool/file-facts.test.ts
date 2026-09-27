import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import * as Truncate from "@/tool/truncate"
import { FileFactsTool } from "@/kilocode/tool/file-facts"
import { InstanceRef } from "@/effect/instance-ref"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "file-facts-")))
  dirs.push(dir)
  return dir
}

const files = FSUtil.Service.of({
  stat: (file: string) =>
    Effect.tryPromise({
      try: async () => {
        const stat = await fs.stat(file)
        return { type: stat.isDirectory() ? "Directory" : "File" }
      },
      catch: (err) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          return Object.assign(new Error("missing"), { reason: { _tag: "NotFound" } })
        }
        return err
      },
    }),
  realPath: (file: string) => Effect.tryPromise(() => fs.realpath(file)),
} as unknown as FSUtil.Interface)

const info = { name: "code", mode: "primary", options: {}, permission: {} } as Agent.Info
const agent = Agent.Service.of({
  get: () => Effect.succeed(info),
  list: () => Effect.succeed([info]),
  defaultInfo: () => Effect.succeed(info),
  defaultAgent: () => Effect.succeed("code"),
  generate: () => Effect.succeed({ identifier: "code", whenToUse: "", systemPrompt: "" }),
})

const truncate = Truncate.Service.of({
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
} as Truncate.Interface)

function run(dir: string, name: string, ask: Tool.Context["ask"] = () => Effect.void) {
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "call_test",
    agent: "code",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask,
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const info = yield* FileFactsTool
      const tool = yield* info.init()
      return yield* tool.execute({ path: name }, ctx)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(FSUtil.Service, files),
          Layer.succeed(Agent.Service, agent),
          Layer.succeed(Truncate.Service, truncate),
          Layer.succeed(InstanceRef, { directory: dir, worktree: dir, project: {} as never }),
        ),
      ),
    ),
  )
}

test("reports physical byte length and final newline without file contents", async () => {
  const dir = await setup()
  const file = path.join(dir, "answer.txt")
  await fs.writeFile(file, "12345678901234")
  const plain = await run(dir, file, () => Effect.void)
  expect(JSON.parse(plain.output)).toEqual({ bytes: "14", newline: "none" })
  expect(plain.output).not.toContain("12345678901234")

  await fs.writeFile(file, "12345678901234\n")
  const lf = await run(dir, file)
  expect(JSON.parse(lf.output)).toEqual({ bytes: "15", newline: "LF" })

  await fs.writeFile(file, "12345678901234\r\n")
  const crlf = await run(dir, file)
  expect(JSON.parse(crlf.output)).toEqual({ bytes: "16", newline: "CRLF" })
})

test("asks for read permission before returning metadata", async () => {
  const dir = await setup()
  const file = path.join(dir, "private.txt")
  await fs.writeFile(file, "private")
  const asks: string[] = []
  const result = await run(dir, file, (req) =>
    Effect.sync(() => {
      asks.push(req.permission)
    }),
  )
  expect(asks).toEqual(["read"])
  expect(result.output).not.toContain("private")
  await expect(run(dir, file, () => Effect.die(new Error("denied")))).rejects.toThrow("denied")
})

test("missing files fail after the read permission check", async () => {
  const dir = await setup()
  const asks: string[] = []
  await expect(
    run(dir, "missing.txt", (req) =>
      Effect.sync(() => {
        asks.push(req.permission)
      }),
    ),
  ).rejects.toThrow("File not found")
  expect(asks).toEqual(["read"])
})

test("rejects same-inode changes after permission approval", async () => {
  const dir = await setup()
  const file = path.join(dir, "changing.txt")
  await fs.writeFile(file, "old contents")
  await expect(
    run(dir, file, () => Effect.promise(() => fs.writeFile(file, "new contents and more"))),
  ).rejects.toThrow("File changed while inspecting")
})
