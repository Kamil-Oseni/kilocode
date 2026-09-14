import type { OpenFlag } from "effect/FileSystem"
import type { Identity } from "./checked-write"
import type { Entry } from "./checked-transaction"

export interface Options {
  readonly flag?: OpenFlag | undefined
  readonly mode?: number | undefined
  readonly recursive?: boolean | undefined
  readonly force?: boolean | undefined
  readonly overwrite?: boolean | undefined
  readonly preserveTimestamps?: boolean | undefined
  readonly directory?: string | undefined
  readonly prefix?: string | undefined
  readonly suffix?: string | undefined
}

export type Time =
  | { readonly type: "date"; readonly value: string }
  | { readonly type: "number"; readonly value: number }

export type Operation =
  | { readonly op: "chmod"; readonly path: string; readonly mode: number }
  | { readonly op: "chown"; readonly path: string; readonly uid: number; readonly gid: number }
  | { readonly op: "copy"; readonly from: string; readonly to: string; readonly options?: Options | undefined }
  | { readonly op: "copyFile"; readonly from: string; readonly to: string }
  | { readonly op: "link"; readonly from: string; readonly to: string }
  | { readonly op: "makeDirectory"; readonly path: string; readonly options?: Options | undefined }
  | { readonly op: "makeTempDirectory"; readonly options?: Options | undefined }
  | { readonly op: "makeTempFile"; readonly options?: Options | undefined }
  | { readonly op: "remove"; readonly path: string; readonly options?: Options | undefined }
  | { readonly op: "rename"; readonly from: string; readonly to: string }
  | { readonly op: "symlink"; readonly from: string; readonly to: string }
  | { readonly op: "truncate"; readonly path: string; readonly length?: number | undefined }
  | { readonly op: "utimes"; readonly path: string; readonly atime: Time; readonly mtime: Time }
  | {
      readonly op: "writeFile"
      readonly path: string
      readonly data: string
      readonly options?: Options | undefined
    }
  | {
      readonly op: "writeFileString"
      readonly path: string
      readonly data: string
      readonly options?: Options | undefined
    }
  | {
      readonly op: "writeFileChecked"
      readonly path: string
      readonly data: string
      readonly identity: Identity
      readonly sha256: string
    }
  | {
      readonly op: "writeFileExclusive"
      readonly path: string
      readonly data: string
    }
  | {
      readonly op: "writeFileAnchored"
      readonly path: string
      readonly data: string
      readonly root: string
      readonly identity: Identity
    }
  | {
      readonly op: "removeFileChecked"
      readonly path: string
      readonly identity: Identity
      readonly sha256: string
    }
  | {
      readonly op: "replaceFileChecked"
      readonly path: string
      readonly data: string
      readonly identity: Identity
      readonly sha256: string
    }
  | { readonly op: "stageFileTransaction"; readonly path: string; readonly entry: Entry; readonly data: string }
  | { readonly op: "commitFileTransaction"; readonly path: string; readonly entry: Entry }
  | { readonly op: "rollbackFileTransaction"; readonly path: string; readonly entry: Entry }
  | {
      readonly op: "cleanupFileTransaction"
      readonly path: string
      readonly entry: Entry
      readonly committed: boolean
    }

export type BatchOperation = Exclude<
  Operation,
  {
    readonly op:
      | "makeTempDirectory"
      | "makeTempFile"
      | "writeFileChecked"
      | "writeFileExclusive"
      | "writeFileAnchored"
      | "removeFileChecked"
      | "replaceFileChecked"
      | "stageFileTransaction"
      | "commitFileTransaction"
      | "rollbackFileTransaction"
      | "cleanupFileTransaction"
  }
>
export type Request = Operation | { readonly op: "batch"; readonly operations: ReadonlyArray<BatchOperation> }

export interface Failure {
  readonly name?: string | undefined
  readonly message: string
  readonly code?: string | undefined
  readonly errno?: number | undefined
  readonly syscall?: string | undefined
  readonly path?: string | undefined
  readonly dest?: string | undefined
  readonly operation?: Operation["op"] | undefined
}

export type Response =
  | { readonly ok: true; readonly value?: string | undefined }
  | { readonly ok: false; readonly error: Failure }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFailure(value: unknown): value is Failure {
  return isObject(value) && typeof value.message === "string"
}

function isIdentity(value: unknown): value is Identity {
  return (
    isObject(value) &&
    typeof value.dev === "string" &&
    /^\d+$/.test(value.dev) &&
    typeof value.ino === "string" &&
    /^\d+$/.test(value.ino)
  )
}

function isProof(value: unknown) {
  return (
    isObject(value) &&
    isIdentity(value.identity) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  )
}

function isEntry(value: unknown): value is Entry {
  if (!isObject(value) || !["create", "replace", "remove"].includes(String(value.kind))) return false
  if (typeof value.target !== "string") return false
  if (value.stage !== undefined && typeof value.stage !== "string") return false
  if (value.hold !== undefined && typeof value.hold !== "string") return false
  if (value.review !== undefined && !isProof(value.review)) return false
  if (value.artifact !== undefined && !isProof(value.artifact)) return false
  if (
    value.result !== undefined &&
    (!isObject(value.result) || typeof value.result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.result.sha256))
  )
    return false
  if (
    value.anchor !== undefined &&
    (!isObject(value.anchor) || typeof value.anchor.path !== "string" || !isIdentity(value.anchor.identity))
  )
    return false
  return true
}

export function isResponse(value: unknown): value is Response {
  if (!isObject(value)) return false
  if (value.ok === false) return isFailure(value.error)
  if (value.ok !== true) return false
  return value.value === undefined || typeof value.value === "string"
}

function isOperation(value: unknown): value is Operation {
  if (!isObject(value) || typeof value.op !== "string") return false
  const path = typeof value.path === "string"
  const from = typeof value.from === "string"
  const to = typeof value.to === "string"
  switch (value.op) {
    case "chmod":
      return path && typeof value.mode === "number"
    case "chown":
      return path && typeof value.uid === "number" && typeof value.gid === "number"
    case "copy":
    case "copyFile":
    case "link":
    case "rename":
    case "symlink":
      return from && to
    case "makeDirectory":
    case "remove":
    case "truncate":
      return path
    case "makeTempDirectory":
    case "makeTempFile":
      return true
    case "utimes":
      return path && isObject(value.atime) && isObject(value.mtime)
    case "writeFile":
    case "writeFileString":
    case "writeFileExclusive":
      return path && typeof value.data === "string"
    case "writeFileAnchored":
      return (
        path &&
        typeof value.data === "string" &&
        typeof value.root === "string" &&
        isObject(value.identity) &&
        typeof value.identity.dev === "string" &&
        /^\d+$/.test(value.identity.dev) &&
        typeof value.identity.ino === "string" &&
        /^\d+$/.test(value.identity.ino)
      )
    case "writeFileChecked":
    case "removeFileChecked":
    case "replaceFileChecked":
      return (
        path &&
        (value.op === "removeFileChecked" || typeof value.data === "string") &&
        isObject(value.identity) &&
        typeof value.identity.dev === "string" &&
        /^\d+$/.test(value.identity.dev) &&
        typeof value.identity.ino === "string" &&
        /^\d+$/.test(value.identity.ino) &&
        typeof value.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.sha256)
      )
    case "stageFileTransaction":
      return path && isEntry(value.entry) && value.entry.target === value.path && typeof value.data === "string"
    case "commitFileTransaction":
    case "rollbackFileTransaction":
      return path && isEntry(value.entry) && value.entry.target === value.path
    case "cleanupFileTransaction":
      return path && isEntry(value.entry) && value.entry.target === value.path && typeof value.committed === "boolean"
    default:
      return false
  }
}

function isBatchOperation(value: unknown): value is BatchOperation {
  return (
    isOperation(value) &&
    value.op !== "makeTempDirectory" &&
    value.op !== "makeTempFile" &&
    value.op !== "writeFileChecked" &&
    value.op !== "writeFileExclusive" &&
    value.op !== "writeFileAnchored" &&
    value.op !== "removeFileChecked" &&
    value.op !== "replaceFileChecked" &&
    value.op !== "stageFileTransaction" &&
    value.op !== "commitFileTransaction" &&
    value.op !== "rollbackFileTransaction" &&
    value.op !== "cleanupFileTransaction"
  )
}

export function isRequest(value: unknown): value is Request {
  if (!isObject(value) || typeof value.op !== "string") return false
  if (value.op !== "batch") return isOperation(value)
  return Array.isArray(value.operations) && value.operations.length > 0 && value.operations.every(isBatchOperation)
}

export function date(value: Date | number): Time {
  return value instanceof Date ? { type: "date", value: value.toISOString() } : { type: "number", value }
}
