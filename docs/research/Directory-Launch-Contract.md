# Directory launch contract requirements

ChatGPT, 2026-09-28 06:46 EDT (Toronto).

This records the production integration requirements while the private full-chain and launch-namespace experiments run. It is not an implemented contract or evidence of a production fence. The current installed runtime is `a7a33998a7`; native process lifecycle and actor storage remain version 1.

## Current boundary

The CLI lifecycle adapter owns the immutable session/workspace reservation and checks physical owner/root/cwd identities before dispatch and admission. Core `NativePty` starts the native helper, waits for the suspended child identity, asks the adapter to admit it, then publishes the exact resume record. The helper owns the Job and confirms drainage. The version-one launch envelope carries only command, cwd, arguments and deadline; it receives no physical directory-chain proof. `CreateProcessW` resolves its cwd pathname after the asynchronous adapter checks. Those checks alone do not close the native race.

The version-one owner record uses filesystem `real`, `dev` and `ino` values. Native experiments use Windows volume serial and file-index identities. Their representation and equivalence must be measured before an adapter compares or transforms them; do not silently treat equal-looking decimal strings as a proved binding. A new native capture may instead supply an explicitly typed private physical identity alongside the existing recovery record.

The full-chain fixture now measures equal Bun/native device and inode strings on this host, alongside 137 native outcomes/194 assertions. That is an interop baseline, not a portable persisted identity contract. Its trusted anchor is a disposable TEMP root, not the real volume/profile acquisition boundary.

The lifetime audit found an independent production defect: assigned launch exceptions previously closed the Job without observing empty membership. The correction explicitly terminates the Job, queries actual drainage within the existing stop bound, and publishes an `unknown` exit outcome. Real malformed-admission and receipt-publication adverse tests pass, as does the full native PTY launch suite (14 tests/66 assertions). This corrects ordinary exception handling; forced helper death still bypasses its C++ cleanup. Closing a kill-on-close Job is not itself proof that every descendant has finished exiting before directory pins disappear. A surviving keeper must explicitly terminate and observe drainage, and forced keeper death remains a separate adverse boundary.

## Required new launch capability

- Negotiate an explicit new capability and envelope version. Do not reinterpret version-one bytes or silently downgrade after a refused or unavailable protected launch. Keep old records readable for exact cancellation/drainage/recovery, without replaying them as new work.
- Bind bounded owner/root/cwd component chains to a retained volume anchor. Every edge has one validated child name and an expected physical identity/type. Shared prefixes may reuse the same retained handle, but each authorized branch must still be verified.
- Acquire each component relative to its retained parent, refuse changed identities/reparse points/unsupported namespace or access, and retain real directory-read handles with delete exclusion. A parent edge is incomplete until its expected child is pinned. No witness is created in a system/profile ancestor; its retained child supplies nonempty continuity.
- If a leaf needs an ephemeral guard witness, create it relative to the exact authorized leaf and recheck directory identity/reparse state. The witness is internal metadata, not a grant for model file edits. Its unique private name, non-inheritance, cleanup and interruption behavior must be tested; it must not prevent ordinary child operations or leak into model context.
- Resolve executable and cwd using the proved stable namespace, and verify their actual suspended-child binding before resume. Retained directory handles do not freeze a later DOS pathname. A second mutable-path check is insufficient; the namespace itself must be protected or avoided by a tested launch path.
- Bind the private proof digest to the token, helper birth, suspended child identity and exact granted chains. The adapter must acknowledge that proof before exact resume publication. The native resume boundary independently refuses missing, changed, expired or incompatible proof.
- Keep protection through descendant Job drainage. Test controller loss, helper loss, forced interruption, cleanup acknowledgement loss and restart, including the interval between termination and actual process exit. Handle-close assumptions alone are not lifetime proof.
- Preserve confirmed/refused/cancelled/unknown distinctions. An absent response never permits replay of CreateProcess or ResumeThread. Recovery reconciles the original identity and retained durable receipt; it never manufactures a new launch.

## Acceptance and integration order

The private lifetime experiment now supplies a counterexample to keeper-only ownership: forced keeper death permits directory rename/replacement while a held exact descendant process handle is still unsignalled. Its five cases/49 assertions include passing keeper-survival drainage controls, but the forced-death `liveMutation=1` rejects that candidate for the complete contract. Separately, all eight suspended-child cwd probes in the namespace experiment observe a null handle and refuse duplication (6). Neither an unsupported PEB layout nor successful CreateProcess acceptance supplies the required child binding. These are concrete unresolved design boundaries, not permission to downgrade the contract.

First run the full-chain fixture with deterministic substitutions/reparse attempts at each acquisition edge, independent alternative-target checks and ordinary-child-operation controls. Separately demonstrate the mutable-namespace hazard and prove the proposed cwd/image namespace using real suspended children. Then implement the new capability in Kilo-owned core/native and CLI boundaries, add actual Job-lifetime and fresh-backend recovery coverage, and update the snapshot with exact installed hashes. SDK regeneration is needed only if a server endpoint contract changes.

Bound packet sizes, chain depth/count, native handles, output, deadlines and registry use explicitly. Keep private paths, proof data, environment secrets and guard metadata out of model output and telemetry. The real installed-host workflow/restart/backend-loss/manual-takeover/changed-target/sensitive-denial/resource matrix remains a separate release gate. None of these experiments can mark EN-05/FUT-CU-01 or the full goal Verified.
