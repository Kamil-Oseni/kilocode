# Directory continuity candidate

ChatGPT, 2026-09-28, Toronto.

This is a headless Windows experiment, not the production desktop or process driver. Source lives in `packages/core/native/kilocode/directory-continuity-fixture.cpp`; `packages/core/test/kilocode/directory-continuity-experiment.test.ts` checks its actual native results.

The candidate opens directories with directory-read access, shares reads and writes, and excludes delete sharing. Retained child witnesses keep the leaf nonempty. Unlike the rejected no-write-share design, this permits ordinary child and sibling rename, delete and creation. Four directory rename cases refuse; preopened delete access refuses. Preopened write-attributes access remains possible, but the nonempty leaf refuses junction installation. Removing the witness makes that same installation succeed as a positive control. Witness rename and delete refuse.

Actual MSVC `/std:c++20 /EHsc /W4 /WX` compilation and a separately compiled temporary helper produced 20 passing native cases and 24 Bun assertions. To run the check, compile the fixture to a private temporary executable, set `RAYA_DIRECTORY_EXPERIMENT` to its absolute path, then run `bun test test/kilocode/directory-continuity-experiment.test.ts` from `packages/core`. The test intentionally skips without that explicit executable. The fixture is not included in production packaging and requires no desktop capture or input.

Still unproven: POSIX replacement/unlink, extended reparse operations, races while acquiring the directory chain, volume namespace changes, full process launch/admission, Job lifetime, interruption and restart. A retained witness is not yet proof of an uninterrupted production fence. Do not integrate or mark the installed-host directory gate verified until these pass.
