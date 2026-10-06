import { createHash } from "node:crypto"
import { link, open, realpath, unlink } from "node:fs/promises"
import path from "node:path"
import { receive } from "@opencode-ai/core/kilocode/source-pipe"
import { decode } from "@opencode-ai/core/kilocode/source-transfer"
import { isRetired } from "@opencode-ai/core/kilocode/source-launch"
import { registry, withImage } from "@opencode-ai/core/kilocode/source-offline"
import { covers } from "@opencode-ai/core/kilocode/source-policy"
import { capsule, verify, verifyCapsule as verifyHost } from "@opencode-ai/core/kilocode/source-capsule"
import { assertRetirement, verifyCapsule } from "./source-host"
import { withOfflineCapture } from "./capture-authority"
import { exportProfile } from "./profile-export"
import { select } from "./profile-selection"
import { assertWorking, lookup, withWorking } from "./profile-image"
import { discover } from "./profile-artifacts"
import { namespaceScopes } from "./profile-scope"
import { workspaceScopes } from "./profile-workspace-scope"
import { identity } from "./profile-workspaces"
import { planSelfHeal } from "./profile-self-heal"
import { capture as captureConfig } from "./profile-config"
import { assertCoverage } from "./source-image-coverage"

const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)

/** Product receiver: a live retirement token and a private pipe precede any export. */
export async function capture(token: object) {
  const closure = assertRetirement(token)
  if (closure.purpose !== "export" || !isRetired(closure.proof) || !closure.pipe)
    throw new Error("Source export lacks authenticated retirement and intent")
  const input = decode(await receive(closure.pipe, closure.pipe.server))
  if (
    input.id !== closure.ack.id ||
    input.source.pid !== closure.ack.source.pid ||
    input.source.birth !== closure.ack.source.birth ||
    input.source.digest !== closure.ack.source.digest ||
    key(await realpath(input.source.executable)) !== key(closure.ack.source.executable)
  )
    throw new Error("Source export request differs from retired native identity")
  const profile = await select(input.profile, closure.policy)
  if (!closure.ack.scopes) throw new Error("Source export lacks authenticated state scope identities")
  const namespaces = await namespaceScopes(closure.ack.scopes, closure.roots, closure.policy)
  const states = namespaces.states
  const authority = async () => ({
    policy: assertRetirement(token).policy,
    verify: (text: string, signature: string) => verifyCapsule(token, text, signature),
  })
  const expected = { id: input.id, source: input.source, data: profile.profile.data }
  const host = input.host ? await verify(input.host, expected, authority) : undefined
  const artifacts = (
    await Promise.all(
      [...new Set([profile.profile.data, ...namespaces.globals.map((roles) => roles.data)])].map((data) =>
        discover({ data, workspaces: [] }),
      ),
    )
  ).flat()
  const historical =
    host?.hosts.flatMap((host) =>
      [...host.owners, ...host.contexts].flatMap((item) => (item.root ? [item.root] : [])),
    ) ?? []
  if ([...artifacts, ...historical].some((root) => !covers(closure.policy, root.path)))
    throw new Error("Artifact or historical host roots escape the retired producer policy")
  const roots = [...profile.roots]
  const scopes = Object.freeze([
    ...new Map(
      [
        { data: profile.profile.data, storage: profile.profile.storage },
        ...namespaces.globals.map((roles) => ({ data: roles.data, storage: path.join(roles.data, "storage") })),
      ].map((scope) => [`${key(scope.data)}:${key(scope.storage)}`, Object.freeze(scope)]),
    ).values(),
  ])
  for (const root of [
    ...closure.roots, // Include every authenticated root in the final held image; disposition still classifies payloads.
    ...namespaces.roots,
    ...namespaces.origins,
    ...artifacts,
    ...historical,
    ...(input.host ? [{ kind: "json" as const, path: input.host.file }] : []),
    ...scopes.map((scope) => ({ kind: "json" as const, path: scope.storage })),
  ]) {
    if (roots.some((parent) => parent.kind === root.kind && key(parent.path) === key(root.path))) continue
    roots.push(root)
  }
  const selected = Object.freeze({ ...profile, roots: Object.freeze([...roots]), globals: namespaces.globals })
  const planned = await withImage(
    { roots: selected.roots, policy: closure.policy, helper: closure.pipe.server, registry: registry() },
    (image) =>
      withWorking(image, selected, async (working) => {
        const [workspaces, selfHeal] = await Promise.all([workspaceScopes(working), planSelfHeal(working, scopes)])
        return { workspaces, selfHeal }
      }),
  )
  const workspaces = [
    ...new Map(
      [
        ...planned.workspaces,
        ...planned.selfHeal.requirements
          .filter((item) => ["repair-worktree", "source-repository", "verification-checkout"].includes(item.kind))
          .map((item) => item.path),
      ].map((file) => [identity(file), file]),
    ).values(),
  ].sort()
  if (workspaces.some((file) => !covers(closure.policy, file)))
    throw new Error("Historical SQL workspace escapes the retired producer policy")
  const directories = await Promise.all(
    workspaces.map(async (file) => {
      const canonical = await realpath(file)
      if (identity(canonical) !== identity(file) || !covers(closure.policy, canonical))
        throw new Error("Historical SQL workspace canonical identity changed")
      return canonical
    }),
  )
  const metadata = await discover({ data: profile.profile.data, workspaces: directories })
  for (const root of [
    ...directories.map((file) => ({ kind: "json" as const, path: file })),
    ...planned.selfHeal.requirements.map((item) => ({ kind: "json" as const, path: item.path })),
    ...metadata,
  ]) {
    if (!covers(closure.policy, root.path))
      throw new Error("Historical SQL workspace or Git namespace escapes the retired producer policy")
    if (!roots.some((parent) => parent.kind === root.kind && key(parent.path) === key(root.path))) roots.push(root)
  }
  const complete = Object.freeze({ ...selected, roots: Object.freeze([...roots]) })
  const directory = await realpath(path.dirname(input.output))
  if (
    [...closure.roots, ...complete.roots].some(
      (root) => key(directory) === key(root.path) || key(directory).startsWith(key(root.path) + path.sep),
    )
  )
    throw new Error("Source export output overlaps captured profile")
  const output = path.join(directory, path.basename(input.output))
  // This authorizes the typed selected payload only. Full migration acceptance and
  // host/workspace artifact coverage remain separate mandatory checks.
  const bundle = await withImage(
    { roots: complete.roots, policy: closure.policy, helper: closure.pipe.server, registry: registry() },
    (image) =>
      withWorking(image, complete, async (working) => {
        const staged = assertWorking(working)
        assertCoverage(working, closure.roots)
        if (JSON.stringify(await workspaceScopes(working)) !== JSON.stringify(planned.workspaces))
          throw new Error("Historical workspace inventory changed between held images")
        if (JSON.stringify(await planSelfHeal(working, scopes)) !== JSON.stringify(planned.selfHeal))
          throw new Error("Self-heal history inventory changed between held images")
        const captured = input.host
          ? await verifyHost(
              input.host,
              {
                ...expected,
                readPath: lookup(working, input.host.file),
              },
              authority,
            )
          : undefined
        const config = await captureConfig(working, namespaces.configs)
        return withOfflineCapture(token, working, (proof, roots) =>
          exportProfile(proof, roots, staged.profile, input.password, {
            working,
            data: selected.profile.data,
            host: captured ? capsule(captured).payload : undefined,
            hostProof: captured,
            states: states.map((root) => root.path),
            globals: namespaces.globals,
            selfHealScopes: scopes,
            workspaces,
            config,
          }),
        )
      }),
  )
  const temporary = path.join(directory, `.raya-export-${crypto.randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  const errors: unknown[] = []
  try {
    await handle.writeFile(bundle, "utf8")
    await handle.sync()
    await handle.close()
    // Linking publishes atomically and refuses an existing destination on Windows.
    await link(temporary, output)
  } catch (err) {
    errors.push(err)
  }
  await handle.close().catch((err: unknown) => errors.push(err))
  await unlink(temporary).catch((err: unknown) => errors.push(err))
  if (errors.length) throw new AggregateError(errors, "Source export publication failed")
  return Object.freeze({
    output,
    bytes: Buffer.byteLength(bundle),
    digest: createHash("sha256").update(bundle).digest("hex"),
  })
}
