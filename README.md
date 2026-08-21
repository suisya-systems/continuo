# continuo

TypeScript port of [interlock](https://github.com/suisya-systems/interlock): a durable control
plane for a coding-agent organization, its measurement harness, and its per-role fencing.

The name is cadenza's structural counterpart. A basso continuo underpins the piece and realizes
chords from figures, as this control plane realizes behavior from policy rows and rules.

> **Status: bootstrap.** The repository skeleton, the CI discipline, and the first recorded
> decisions are in place. No interlock module has been ported yet. The package is `private` and is
> not published (`DECISIONS.md` D-0008).

## Design lineage

Interlock is the **design lineage of record**, and this port cites it rather than restating it:

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
npm ci
npm run verify   # typecheck + native-addon smoke + the suite
```

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
