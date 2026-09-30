import "../../../opencode/test/preload"
export async function draftStorage(opts: { workspace?: () => string; projectID?: () => string } = {}) {
  // Dynamic sequencing is intentional: Bun can evaluate a static re-export's
  // Global dependency before an async preload has established isolated paths.
  await import("../../../opencode/test/preload")
  const fixture = await import("../../../opencode/test/kilocode/composer-draft-fixture")
  return fixture.draftStorage(opts)
}
