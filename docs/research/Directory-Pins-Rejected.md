# Directory pin experiment

ChatGPT 2026-09-28 04:54 EDT

The rejected implementation is preserved in `directory-pins-rejected.patch.gz`; decompress it before using git apply. It is not active production code. Its reverse application was checked against the exact experiment, then its forward application was checked against the restored source. Compression was round-trip checked against the original patch bytes. Existing actor storage and native launch protocols remain unchanged.

The experiment attempted to close the gap between TypeScript directory identity checks and native suspended-process resume by holding root-to-leaf non-inheritable handles throughout Windows Job membership. Real Windows tests show a tradeoff that makes this implementation unsuitable:

- Attribute-only handles do not enforce the required sharing exclusions: ancestor rename and preopened write/delete handles were admitted.
- Adding `FILE_LIST_DIRECTORY` with only `FILE_SHARE_READ` correctly refuses preopened mutators and all four protected-directory rename attempts.
- The stronger handles permit fresh child/sibling file creation, but ordinary child-file rename fails with `EBUSY`. Native `MoveFileExW` also fails with Windows error 32, with or without write-through; a direct absolute `FileRenameInfo` probe fails with the same sharing violation.
- Moving test receipts outside the protected directory lets suspended launch reach its receipt, but does not fix ordinary workspace file rename. Receipt placement therefore cannot resolve the product limitation.

Initial full run: 6 pass, 4 fail, 34 assertions. Stronger-handle full run: 6 pass, 4 fail, 28 assertions. The final isolated golden reaches 11 assertions and fails on ordinary file rename. Native builds use /W4 /WX; compilation and self-tests pass, but those checks do not override failed behavior. Scoped TypeScript checks, untyped lint and formatting pass. Existing core PTY regressions were not run against the rejected integration. Exact target/helper exits and descendant lifetime were verified in their actual process cases; all known fixture handles, processes, junctions and disposable roots were cleaned. No desktop interaction occurred.

Next investigate an atomic namespace-continuity mechanism that allows ordinary child operations while fencing directory rename and reparse changes before resume. Directory oplocks are only a candidate, not a proven solution. Require primary API documentation and actual adverse tests for break/ack timing, preopened mutation handles, ordinary file rename/delete, nested-directory creation, Job drainage, and controller/helper loss. Never silently downgrade the protection or publish this patch as verified. The final native directory race remains open.
