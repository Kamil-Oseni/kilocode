import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import * as Project from "@/project/project"
import type { InstanceContext } from "@/project/instance-context"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { Snapshot } from "@/snapshot"
import { canonical } from "./review-boundaries"
import { project } from "./review-patches"
import { ReviewConflict } from "./review-revision"

type Node = { path: string; real: string; dev: string; ino: string }
export type Identity = {
  sessionID: SessionID
  directory: string
  root: string
  projectID: string
  real: string
  dev: string
  ino: string
  cwdReal: string
  cwdDev: string
  cwdIno: string
}
export type Owner = Identity & {
  ctx: InstanceContext
  nodes: Node[]
}

export const root = (directory: string, worktree: string) =>
  path.resolve(worktree === "/" || worktree === "global" || !path.isAbsolute(worktree) ? directory : worktree)

const inspect = (directory: string) =>
  Effect.tryPromise(async () => {
    const real = await fs.realpath(directory)
    const stat = await fs.stat(directory, { bigint: true })
    if (!stat.isDirectory()) throw new Error("Workspace is not a directory")
    return { path: directory, real, dev: stat.dev.toString(), ino: stat.ino.toString() }
  }).pipe(
    Effect.catchCause(() =>
      Effect.die(new ReviewConflict({ message: "A worker's workspace is missing or could not be verified." })),
    ),
  )

/** Resolve only persisted owners; a client path never selects a snapshot context. */
export const resolve = Effect.fn("ReviewWorkspace.resolve")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
  messages: readonly MessageV2.WithParts[] = [],
) {
  const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const project = yield* Project.Service
  // Check before loading: a cached instance must not turn a missing directory into a new project.
  const directory = path.resolve(session.directory)
  const node = yield* inspect(directory)
  const found = yield* project.fromDirectory(directory)
  const ctx: InstanceContext = { directory, worktree: found.sandbox, project: found.project }
  const workspace = root(ctx.directory, ctx.worktree)
  if (ctx.project.id !== session.projectID || canonical(ctx.directory) !== canonical(directory))
    return yield* Effect.die(
      new ReviewConflict({ message: "A worker's workspace no longer matches its saved project." }),
    )
  for (const message of messages) {
    if (message.info.role !== "assistant" || !message.parts.some((part) => part.type === "patch")) continue
    if (
      canonical(message.info.path.cwd) !== canonical(directory) ||
      canonical(root(message.info.path.cwd, message.info.path.root)) !== canonical(workspace)
    )
      return yield* Effect.die(
        new ReviewConflict({ message: "A worker's file changes do not match their saved workspace origin." }),
      )
  }
  const nodes = canonical(directory) === canonical(workspace) ? [node] : [node, yield* inspect(workspace)]
  const last = nodes[nodes.length - 1]
  return {
    sessionID,
    directory,
    root: workspace,
    projectID: session.projectID,
    real: last.real,
    dev: last.dev,
    ino: last.ino,
    cwdReal: node.real,
    cwdDev: node.dev,
    cwdIno: node.ino,
    ctx,
    nodes,
  } satisfies Owner
})

export const identity = (owner: Owner): Identity => ({
  sessionID: owner.sessionID,
  directory: owner.directory,
  root: owner.root,
  projectID: owner.projectID,
  real: owner.real,
  dev: owner.dev,
  ino: owner.ino,
  cwdReal: owner.cwdReal,
  cwdDev: owner.cwdDev,
  cwdIno: owner.cwdIno,
})

export const same = (a: Identity, b: Identity) =>
  a.sessionID === b.sessionID &&
  a.projectID === b.projectID &&
  canonical(a.directory) === canonical(b.directory) &&
  canonical(a.root) === canonical(b.root) &&
  canonical(a.real) === canonical(b.real) &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  canonical(a.cwdReal) === canonical(b.cwdReal) &&
  a.cwdDev === b.cwdDev &&
  a.cwdIno === b.cwdIno

/** Recheck physical ownership immediately before each snapshot read or restore. */
export const run = <A, E, R>(owner: Owner, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    for (const node of owner.nodes) {
      const current = yield* inspect(node.path)
      if (canonical(current.real) !== canonical(node.real) || current.dev !== node.dev || current.ino !== node.ino)
        return yield* Effect.die(
          new ReviewConflict({ message: "A worker's workspace changed while reviewing. Refresh before continuing." }),
        )
    }
    return yield* body.pipe(Effect.provideService(InstanceRef, owner.ctx))
  })

/** Project each session in its own Git store and make relative patch claims unambiguous. */
export const group = Effect.fn("ReviewWorkspace.group")(function* (
  snap: Snapshot.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const messages = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
  const owner = yield* resolve(sessions, sessionID, messages)
  const projected = yield* run(owner, project(snap, messages, owner.root))
  return {
    owner,
    messages: projected.map((message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.type === "patch" ? { ...part, files: part.files.map((file) => path.resolve(owner.root, file)) } : part,
      ),
    })),
  }
})
