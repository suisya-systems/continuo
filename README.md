# continuo

TypeScript port of [interlock](https://github.com/suisya-systems/interlock): a durable control
plane for a coding-agent organization, its measurement harness, and its per-role fencing.

The name is cadenza's structural counterpart. A basso continuo underpins the piece and realizes
chords from figures, as this control plane realizes behavior from policy rows and rules.

> **Status: porting, well advanced.** 1,973 node ids are ported, out of the 2,038 not declined --
> a pool, not a commitment: 65 of them (`broker`'s 54, `migrate`'s 11) carry statuses that are still
> proposals, undecided at continuo's own human gate rather than agreed to be ported. The per-subsystem record is
> [`parity/source-inventory.belts.md`](./parity/source-inventory.belts.md) and is kept up to date
> per belt. The package is `private` and is not published (`DECISIONS.md` D-0008).

## Design lineage

Interlock is the **design lineage of record**, and this port cites it rather than restating it.
**It is frozen, and it is not a decision-maker for continuo.** It is the source the port reads from
and the archive its reasoning is cited out of; it will not answer continuo's open questions, review
continuo's choices, or repair defects continuo inherits. Everything still undecided about continuo is
decided at *this* repository's human gate -- see `DECISIONS.md` `D-0023` (inherited defects are
repaired here) and `D-0036` (decision authority is here).

- [`DECISIONS.md`](https://github.com/suisya-systems/interlock/blob/main/DECISIONS.md) -- `D-0001`..`D-0042`
- [`docs/parity-audit.md`](https://github.com/suisya-systems/interlock/blob/main/docs/parity-audit.md)
- `investigation/`

Continuo's own decisions live in [`DECISIONS.md`](./DECISIONS.md) with a separate numbering space.
An entry there citing `interlock D-00NN` means the interlock decision of that number.

## How this port is being done

**Test-first.** The specification is interlock's test suite -- 2190 passed / 8 skipped / 1 xfailed
at interlock PR #72 -- not its Python source. Implementation follows the tests to green, module by
module. SQL carries verbatim: any dialect-forced deviation is a recorded decision, never a silent
edit.

**Green twice under random ordering.** Every required CI cell runs the suite twice, in two
independent processes, at two distinct explicit seeds. Both must pass.
See [`docs/ci-merge-gate.md`](./docs/ci-merge-gate.md) -- the definition is narrower than the phrase
suggests, deliberately.

## Getting started

```bash
npm ci --ignore-scripts
npm run verify          # lint + knip + typecheck + native-addon smoke + the suite
npm run check:package   # build, then publint + attw against the packed tarball
```

`--ignore-scripts` is deliberate: continuo runs better-sqlite3's prebuilt binary and never builds it
from source, so no C++ toolchain is needed on any platform ([`DECISIONS.md`](./DECISIONS.md) D-0009).

Requires Node 22 or 24 LTS (`>=22.14.0 <23 || >=24.0.0 <25`). The floor is not cosmetic: better-sqlite3 v13's prebuilt binary is
built at Node-API 10, which Node provides only from v22.14.0 onward
([`DECISIONS.md`](./DECISIONS.md) D-0003).

## Documentation

| Document | What it settles |
|---|---|
| [`DECISIONS.md`](./DECISIONS.md) | The append-only decision record |
| [`docs/testing.md`](./docs/testing.md) | How to run and write tests; the isolation contract |
| [`docs/ci-merge-gate.md`](./docs/ci-merge-gate.md) | The double-green rule and the fail-closed merge gate |
| [`docs/sqlite-value-contract.md`](./docs/sqlite-value-contract.md) | How SQLite values appear in JavaScript, and two silent hazards |
| [`docs/cli-output-policy.md`](./docs/cli-output-policy.md) | ASCII-only output, and why Windows is a required CI cell |

## License

MIT. See [`LICENSE`](./LICENSE).
