import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import * as TaskFiles from "./task-files"

/** Model declarations only attenuate the original parent authority. */
export const prepare = Effect.fn("TaskFilesProducer.prepare")(function* (input: {
  auto: boolean
  access?: "read" | "edit" | "computer"
  files?: TaskFiles.Declared
  branch?: { id: string; files?: TaskFiles.Declared }
  parent?: { id: string; parentID?: string; directory?: string; metadata?: Record<string, unknown> }
  resumed?: { id: string; metadata?: Record<string, unknown> }
  storage?: Storage.Interface
  fs?: FSUtil.Interface
}) {
  if (input.parent) {
    yield* TaskFiles.check(input.parent, [])
    if (!TaskFiles.permits(input.parent.metadata, "task"))
      return yield* Effect.fail(new Error("A file-scoped Task cannot delegate outside its assigned files."))
  }
  const marked = TaskFiles.read(input.resumed?.metadata)
  const saved = input.resumed && input.storage ? yield* TaskFiles.find(input.storage, input.resumed.id) : undefined
  if ((marked || saved) && !isDeepStrictEqual(marked, saved))
    return yield* Effect.fail(new Error("The resumed Task lost or changed its immutable file scope."))
  if (saved && input.files !== undefined && !isDeepStrictEqual(input.files, saved.declared))
    return yield* Effect.fail(new Error("A resumed Task's declared files cannot be changed."))
  const files = saved?.declared ?? (input.branch ? input.branch.files : input.files)
  if (input.access === "edit" && !input.branch && !input.resumed && files === undefined)
    return yield* Effect.fail(new Error("A new edit Task needs files: exact relative files in its child workspace."))
  if (files === undefined) return undefined
  if (input.access === "computer")
    return yield* Effect.fail(new Error("An exact file scope cannot authorize Computer Use effects."))
  if (!input.storage || !input.fs)
    return yield* Effect.fail(new Error("Task file-scope storage and filesystem validation are unavailable."))
  return { files, branch: saved?.branch ?? input.branch?.id, storage: input.storage, fs: input.fs }
})

export const bind = Effect.fn("TaskFilesProducer.bind")(function* (
  prepared: Effect.Success<ReturnType<typeof prepare>>,
  child: { id: string; directory: string },
  parent: string,
) {
  if (!prepared) return undefined
  return yield* TaskFiles.bind({
    session: child.id,
    parent,
    directory: child.directory,
    files: prepared.files,
    storage: prepared.storage,
    fs: prepared.fs,
    ...(prepared.branch === undefined ? {} : { branch: prepared.branch }),
  })
})

/** Bind before Session.create publishes the child to other request handlers. */
export const allocate = Effect.fn("TaskFilesProducer.allocate")(function* (
  prepared: Effect.Success<ReturnType<typeof prepare>>,
  directory: string,
  parent: string,
) {
  if (!prepared) return undefined
  const id = SessionID.descending()
  const files = yield* bind(prepared, { id, directory }, parent)
  if (!files) return yield* Effect.fail(new Error("The new Task has no bound file scope."))
  return { id, files }
})

export function guide(text: string, binding?: TaskFiles.Binding) {
  if (!binding) return text
  return `${text}\n\n<assigned_files>\nOnly these exact files may be mutated: ${JSON.stringify(binding.canonical)}. This declaration restricts existing permissions and is not proof of human review. Other files may be read when permitted. Shell, MCP, custom tools and further delegation are unavailable under this file scope. Do not use a formatter or language server to bypass it.\n</assigned_files>`
}
