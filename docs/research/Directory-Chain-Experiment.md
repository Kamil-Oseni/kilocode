# Directory chain acquisition experiment

Author: ChatGPT. Measured on September 28, 2026, 06:55 EDT (America/Toronto).

This private headless experiment extends the single-edge [acquisition experiment](Directory-Acquisition-Experiment.md). It does not implement a production directory fence or permit suspended-process admission. Existing production code and previous experiments are unchanged.

## Measured result

MSVC `/std:c++20 /EHsc /O2 /Z7 /W4 /WX` compiled the private fixture without warnings. The final focused Bun test passed: **1 test, 137 native rows, 194 assertions**, 92.83 ms fixture time and 845 ms suite time. Scoped untyped Oxlint reported zero warnings/errors; Prettier and `git diff --check` passed. The independent alternative directory remained empty, and its originally captured volume/file identity was unchanged. The whole fixture stayed inside a newly created disposable TEMP directory.

| Case | Observed result |
|---|---|
| Healthy three-edge chain | Each component acquired relative to its retained parent, matched the expected physical identity, and passed directory/non-reparse checks. |
| Replacement before acquisition, at each of three depths | Actual rename and same-name replacement succeeded; acquisition opened a different physical identity and refused before creating a witness. Replacement directories remained empty. |
| Acquired parent with unacquired child, at two depths | Moving the unacquired child out made the acquired parent empty. The preopened metadata handle successfully installed a junction. The next acquisition refused; no alternative-target effects occurred. |
| Parent after expected child was pinned, at two depths | Both ordinary and extended reparse installation were refused with `ERROR_DIR_NOT_EMPTY` (145). |
| Empty leaf after all three directory handles were retained | Metadata-only mutator successfully installed a junction. Relative witness creation refused with `ERROR_CANT_RESOLVE_FILENAME` (1921); admission remained refused and alternative target stayed empty. |
| Leaf with retained witness | Both ordinary and extended reparse installation refused with error 145. |
| Same metadata handle after witness removal | Extended installation succeeded, the retained leaf handle observed the reparse attribute, and exact-handle reparse cleanup succeeded. This positive control proves the extended call was operative. |
| Shared ancestor with a second leaf branch | Relative acquisition matched its expected identity and created a witness in that physical branch. |
| Ordinary children while complete pins and witness remained | File create/write, rename, delete and nested-directory create/delete succeeded at all three depths and on the additional branch. |
| Pinned component rename | All three chain components refused rename with `ERROR_SHARING_VIOLATION` (32), while normal child operations remained usable. |
| Bun/native identity interop baseline | This host's `stat({ bigint: true })` device string equalled the native volume serial; inode string equalled the native 64-bit file index. No mismatch coercion or conversion was performed. |

The interop result is a host observation. It does not establish a durable identity format across platforms, filesystems, API versions, reboots, or stored grants. The test reports equality without requiring it as a portable admission rule.

## Acquisition and adverse setup

The already trusted disposable root is opened once. Authorization snapshots retain expected volume serial and 64-bit file index for each existing component. Snapshots close before adverse replacements. Each acquisition uses one fixed component name with `NtCreateFile` `RootDirectory`, `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE`, READ/WRITE sharing but no DELETE sharing, final-component no-follow and synchronous completion. Type-neutral opens are followed by directory, reparse and exact expected-ID checks.

An acquired parent is incomplete until its expected child has been acquired and retained. A retained child then provides the parent's nonempty condition; no witness is created in ancestor directories. Only the authorized terminal leaf gets a unique `FILE_CREATE` witness with an exact retained handle. The leaf's identity/reparse state is checked again before admission. The additional branch shares the first retained ancestor and gets its own terminal witness.

Each deliberate mutation runs in one worker behind unnamed begin/done events. The main thread reaches the specified acquisition boundary before releasing the worker and waits for mutation completion before the next operation. Worker wait is bounded at three seconds, controller wait at four seconds, and the worker joins before resources are restored or disposed. The incomplete-parent cases hold a preopened `FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES` handle; they do not acquire `FILE_WRITE_DATA`.

For every reparse race, the independently held alternative target is inspected before witness or reparse cleanup can hide an escape. A created witness must have the original physical leaf path; any reparse state causes explicit refusal. On this host the raced leaf refused witness creation, so the safe-original-witness branch was not exercised. Unexpected successful reparse calls are reported as failed refusal controls, inspected before exact-handle restoration, and removed before ordinary pathname controls continue.

One initial compile failed on two local shadowing warnings; names were corrected without lowering `/W4 /WX`. The first actual run exposed an invalid adverse setup: a preopened leaf metadata handle prevented ancestor replacement. Replacement cases now hold no metadata mutator. Actual replacement success is mandatory, followed by mandatory physical-ID mismatch. No expected outcome was weakened to accept that setup failure.

## Scope and cleanup

The new files are `packages/core/native/kilocode/directory-chain-fixture.cpp` and `packages/core/test/kilocode/directory-chain-experiment.test.ts`. Neither fixture is packaged. The test is opt-in with `RAYA_CHAIN_EXPERIMENT` pointing to the separately compiled absolute executable; otherwise it skips.

The fixture has three fixed chain edges, nine fixed cases, bounded path/reparse buffers, at most 32 enumerated entries per emptiness check, one mutation worker at a time and structural output only. The test limits execution to 12 seconds, waits for the exact child to exit, requires 137 unique rows and output smaller than 32 KiB, and validates the resolved TEMP parent and experiment-name prefix before recursive disposal. Witnesses are removed using their own DELETE-authorized handles. Fixture-created junctions are removed using their retained mutator handles before recursive disposal. No worker process or GUI is launched. No user directory, desktop surface, or French Study file is accessed.

## Remaining production gaps

This is a complete chain below one trusted disposable anchor, not a proof from volume root through real system/profile ancestors. Those ancestors may deny directory-read access. Any production design must refuse rather than downgrade to attribute-only handles, and must establish its initial anchor and expected identities safely.

The test does not prove DOS-device/volume namespace continuity during later pathname resolution, `CreateProcess` current-directory or executable binding, suspended-process admission/resume, ACL-denial behavior, all reparse tags, POSIX replacement semantics for the full chain, arbitrary filesystem behavior, prolonged resource bounds, or helper/controller loss. In particular, helper-owned handles disappear when that helper is forcibly terminated; retaining pins through Job drainage needs an independent lifetime proof. No restart, retry, recovery or descendant-containment gate is discharged by this experiment.

Production integration still requires an explicit versioned acquisition/launch contract, measured stable launch namespace, exact physical identity binding, private pin ownership through complete Job drainage, bounded cleanup, explicit acknowledgements and refusal on unknown outcomes. Persisted handles or automatic replay must not be invented from these results.

## API references

- [Microsoft NtCreateFile contract](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile): handle-relative names, sharing, create disposition and options.
- [Microsoft reparse installation processing](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4aeefef8-92c3-4abc-af7a-a610caf8a165): metadata access and nonempty-directory refusal.
- [Microsoft extended reparse operation](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/fsctl-set-reparse-point-ex) and [packet layout](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer_ex).
- [Microsoft CreateProcess contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa): launch still accepts a current-directory pathname rather than a directory handle.
