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
 * The cartesian product of two parametrize axes, in pytest's collection order.
 *
 * Measured against pytest 9.1.1 rather than reasoned about, because the two
 * halves of the rule pull in opposite directions and it is easy to state one
 * and implement the other. For
 *
 * ```python
 * @pytest.mark.parametrize("outer", ["o1", "o2", "o3"])   # further from the function
 * @pytest.mark.parametrize("inner", ["i1", "i2"])         # closest to the function
 * def test_stacked(outer, inner): ...
 * ```
 *
 * `pytest --collect-only` prints, in this order:
 *
 * ```
 * test_stacked[i1-o1]  test_stacked[i1-o2]  test_stacked[i1-o3]
 * test_stacked[i2-o1]  test_stacked[i2-o2]  test_stacked[i2-o3]
 * ```
 *
 * So the **id** puts the decorator closest to the function first (`inner-outer`),
 * while the axis that varies **fastest** is the outer one. `inner` is therefore
 * the outer loop here and `outer` the inner loop -- which reads backwards, and
 * is what the printed order requires.
 *
 * Order matters even though the runner shuffles: the ledger is written and
 * reviewed against `pytest --collect-only` output, and a product listed in a
 * different order makes a human reconciling the two conclude the wrong thing
 * about which case is missing.
 */
export function product<A, B>(
  outer: readonly (readonly [id: string, value: A])[],
  inner: readonly (readonly [id: string, value: B])[],
): (readonly [id: string, value: readonly [A, B]])[] {
  const rows: (readonly [id: string, value: readonly [A, B]])[] = [];
  for (const [innerId, innerValue] of inner) {
    for (const [outerId, outerValue] of outer) {
      rows.push([`${innerId}-${outerId}`, [outerValue, innerValue] as const] as const);
    }
  }
  return rows;
}
