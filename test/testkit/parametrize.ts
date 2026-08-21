import { test } from "vitest";

/**
 * `@pytest.mark.parametrize`, with pytest's **node ids** preserved.
 *
 * The parity ledger maps one source node id to one target test id, and pytest's
 * node id for a parametrized case is `test_name[param]`. `test.each` names its
 * cases by interpolating the row into a title template, which produces ids that
 * depend on how the translator wrote the template -- so two faithful
 * translations of the same case can carry different target ids, and the ledger
 * then cannot tell a renamed case from a missing one.
 *
 * {@link parametrize} takes the id **explicitly**, exactly as pytest printed
 * it, and produces `name[id]`. That makes the target id a byte-stable function
 * of the source id, which is what the ledger check compares.
 *
 * Stacked `parametrize` decorators form a cartesian product in pytest, and the
 * id is the parameters joined with `-` in decorator order (bottom-up). Build
 * the product explicitly with {@link product} rather than nesting calls, so the
 * expansion is visible in the source at the same place the ledger sees it.
 */
export function parametrize<T>(
  name: string,
  cases: readonly (readonly [id: string, value: T])[],
  body: (value: T) => void | Promise<void>,
): void {
  for (const [id, value] of cases) {
    test(`${name}[${id}]`, async () => {
      await body(value);
    });
  }
}

/**
 * The cartesian product of two parametrize axes, with pytest's id joining.
 *
 * pytest's id for stacked decorators is the axes joined by `-`, with the
 * *closest* decorator to the function varying fastest. `outer` here is the
 * decorator further from the function, so the emitted order matches what
 * `pytest --collect-only` prints.
 */
export function product<A, B>(
  outer: readonly (readonly [id: string, value: A])[],
  inner: readonly (readonly [id: string, value: B])[],
): (readonly [id: string, value: readonly [A, B]])[] {
  const rows: (readonly [id: string, value: readonly [A, B]])[] = [];
  for (const [outerId, outerValue] of outer) {
    for (const [innerId, innerValue] of inner) {
      rows.push([`${innerId}-${outerId}`, [outerValue, innerValue] as const] as const);
    }
  }
  return rows;
}
