## Type

<!-- Keep one: correctness | performance | vocabulary | reachability | docs | discussed-first (link the issue) -->

## Change

Describe the observable behavior changed and the narrow reason for the change.

## Reproduction

Give the smallest command, input, or fixture that demonstrates the behavior before and
after.

## Gate evidence

- [ ] `./tests/run.ps1 quick`
- [ ] `./tests/run.ps1 correctness`
- [ ] `./tests/run.ps1 release`
- [ ] `./tests/run.ps1 mutation`
- [ ] `npm.cmd --prefix benches run benchmark:smoke`
- [ ] Every unchecked command has a reason below.

Results and justified omissions:

## Correctness receipt

<!-- Required when the change can touch token output: correctness profile result, plus
byte-for-byte agreement against the pinned reference for every affected vocabulary.
Write "not applicable" with one line of reasoning otherwise. -->

## Performance receipt

<!-- Required for performance changes: the smoke run plus a focused before/after of the
touched path, measured through the packaged public runtime, with configuration and
commit. Full composed adjudication runs on our side before merge. Write "not
applicable" otherwise. -->

## Contract checks

- [ ] The diff is minimal: no reformatting, no unrelated changes.
- [ ] Tests assert behavior, refusal, compatibility, or graph safety.
- [ ] New assumptions have a negative test.
- [ ] Affected verifiers turn red for a behavioral fault and return green after restoration.
- [ ] Attribution and source notices remain attached to imported work.
- [ ] The change does not publish packages, file upstream issues, or create a release.
- [ ] I can explain and defend every line of this change during review.

## Notes

<!-- Optional. If you want to note what you did versus what your tools did, we
appreciate it here. It is not required. -->
