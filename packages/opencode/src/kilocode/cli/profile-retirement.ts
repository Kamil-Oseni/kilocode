import { coordinateNativeRoots, type ProfileAdmission } from "@opencode-ai/core/kilocode/profile-maintenance"
import { ProfileRoots } from "@opencode-ai/core/kilocode/profile-roots"
import path from "node:path"
import { createHash } from "node:crypto"
import { ProfileParticipants } from "./profile-participants"

function roots(): ReturnType<typeof ProfileRoots.snapshot> {
  const selected = [...ProfileRoots.snapshot(), ...ProfileParticipants.snapshot().flatMap((item) => item.receipt.roots)]
  const unique = new Map(
    selected.map((root) => [
      `${root.kind}:${process.platform === "win32" ? root.path.toLowerCase() : root.path}`,
      Object.freeze({ kind: root.kind, path: root.path }),
    ]),
  )
  return Object.freeze([...unique.keys()].sort().map((key) => unique.get(key)!))
}

/** A metadata checksum only; it grants no maintenance or filesystem identity authority. */
export function fingerprint(roots: readonly { kind: "sqlite" | "json"; path: string }[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        roots.map((root) => ({
          kind: root.kind,
          path: process.platform === "win32" ? root.path.toLowerCase() : root.path,
        })),
      ),
    )
    .digest("hex")
}

/** Historical process-local metadata, without claiming that other profile participants have stopped. */
export function observation() {
  const selected = roots()
  return Object.freeze({
    format: "raya.profile-root-observation",
    version: 1,
    roots: selected,
    inventory: fingerprint(selected),
    observation: selected.length ? "participating-roots" : "no-participating-roots",
    processLocal: true,
    participantOnly: true,
    cooperativeOnly: true,
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
    portable: false,
  } as const)
}

/** Observe only roots admitted in this process; this never discovers a complete profile. */
export async function collect(observe?: (admission: ProfileAdmission) => Promise<void>) {
  const selected = roots()
  if (selected.length === 0)
    return Object.freeze({
      format: "raya.profile-root-observation",
      version: 1,
      roots: selected,
      observation: "no-participating-roots",
      participantOnly: true,
      cooperativeOnly: true,
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
      portable: false,
    } as const)
  const result = await coordinateNativeRoots(selected, async (admission) => {
    const key = (root: { kind: string; path: string }) => {
      const file = path.normalize(root.path)
      return `${root.kind}:${process.platform === "win32" ? file.toLowerCase() : file}`
    }
    const expected = new Set(selected.map(key))
    if (admission.roots.length !== expected.size || admission.roots.some((root) => !expected.has(key(root))))
      throw new Error("Historical participating-root identity changed before retirement observation")
    await observe?.(admission)
  })
  return result.admission
}
