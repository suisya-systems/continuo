# continuo

TypeScript port of [interlock](https://github.com/suisya-systems/interlock): a durable control
plane for a coding-agent organization, its measurement harness, and its per-role fencing.

The name is cadenza's structural counterpart. A basso continuo underpins the piece and realizes
chords from figures, as this control plane realizes behavior from policy rows and rules.

> **Status: porting, well advanced.** All 1,973 node ids not declined are ported. Every subsystem
> interlock's suite collects is now classified and no status is still a proposal: `broker`'s 54
> collected cases were the last, declined at continuo's own human gate on 2026-09-03
> (`DECISIONS.md` D-0053). The per-subsystem record is
> [`parity/source-inventory.belts.md`](./parity/source-inventory.belts.md) and is kept up to date
> per belt. Publication is decided (`DECISIONS.md` D-0045, which supersedes D-0008) and has not
> been carried out: `package.json` still carries `"private": true` at version `0.0.0`, and the
> package is not on the registry. D-0045 makes that a separate change -- drop `private`, set a real
> version, and give the release path the build step it names -- and that change has not landed.

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

### Depending on continuo

Once `@suisya-systems/continuo` is published, a consumer inherits two constraints the moment it
depends on it, neither visible from the dependency line ([`DECISIONS.md`](./DECISIONS.md) D-0045):

- **A native runtime dependency.** `better-sqlite3` is a native addon that ships its prebuilt binary
  in the npm tarball. Install with `--ignore-scripts` and run that binary, as D-0009 does here;
  installing without it puts npm back into the `node-gyp` build that D-0009 exists to keep off every
  platform.
- **A Node floor, with odd majors excluded.** `engines.node` is `>=22.14.0 <23 || >=24.0.0 <25`
  (D-0003), and the consumer inherits the whole range, not just the floor.

## Documentation

| Document | What it settles |
|---|---|
| [`DECISIONS.md`](./DECISIONS.md) | The append-only decision record |
| [`docs/testing.md`](./docs/testing.md) | How to run and write tests; the isolation contract |
| [`docs/ci-merge-gate.md`](./docs/ci-merge-gate.md) | The double-green rule and the fail-closed merge gate |
| [`docs/sqlite-value-contract.md`](./docs/sqlite-value-contract.md) | How SQLite values appear in JavaScript, and two silent hazards |
| [`docs/cli-output-policy.md`](./docs/cli-output-policy.md) | ASCII-only output, and why Windows is a required CI cell |
| [`docs/design/minimal-operating-loop.md`](./docs/design/minimal-operating-loop.md) | What the successor stack must still build to run one task end to end (propose-only) |
| [`AGENTS.md`](./AGENTS.md) | How work is done here: decisions, verification, records, issue and PR conventions |

## License

MIT. See [`LICENSE`](./LICENSE).
