# Durable draft retention implementation

ChatGPT 2026-09-30 08:28 EDT. Source audit and implementation plan; no SQL retention migration has been implemented or accepted.

The current profile-wide JSON catalog retains up to 128 identities. Starting empty, 64 new chats with a unique pending draft, promotion and accepted-message clear retain 128 records. The 65th pending draft cannot save. Other panes reduce that allowance. Repeated messages in one existing session reuse its identity. Capacity refusal preserves existing data, but this is an unfinished requirement for sustained daily use.

Ship and verify the current composer checkpoint first, then remove this fixed history-count limitation while preserving restart-safe conflict protection. Never evict a tombstone, hide an unsaved record, or raise the entry limit as a substitute for durable identity tracking.

## Concrete source boundaries

| Boundary | Implementation |
|---|---|
| Schema | Add `packages/core/src/kilocode/composer.sql.ts`. The existing schema glob discovers Kilo-owned `*.sql.ts` files. Retain canonical identity, current generation/revision, mutation, digest and last request receipt even when content is cleared. |
| Generated migration | Run `bun script/migration.ts --name kilocode-composer-drafts` from `packages/core`. The existing generator updates `schema.json`, fresh schema, migration registry and annotated migration source. Do not create tables ad hoc in HTTP handlers. |
| Repository | Add an Effect-native repository under `packages/opencode/src/kilocode/session`. Use `Database.Interface.db.transaction(callback, { behavior: "immediate" })` for CAS, both promotion legs and quota accounting. |
| Service injection | `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts` already obtains `Database.Service`. Inject that service into composer handlers and preserve the public token/replay contract. |
| Transaction precedent | `packages/opencode/src/kilocode/task/archive.ts` shows an atomic row/import-marker transaction and indexed keyset pagination. The Effect SQLite session implementation reserves a connection and provides rollback/savepoints. |
| Discovery | Add bounded keyset pagination to the scoped HTTP catalog, regenerate the SDK, and update host/UI consumers to retrieve every page without losing pending identities. |

Store cleared content as null while retaining compact identity and receipt metadata. Index workspace/project/box and stable catalog order. Charge live content and metadata bytes transactionally; quota refusal must preserve existing drafts and provide truthful recovery. Undefined-CAS creation must check historical identity membership as well as active rows.

## Crash-safe cutover

JSON publication and SQL commit are separate stores. An SQL import marker alone cannot fence the existing JSON writers.

1. Hold the existing canonical composer Flock and validate the v1 document and initialization marker. Preserve the original bytes as private recovery evidence.
2. Import records, digest and a pending cutover phase in one immediate SQL transaction. Refuse new SQL mutations while cutover is pending.
3. Retire the original JSON document with a non-v1 sentinel. Supported old composer readers then refuse rather than writing stale state. Verify the sentinel before opening SQL mutations.
4. Resume an interrupted cutover only when retained source evidence matches. If another writer changed the source, retain both versions and refuse automatic selection or overwrite.

Keep JSON file operations outside SQL transactions. The journal coordinates recovery; it does not make the two stores atomic. Unknown older binaries or direct file writers still need independent outer ownership/refusal evidence. Full portable capture remains refused until its complete writer coverage is proven.

## Required acceptance

Use actual disk-backed `Database.layerFromPath`, production Storage and independent process fixtures. Verify hundreds of accepted new-chat cycles followed by another new draft; stale undefined-CAS and generation/revision writes after clear, archival, restart and migration; exact lost-acknowledgement replay; both promotion legs under concurrent processes; interrupted migration at each publication boundary; conflicting source evidence; complete paginated discovery; and quota refusal without loss. Prove migration idempotency, private recovery evidence and owned child termination.

Run relevant Core/CLI typing, migrations/annotation/Promise-facade checks, SDK generation, extension/webview checks and browser regressions. Build a matching snapshot and repeat installed restart/migration acceptance. Source tests alone do not prove installed or new-PC acceptance.
