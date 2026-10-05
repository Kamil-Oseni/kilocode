import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { GlobalScopes } from "@opencode-ai/core/kilocode/source-scopes"
import { inventory, type Working } from "./profile-image"
import { notes } from "./profile-notes"
import { PlanArtifact } from "../plan-artifact"
import { semantic, sqlGroups, validateSQL, type SQLClaim, type SQLComponents } from "./profile-sql-correspondence"
import { transformed, configGroups, validateConfig, type ConfigClaim } from "./profile-config-correspondence"
import {
  configMarkdown,
  markdownGroups,
  validateMarkdown,
  type MarkdownClaim,
} from "./profile-config-markdown-correspondence"
import { git, gitGroups, validateGit, type GitClaim, type GitComponents } from "./profile-git-correspondence"
import { hostTransform, hostGroups, validateHost, type HostClaim } from "./profile-host-correspondence"
import {
  memoryTransform,
  memoryGroups,
  validateMemory,
  type MemoryClaim,
  type MemoryComponents,
} from "./profile-memory-correspondence"
import {
  storageJSON,
  storageGroups,
  validateStorage,
  type StorageClaim,
  type StorageComponents,
} from "./profile-storage-correspondence"
import { gitMetadata } from "./profile-git-metadata-schema"
import { gitMetadataGroups, validateGitMetadata, type GitMetadataClaim } from "./profile-git-metadata-correspondence"
import { voiceReconciliation, voice } from "./profile-voice-reconciliation-schema"
import { operational, operationalPolicy, operationalPolicies } from "./profile-operational-schema"
import { operationalGroups, validateOperational, type OperationalClaim } from "./profile-operational-correspondence"
import { restoredGit } from "./profile-restored-git-schema"
import { restoredComponent } from "./profile-restored-components-schema"
import { restoredSource } from "./profile-restored-source-schema"
import {
  restoredSourceGroups,
  validateRestoredSource,
  type RestoredSourceClaim,
  type RestoredSources,
} from "./profile-restored-source-correspondence"
import { restoreHold, holdGroups, validateHold, type HoldClaim } from "./profile-restore-hold-correspondence"
import {
  restoredComponentGroups,
  validateRestoredComponent,
  type RestoredComponentClaim,
  type RestoredComponents,
} from "./profile-restored-components-correspondence"
import { tuiJSON, tuiGroups, validateTui, type TuiClaim, type TuiComponents } from "./profile-tui-correspondence"
import {
  restoredGitGroups,
  validateRestoredGit,
  type RestoredGitClaim,
  type RestoredGitComponents,
} from "./profile-restored-git-correspondence"
import { voiceGroups, validateVoice, type VoiceClaim } from "./profile-voice-reconciliation"
import { hostModel, hostModelGroups, validateHostModel, type HostModelClaim } from "./profile-host-model-correspondence"
import {
  memoryDerived,
  memoryDerivedGroups,
  validateMemoryDerived,
  type MemoryDerivedClaim,
} from "./profile-memory-derived"
import {
  composerJSON,
  composerGroups,
  validateComposer,
  type ComposerClaim,
  type ComposerComponents,
} from "./profile-composer-correspondence"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file))
const component = z.literal("notes")
const shape = z
  .object({
    format: z.literal("raya.profile-disposition"),
    version: z.literal(1),
    scope: z.literal("selected-held-files"),
    mode: z.enum(["selected", "strict-full"]),
    globals: z.array(GlobalScopes).max(128),
    roots: z
      .array(
        z
          .object({ kind: z.enum(["json", "sqlite"]), path: absolute, directory: z.boolean(), absent: z.boolean() })
          .strict(),
      )
      .max(128),
    files: z
      .array(
        z
          .object({
            path: absolute,
            dev: z.string().regex(/^\d+$/),
            ino: z.string().regex(/^\d+$/),
            bytes: z.number().int().nonnegative(),
            digest,
            modified: z
              .string()
              .max(20)
              .regex(/^\d+$/)
              .refine((value) => /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n)
              .optional(),
            roots: z.array(z.number().int().nonnegative()).max(128),
            roles: z.array(z.object({ graph: digest, role: z.string().max(64), root: absolute }).strict()).max(1280),
            disposition: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("preserved"), component, digest, sourceDigest: digest }).strict(),
              z.object({ kind: z.literal("credential-omission"), reason: z.literal("known-auth-store") }).strict(),
              z.object({ kind: z.literal("unclassified"), reason: z.literal("no-component-binding") }).strict(),
              semantic,
              git,
              transformed,
              configMarkdown,
              hostTransform,
              memoryTransform,
              storageJSON,
              gitMetadata,
              voiceReconciliation,
              hostModel,
              composerJSON,
              memoryDerived,
              operationalPolicy,
              restoredGit,
              restoredComponent,
              tuiJSON,
              restoredSource,
              restoreHold,
            ]),
          })
          .strict(),
      )
      .max(16384),
    directories: z
      .array(
        z
          .object({
            path: absolute,
            dev: z.string().regex(/^\d+$/),
            ino: z.string().regex(/^\d+$/),
            children: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .min(1)
                      .max(255)
                      .refine((name) => !/[\\/:\0\r\n]/.test(name) && name !== "." && name !== ".."),
                    directory: z.boolean(),
                    dev: z.string().regex(/^\d+$/),
                    ino: z.string().regex(/^\d+$/),
                  })
                  .strict(),
              )
              .max(16384),
          })
          .strict(),
      )
      .max(16384)
      .optional(),
    directoryCoverage: z.enum(["unavailable", "verified"]),
    incomplete: z.array(z.enum(["unclassified-files", "native-directory-inventory-unavailable"])).max(2),
    fingerprint: digest,
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()

export const disposition = shape.superRefine((item, ctx) => {
  if (
    item.fingerprint !==
    sum(JSON.stringify({ roots: item.roots, globals: item.globals, files: item.files, directories: item.directories }))
  )
    ctx.addIssue({ code: "custom", message: "Disposition fingerprint differs" })
  if (new Set(item.files.map((file) => key(file.path))).size !== item.files.length)
    ctx.addIssue({ code: "custom", message: "Disposition file paths duplicate" })
  for (const file of item.files) {
    if (!file.roots.length || file.roots.some((index) => index >= item.roots.length))
      ctx.addIssue({ code: "custom", message: "Disposition file root binding is unavailable" })
    if (
      file.roots.some((index) => {
        const root = item.roots[index]
        if (!root || root.absent) return true
        if (root.kind === "sqlite")
          return !["", "-wal", "-shm"].some((suffix) => key(root.path + suffix) === key(file.path))
        return !(root.directory ? inside(root.path, file.path) : key(root.path) === key(file.path))
      })
    )
      ctx.addIssue({ code: "custom", message: "Disposition file differs from its logical roots" })
    if (file.disposition.kind === "preserved" && file.disposition.sourceDigest !== file.digest)
      ctx.addIssue({ code: "custom", message: "Preserved component digest differs from source" })
    if (file.disposition.kind === "sqlite-semantic") {
      const source = file.disposition.source
      if (
        !file.roots.some(
          (index) => item.roots[index]?.kind === "sqlite" && key(item.roots[index].path) === key(source),
        ) ||
        !["", "-wal", "-shm"].some((suffix) => key(source + suffix) === key(file.path))
      )
        ctx.addIssue({ code: "custom", message: "SQLite disposition lacks its exact recovery root" })
    }
    if (file.disposition.kind === "config-semantic" || file.disposition.kind === "config-markdown") {
      const config = file.disposition
      if (
        key(config.source) !== key(file.path) ||
        config.identity.dev !== file.dev ||
        config.identity.ino !== file.ino ||
        config.bytes !== file.bytes ||
        config.sourceDigest !== file.digest
      )
        ctx.addIssue({ code: "custom", message: "Configuration disposition differs from its native origin" })
    }
    if (file.disposition.kind === "git-bytes") {
      const git = file.disposition
      if (
        key(git.source) !== key(file.path) ||
        git.dev !== file.dev ||
        git.ino !== file.ino ||
        git.bytes !== file.bytes ||
        git.digest !== file.digest ||
        !file.roots.some((index) => item.roots[index]?.kind === "json")
      )
        ctx.addIssue({ code: "custom", message: "Git disposition differs from its native origin" })
    }
    if (file.disposition.kind === "host-semantic") {
      const host = file.disposition
      if (
        key(host.source) !== key(file.path) ||
        host.identity.dev !== file.dev ||
        host.identity.ino !== file.ino ||
        host.bytes !== file.bytes ||
        host.sourceDigest !== file.digest ||
        !file.roots.some((index) => {
          const root = item.roots[index]
          return root?.kind === "json" && !root.directory && key(root.path) === key(file.path)
        })
      )
        ctx.addIssue({ code: "custom", message: "Host disposition differs from its exact native origin" })
    }
    if (
      [
        "memory-semantic",
        "storage-json",
        "git-metadata",
        "voice-reconciliation",
        "host-model",
        "composer-json",
        "memory-derived",
        "operational-policy",
        "restored-git",
        "restored-component",
        "tui-json",
        "restored-source",
        "restore-hold",
      ].includes(file.disposition.kind)
    ) {
      const entry = file.disposition
      if (
        entry.kind === "memory-semantic" ||
        entry.kind === "storage-json" ||
        entry.kind === "git-metadata" ||
        entry.kind === "voice-reconciliation" ||
        entry.kind === "host-model" ||
        entry.kind === "composer-json" ||
        entry.kind === "memory-derived" ||
        entry.kind === "operational-policy" ||
        entry.kind === "restored-git" ||
        entry.kind === "restored-component" ||
        entry.kind === "tui-json" ||
        entry.kind === "restored-source" ||
        entry.kind === "restore-hold"
      ) {
        if (
          key(entry.source) !== key(file.path) ||
          entry.dev !== file.dev ||
          entry.ino !== file.ino ||
          entry.bytes !== file.bytes ||
          entry.digest !== file.digest
        )
          ctx.addIssue({ code: "custom", message: "Component disposition differs from its native origin" })
        if (
          (entry.kind === "restored-git" || entry.kind === "restored-component" || entry.kind === "restored-source") &&
          (!item.globals.some((graph) => key(graph.data) === key(entry.data)) || entry.modified !== file.modified)
        )
          ctx.addIssue({
            code: "custom",
            message: "Restored disposition lacks its exact data mapping or timestamp",
          })
        if (entry.kind === "tui-json" && !item.globals.some((graph) => key(graph.state) === key(entry.state)))
          ctx.addIssue({ code: "custom", message: "TUI disposition lacks its declared Global state mapping" })
        if (entry.kind === "restore-hold" && !item.globals.some((graph) => key(graph.data) === key(entry.data)))
          ctx.addIssue({ code: "custom", message: "Restore hold lacks its declared Global data mapping" })
        if (entry.kind === "operational-policy") {
          const policy = operationalPolicies[entry.role]
          if (
            !item.globals.some((graph) => {
              const root = policy.scope === "storage" ? path.join(graph.data, "storage") : graph[policy.scope]
              return key(graph.data) === key(entry.data) && key(root) === key(entry.root)
            })
          )
            ctx.addIssue({ code: "custom", message: "Operational disposition lacks its declared Global mapping" })
        }
        if (
          (entry.kind === "memory-semantic" || entry.kind === "memory-derived") &&
          !item.globals.some((graph) => key(graph.data) === key(entry.data))
        )
          ctx.addIssue({ code: "custom", message: "Memory disposition lacks its declared data mapping" })
        if (
          entry.kind === "storage-json" &&
          !item.globals.some((graph) => key(path.join(graph.data, "storage")) === key(entry.storage))
        )
          ctx.addIssue({ code: "custom", message: "Storage disposition lacks its declared data mapping" })
        if (
          entry.kind === "voice-reconciliation" &&
          !item.globals.some(
            (graph) =>
              key(graph.data) === key(entry.data) && key(path.join(graph.data, "storage")) === key(entry.storage),
          )
        )
          ctx.addIssue({ code: "custom", message: "Voice disposition lacks its declared data mapping" })
        if (
          entry.kind === "composer-json" &&
          !item.globals.some((graph) => key(path.join(graph.data, "storage")) === key(entry.storage))
        )
          ctx.addIssue({ code: "custom", message: "Composer disposition lacks its declared data mapping" })
        if (
          entry.kind === "host-model" &&
          !file.roots.some(
            (index) =>
              item.roots[index]?.kind === "json" &&
              !item.roots[index]?.directory &&
              key(item.roots[index].path) === key(file.path),
          )
        )
          ctx.addIssue({ code: "custom", message: "Host model disposition lacks its exact native root" })
      }
    }
    if (
      file.disposition.kind === "credential-omission" &&
      !item.globals.some((graph) => key(path.join(graph.data, "auth.json")) === key(file.path))
    )
      ctx.addIssue({ code: "custom", message: "Credential omission lacks a declared authentication path" })
    for (const role of file.roles) {
      const graph = item.globals.find((graph) => graphid(graph) === role.graph)
      if (
        !graph ||
        !Object.entries(graph).some(([name, root]) => name === role.role && key(root) === key(role.root)) ||
        !file.roots.some((index) => key(item.roots[index]?.path ?? "") === key(role.root))
      )
        ctx.addIssue({ code: "custom", message: "Disposition role lacks its declared Global mapping" })
    }
  }
  const incomplete = [
    ...(item.files.some(
      (file) =>
        file.disposition.kind === "unclassified" ||
        (file.disposition.kind === "sqlite-semantic" && !file.disposition.complete),
    )
      ? ["unclassified-files"]
      : []),
    ...(item.directoryCoverage === "unavailable" && item.roots.some((root) => root.directory && !root.absent)
      ? ["native-directory-inventory-unavailable"]
      : []),
  ]
  if ((item.directoryCoverage === "verified") !== (item.directories !== undefined))
    ctx.addIssue({ code: "custom", message: "Disposition directory protocol differs" })
  if (item.directories) {
    const directories = new Map(item.directories.map((entry) => [key(entry.path), entry]))
    const files = new Map(item.files.map((entry) => [key(entry.path), entry]))
    if (
      directories.size !== item.directories.length ||
      item.directories.reduce((sum, entry) => sum + entry.children.length, 0) > 16384
    )
      ctx.addIssue({ code: "custom", message: "Disposition directory inventory duplicates or exceeded bound" })
    for (const root of item.roots) {
      if (root.kind === "json" && root.directory && !root.absent && !directories.has(key(root.path)))
        ctx.addIssue({ code: "custom", message: "Disposition directory root lacks traversal" })
    }
    for (const directory of item.directories) {
      if (
        !item.roots.some(
          (root) => root.kind === "json" && root.directory && !root.absent && inside(root.path, directory.path),
        )
      )
        ctx.addIssue({ code: "custom", message: "Disposition directory escapes positive roots" })
      if (new Set(directory.children.map((child) => key(child.name))).size !== directory.children.length)
        ctx.addIssue({ code: "custom", message: "Disposition directory children duplicate" })
      for (const child of directory.children) {
        const file = key(path.join(directory.path, child.name))
        const entry = child.directory ? directories.get(file) : files.get(file)
        if (!entry || entry.dev !== child.dev || entry.ino !== child.ino)
          ctx.addIssue({ code: "custom", message: "Disposition directory child identity differs" })
      }
    }
    for (const entry of [...item.directories, ...item.files]) {
      const root = item.roots.find(
        (root) => root.kind === "json" && root.directory && !root.absent && inside(root.path, entry.path),
      )
      if (!root || key(root.path) === key(entry.path)) continue
      if (
        !directories
          .get(key(path.dirname(entry.path)))
          ?.children.some((child) => key(child.name) === key(path.basename(entry.path)))
      )
        ctx.addIssue({ code: "custom", message: "Disposition descendant lacks a parent edge" })
    }
  }
  if (JSON.stringify(item.incomplete) !== JSON.stringify(incomplete))
    ctx.addIssue({ code: "custom", message: "Disposition incompleteness differs from native coverage" })
  if (item.mode === "strict-full" && item.incomplete.length)
    ctx.addIssue({ code: "custom", message: "Strict disposition is incomplete" })
  if (Buffer.byteLength(JSON.stringify(item)) > 4 * 1024 * 1024)
    ctx.addIssue({ code: "custom", message: "Disposition exceeds supported bytes" })
})

const key = (file: string) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file))
const sum = (bytes: string) => createHash("sha256").update(bytes).digest("hex")
const graphid = (graph: z.infer<typeof GlobalScopes>) =>
  sum(JSON.stringify(Object.fromEntries(Object.entries(graph).map(([name, file]) => [name, key(file)]))))
const freeze = <T>(input: T): T => {
  if (typeof input !== "object" || input === null) return input
  for (const value of Object.values(input)) freeze(value)
  return Object.freeze(input)
}
const inside = (root: string, file: string) => {
  const relative = path.relative(key(root), key(file))
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
const brand: unique symbol = Symbol("held-file-component")
type Claim = Readonly<{ [brand]: true }>
const claims = new WeakMap<
  object,
  { token: Working; path: string; component: z.infer<typeof component>; digest: string; sourceDigest: string }
>()
const credential = (input: ReturnType<typeof inventory>, file: string) =>
  input.globals.some((graph) => key(path.join(graph.data, "auth.json")) === key(file))

/** An inert ledger's preserved claims must also resolve to the actual typed component in its snapshot. */
export function validateDisposition(
  input: z.input<typeof disposition>,
  content?: z.input<typeof notes>,
  sql?: SQLComponents,
  config?: unknown,
  artifacts?: GitComponents,
  host?: unknown,
  memory?: MemoryComponents,
  storage?: StorageComponents,
  speech?: Readonly<{ voice?: z.output<typeof voice> }>,
  drafts?: ComposerComponents,
  policies?: Readonly<{ operational?: z.output<typeof operational> }>,
  restored?: RestoredGitComponents,
  prior?: RestoredComponents,
  tui?: TuiComponents,
  sources?: RestoredSources,
) {
  const ledger = disposition.parse(input)
  const parsed = content ? notes.parse(content) : undefined
  for (const file of ledger.files) {
    if (file.disposition.kind === "restored-source") {
      if (!sources) throw new Error("Disposition lacks its original restored source projection")
      validateRestoredSource(file.disposition, sources)
      continue
    }
    if (file.disposition.kind === "restore-hold") {
      if (!memory) throw new Error("Disposition lacks its current inert memory hold component")
      validateHold(file.disposition, memory)
      continue
    }
    if (file.disposition.kind === "restored-component") {
      if (!prior) throw new Error("Disposition lacks its restored component projection")
      validateRestoredComponent(file.disposition, prior)
      continue
    }
    if (file.disposition.kind === "tui-json") {
      if (!tui) throw new Error("Disposition lacks its current TUI component")
      validateTui(file.disposition, tui)
      continue
    }
    if (file.disposition.kind === "restored-git") {
      if (!restored) throw new Error("Disposition lacks its restored Git component")
      validateRestoredGit(file.disposition, restored)
      continue
    }
    if (file.disposition.kind === "operational-policy") {
      if (!policies) throw new Error("Disposition lacks its operational component")
      validateOperational(file.disposition, policies)
      continue
    }
    if (file.disposition.kind === "memory-derived") {
      if (!memory) throw new Error("Disposition lacks its derived memory component")
      validateMemoryDerived(file.disposition, memory)
      continue
    }
    if (file.disposition.kind === "composer-json") {
      if (!drafts) throw new Error("Disposition lacks its composer component")
      validateComposer(file.disposition, drafts)
      continue
    }
    if (file.disposition.kind === "voice-reconciliation") {
      if (!speech) throw new Error("Disposition lacks its voice component")
      validateVoice(file.disposition, speech)
      continue
    }
    if (file.disposition.kind === "host-model") {
      validateHostModel(file.disposition, host)
      continue
    }
    if (file.disposition.kind === "memory-semantic") {
      if (!memory) throw new Error("Disposition lacks its memory component")
      validateMemory(file.disposition, memory)
      continue
    }
    if (file.disposition.kind === "storage-json") {
      if (!storage) throw new Error("Disposition lacks its storage component")
      validateStorage(file.disposition, storage)
      continue
    }
    if (file.disposition.kind === "git-metadata") {
      if (!artifacts) throw new Error("Disposition lacks its Git metadata component")
      validateGitMetadata(file.disposition, artifacts)
      continue
    }
    if (file.disposition.kind === "host-semantic") {
      validateHost(file.disposition, host)
      continue
    }
    if (file.disposition.kind === "git-bytes") {
      if (!artifacts) throw new Error("Disposition lacks its Git component")
      validateGit(file.disposition, artifacts)
      continue
    }
    if (file.disposition.kind === "config-semantic") {
      validateConfig(file.disposition, config)
      continue
    }
    if (file.disposition.kind === "config-markdown") {
      validateMarkdown(file.disposition, config)
      continue
    }
    if (file.disposition.kind === "sqlite-semantic") {
      if (!sql) throw new Error("Disposition lacks its SQLite component")
      if (
        !["", "-wal", "-shm"].some(
          (suffix) =>
            key(file.path) === key(file.disposition.kind === "sqlite-semantic" ? file.disposition.source + suffix : ""),
        )
      )
        throw new Error("Disposition SQLite group path differs")
      validateSQL(file.disposition, sql)
      continue
    }
    if (file.disposition.kind !== "preserved") continue
    if (!parsed || file.disposition.digest !== sum(JSON.stringify(parsed)))
      throw new Error("Disposition lacks its preserved notes component")
    const matched = parsed.plans
      .filter((item) => item.scope === "data")
      .flatMap((item) => [
        { path: path.join(item.root, "plans", item.name), value: item.markdown },
        ...(item.sidecar
          ? [{ path: path.join(item.root, "plans", PlanArtifact.sidecar(item.name)), value: item.sidecar }]
          : []),
      ])
      .filter((item) => key(item.path) === key(file.path))
    if (
      matched.length !== 1 ||
      matched[0].value.digest !== file.digest ||
      Buffer.byteLength(matched[0].value.text) !== file.bytes
    )
      throw new Error("Disposition differs from its preserved plan bytes")
  }
}

/** Only strict active data-plan codec entries bind in this phase; arbitrary labels and transformed bytes do not. */
export function bindDisposition(token: Working, file: string, input: z.input<typeof notes>): Claim {
  const value = inventory(token)
  const parsed = notes.parse(input)
  const records = value.files.filter((item) => key(item.path) === key(file))
  if (records.length !== 1) throw new Error("Component requires one exact native file identity")
  const record = records[0]
  if (credential(value, record.path)) throw new Error("Authentication store cannot be preserved as a component")
  const documents = parsed.plans
    .filter((item) => item.scope === "data")
    .flatMap((item) => [
      { path: path.join(item.root, "plans", item.name), value: item.markdown },
      ...(item.sidecar
        ? [{ path: path.join(item.root, "plans", PlanArtifact.sidecar(item.name)), value: item.sidecar }]
        : []),
    ])
  const matches = documents.filter((item) => key(item.path) === key(record.path))
  if (matches.length !== 1) throw new Error("Held file lacks one exact typed data-plan entry")
  const text = matches[0].value.text
  if (record.bytes !== Buffer.byteLength(text) || record.digest !== sum(text))
    throw new Error("Component bytes differ from the held native file")
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, {
    token,
    path: record.path,
    component: "notes",
    digest: sum(JSON.stringify(parsed)),
    sourceDigest: record.digest,
  })
  return claim
}

/** Serialized accounting is evidence, never source, capture, root or component authority. */
export function collectDisposition(
  token: Working,
  input: readonly Claim[] = [],
  mode: "selected" | "strict-full" = "selected",
  sql?: SQLClaim,
  config?: ConfigClaim,
  git?: GitClaim,
  host?: HostClaim,
  memory?: MemoryClaim,
  storage?: StorageClaim,
  metadata?: GitMetadataClaim,
  speech?: VoiceClaim,
  models?: HostModelClaim,
  drafts?: ComposerClaim,
  derived?: MemoryDerivedClaim,
  policies?: OperationalClaim,
  restored?: RestoredGitClaim,
  prior?: RestoredComponentClaim,
  tui?: TuiClaim,
  sources?: RestoredSourceClaim,
  hold?: HoldClaim,
  markdown?: MarkdownClaim,
) {
  const value = inventory(token)
  const groups = sql ? sqlGroups(token, sql) : []
  const configs = [...(config ? configGroups(token, config) : []), ...(markdown ? markdownGroups(token, markdown) : [])]
  const artifacts = git ? gitGroups(token, git) : []
  const hosts = host ? hostGroups(token, host) : []
  const memories = memory ? memoryGroups(token, memory) : []
  const json = storage ? storageGroups(token, storage) : []
  const admin = metadata ? gitMetadataGroups(token, metadata) : []
  const spoken = speech ? voiceGroups(token, speech) : []
  const choices = models ? hostModelGroups(token, models) : []
  const composers = drafts ? composerGroups(token, drafts) : []
  const rendered = derived ? memoryDerivedGroups(token, derived) : []
  const omitted = policies ? operationalGroups(token, policies) : []
  const historical = restored ? restoredGitGroups(token, restored) : []
  const components = prior ? restoredComponentGroups(token, prior) : []
  const display = tui ? tuiGroups(token, tui) : []
  const originals = sources ? restoredSourceGroups(token, sources) : []
  const held = hold ? holdGroups(token, hold) : []
  const selected = new Map<string, { component: z.infer<typeof component>; digest: string; sourceDigest: string }>()
  for (const claim of input) {
    const item = claims.get(claim)
    if (!item || item.token !== token) throw new Error("Component binding is absent or belongs to another image")
    if (selected.has(key(item.path))) throw new Error("Conflicting component bindings")
    selected.set(key(item.path), { component: item.component, digest: item.digest, sourceDigest: item.sourceDigest })
  }
  const files = new Map<string, z.infer<typeof shape>["files"][number]>()
  for (const record of value.files) {
    const prior = files.get(key(record.path))
    if (prior) {
      if (
        prior.dev !== record.dev ||
        prior.ino !== record.ino ||
        prior.bytes !== record.bytes ||
        prior.digest !== record.digest ||
        prior.modified !== record.modified
      )
        throw new Error("Native file inventory contains conflicting identities")
      continue
    }
    const binding = selected.get(key(record.path))
    const group = groups.find((item) =>
      ["", "-wal", "-shm"].some((suffix) => key(item.source + suffix) === key(record.path)),
    )
    const intent = configs.find((item) => key(item.source) === key(record.path))
    const artifact = artifacts.find((item) => key(item.source) === key(record.path))
    const capsule = hosts.find((item) => key(item.source) === key(record.path))
    const retained = [
      ...memories,
      ...json,
      ...admin,
      ...spoken,
      ...choices,
      ...composers,
      ...rendered,
      ...omitted,
      ...historical,
      ...components,
      ...display,
      ...originals,
      ...held,
    ].find((item) => key(item.source) === key(record.path))
    const roots = value.roots.flatMap((root, index) => {
      if (root.absent) return []
      if (root.kind === "sqlite")
        return ["", "-wal", "-shm"].some((suffix) => key(root.path + suffix) === key(record.path)) ? [index] : []
      return (root.directory ? inside(root.path, record.path) : key(root.path) === key(record.path)) ? [index] : []
    })
    if (!roots.length) throw new Error("Native file lacks a declared logical root")
    const roles = value.globals.flatMap((graph) =>
      Object.entries(graph).flatMap(([role, root]) => {
        const declared = value.roots.find((item) => key(item.path) === key(root))
        if (
          !declared ||
          declared.absent ||
          !(declared.directory ? inside(root, record.path) : key(root) === key(record.path))
        )
          return []
        return [
          {
            graph: graphid(graph),
            role,
            root,
          },
        ]
      }),
    )
    files.set(key(record.path), {
      ...record,
      roots,
      roles,
      disposition: binding
        ? { kind: "preserved", ...binding }
        : group
          ? group
          : credential(value, record.path)
            ? { kind: "credential-omission", reason: "known-auth-store" }
            : intent
              ? intent
              : artifact
                ? artifact
                : capsule
                  ? capsule
                  : retained
                    ? retained
                    : { kind: "unclassified", reason: "no-component-binding" },
    })
  }
  const ordered = [...files.values()].sort((a, b) =>
    key(a.path) < key(b.path) ? -1 : key(a.path) > key(b.path) ? 1 : 0,
  )
  const incomplete: z.infer<typeof disposition>["incomplete"] = [
    ...(ordered.some(
      (file) =>
        file.disposition.kind === "unclassified" ||
        (file.disposition.kind === "sqlite-semantic" && !file.disposition.complete),
    )
      ? ["unclassified-files" as const]
      : []),
    ...(value.directoryCoverage === "unavailable" && value.roots.some((root) => root.directory && !root.absent)
      ? ["native-directory-inventory-unavailable" as const]
      : []),
  ]
  if (mode === "strict-full" && incomplete.length)
    throw new Error(`Full held namespace disposition is incomplete: ${incomplete.join(",")}`)
  const result = disposition.parse({
    format: "raya.profile-disposition",
    version: 1,
    scope: "selected-held-files",
    mode,
    roots: value.roots,
    globals: value.globals,
    files: ordered,
    directoryCoverage: value.directoryCoverage,
    directories: value.directories,
    incomplete,
    fingerprint: sum(
      JSON.stringify({ roots: value.roots, globals: value.globals, files: ordered, directories: value.directories }),
    ),
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
  })
  return freeze(result)
}
