# Directory acquisition experiment

ChatGPT, 2026-09-28 06:38 EDT (Toronto).

This is a private headless experiment, not production directory admission. It leaves the committed 37-case continuity fixture and all production helpers/contracts untouched. The new source is `packages/core/native/kilocode/directory-acquisition-fixture.cpp`; its focused test is `packages/core/test/kilocode/directory-acquisition-experiment.test.ts`. The fixture is not packaged.

## Measured result

MSVC `/std:c++20 /EHsc /O2 /Z7 /W4 /WX` compilation passed. The actual Windows fixture produced 28 native result rows; the focused Bun test passed 1 test and 51 assertions. The final measured fixture execution was approximately 114 ms; the test process completed in 1.43 seconds.

Both plain controls successfully acquired the physical leaf by a single name relative to an NtCreateFile parent handle and created an exact witness in that leaf. One control used OBJ_DONT_REPARSE; the other did not. The witness's NT physical path matched the retained leaf's path. Each witness was removed using its own DELETE-capable handle.

The explicit wrong-target case renamed the authorized leaf and created another directory at its old name before relative acquisition. The opened replacement did not match the saved volume/file identity. Admission refused before creating a witness; the replacement leaf and independent outside target remained empty.

For each of two deterministic races, the fixture acquired the expected leaf with real directory-read access and READ|WRITE sharing excluding DELETE. A worker thread then installed a junction through a preopened FILE_WRITE_ATTRIBUTES|FILE_READ_ATTRIBUTES handle. Unnamed begin/done events placed that successful mutation after leaf acquisition and before witness creation, without timing sleeps. The original leaf handle reported the reparse attribute after mutation.

Witness FILE_CREATE relative to that now-reparse leaf refused with Windows error **1921, ERROR_CANT_RESOLVE_FILENAME**, both with and without OBJ_DONT_REPARSE. Neither race created a witness. The independent outside target was enumerated before cleanup, remained empty, and retained its exact volume/file identity at the end. The test also accepts a future supported-host result that creates the witness only in the original physical leaf and then explicitly refuses reparse admission; it never accepts an outside witness effect.

An initial probe failed before either mutation because querying physical identity on a handle granted only FILE_WRITE_ATTRIBUTES was denied. The fixture added FILE_READ_ATTRIBUTES for that query. It grants no WRITE_DATA authority, and the refusal/outside-effect gates were unchanged. The measured passing result is from the corrected fixture.

## API contract and bounds

[NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile) documents Nt-created directory handles as RootDirectory and resolves the supplied name relative to them. The fixture uses one child component, FILE_OPEN for acquisition, FILE_CREATE for the new witness, synchronous nonalert I/O, and FILE_OPEN_REPARSE_POINT. Type-neutral directory opens are followed by directory, reparse and physical-identity checks; this avoids assuming compatibility of FILE_DIRECTORY_FILE with every desired option. Witness creation also specifies FILE_NON_DIRECTORY_FILE.

[OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes) describes OBJ_DONT_REPARSE, but that general wording alone is not proof of how an already-open RootDirectory handle behaves after its directory gains a reparse point. The two actual race variants measure that boundary on this installed Windows host. No fallback silently drops the tested options.

The fixture operates only beneath its empty, named disposable root, with the independently held outside target also inside that root. It launches no applications and uses no GUI, desktop capture or input. It has one worker thread at a time, a 3-second worker wait, a 4-second controller wait, fixed-size path/reparse buffers, and bounded directory enumeration. The Bun harness kills only its exact fixture child after 12 seconds, waits for its exit, validates the final absolute disposable path, and disposes that root. Reparse finalizers run after worker join and remove only junctions installed by the fixture before recursive disposal. Witness finalizers delete only the exact handles created by the fixture.

To reproduce, compile the new source to a private temporary executable and set its absolute path:

```powershell
$env:RAYA_ACQUISITION_EXPERIMENT = Join-Path $env:TEMP 'raya-directory-acquisition-fixture.exe'
bun test ./test/kilocode/directory-acquisition-experiment.test.ts
```

Run from `packages/core`. The test skips unless the fixture path is explicitly supplied. It prints only the two structural creation outcomes; it does not print paths, private contents, credentials or captured pixels.

## Remaining proof

This covers a single trusted parent, one child acquisition, exact wrong-ID replacement and a forced post-acquisition metadata reparse race. It does not prove full ancestor-chain acquisition under concurrent replacement, volume/DOS namespace continuity, every reparse tag or filesystem, prolonged resource bounds, suspended process creation/resume, witness recovery after helper/controller loss, descendant Job drainage, or restart. It is not a production directory fence and must not close the installed-host gate.

The next concrete experiment should acquire a multi-component chain one handle-relative component at a time while deterministic barriers replace an unacquired child or move it out of the chain. Require identity refusal before witness effects, then repeat metadata-reparse races at each already-acquired ancestor and verify zero effects in independently held alternative targets. Production integration still requires the stable-volume namespace and full Job/recovery matrix after those acquisition cases pass.
