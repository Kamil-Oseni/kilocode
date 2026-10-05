import { coordinateNativeRoots, type ProfileAdmission } from "@opencode-ai/core/kilocode/profile-maintenance"
import { ProfileWriterManifest } from "./writer-manifest"
import { isRetired } from "@opencode-ai/core/kilocode/source-launch"
import { covers } from "@opencode-ai/core/kilocode/source-policy"
import { assertRetirement } from "./source-host"
import { assertWorking, type Working } from "./profile-image"

type Root = ProfileAdmission["roots"][number]
const brand: unique symbol = Symbol("profile-capture")
export type Capability = Readonly<{ [brand]: true }>

const active = new WeakMap<object, { roots: readonly Root[]; verify?: () => void }>()

function key(root: Root) {
  return `${root.kind}:${process.platform === "win32" ? root.path.toLowerCase() : root.path}`
}

/** A serialized receipt, a cast, or an expired callback cannot authorize profile export. */
export function assertCapture(proof: unknown, roots: readonly Root[]): asserts proof is Capability {
  const selected = typeof proof === "object" && proof !== null ? active.get(proof) : undefined
  if (
    !selected ||
    roots.length !== selected.roots.length ||
    roots.some((root, index) => key(root) !== key(selected.roots[index]))
  )
    throw new Error("Profile capture authority is absent, expired or bound to different roots")
  selected.verify?.()
}

/** Authorize the typed payload reader from live retired-source and immutable image proofs.
 * This does not certify complete workspace artifacts, host preferences or migration acceptance.
 */
export async function withOfflineCapture<A>(
  source: object,
  image: Working,
  body: (proof: Capability, roots: readonly Root[]) => Promise<A>,
) {
  const closure = assertRetirement(source)
  if (closure.purpose !== "export" || !isRetired(closure.proof))
    throw new Error("Offline capture requires an authenticated retired export source")
  const staged = assertWorking(image)
  if (staged.original.some((root) => !covers(closure.policy, root.path)))
    throw new Error("Offline capture roots escape the retired producer policy")
  const proof = Object.freeze({ [brand]: true as const })
  const roots = Object.freeze(staged.roots.map((root) => Object.freeze({ ...root })))
  active.set(proof, {
    roots,
    verify: () => {
      assertRetirement(source)
      assertWorking(image)
    },
  })
  try {
    return await body(proof, roots)
  } finally {
    active.delete(proof)
  }
}

/** Complete writer and host coverage must be proven before native gates can authorize capture. */
export async function withCapture<A>(
  scope: readonly Root[],
  body: (proof: Capability, roots: readonly Root[]) => Promise<A>,
): Promise<A> {
  const roots = Object.freeze(scope.map((root) => Object.freeze({ ...root })))
  const manifest = ProfileWriterManifest.manifest
  if (!manifest.complete || manifest.gaps.length || manifest.writers.some((writer) => writer.coverage !== "integrated"))
    throw new Error("Portable capture requires complete integrated profile writer coverage")
  const { Daemon } = await import("../daemon/daemon")
  const closure = await Daemon.closeForCapture()
  if (!closure.completeProfileCoverage || !closure.portableCaptureAuthorized)
    throw new Error("Portable capture requires verified complete host retirement and root coverage")
  const declared = new Set(roots.map(key))
  if (closure.roots.some((root) => !declared.has(key(root))))
    throw new Error("Portable capture scope omits a historical host root")
  // Cooperative native gates add exclusion only after complete host/writer coverage is proven.
  return (
    await coordinateNativeRoots(roots, async (admission) => {
      const proof = Object.freeze({ [brand]: true as const })
      const held = Object.freeze(admission.roots.map((root) => Object.freeze({ ...root })))
      active.set(proof, { roots: held })
      try {
        return await body(proof, held)
      } finally {
        active.delete(proof)
      }
    })
  ).value
}
