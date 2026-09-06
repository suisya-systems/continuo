/**
 * The names of the delivery lease resources, and the one way to build them.
 *
 * Ported from nothing: this module is target-only, added by `D-1104`. It lives
 * in `control_plane/` rather than beside the endpoint because two unfenced
 * outbox producers (`gates.enqueueRelay`, `events.fanOut`) have to name a
 * resource on every insert, and neither may import the messagebus.
 *
 * **What the name is.** Not a scope tag, not a partition id: the exact lease
 * resource string a row's `writer_epoch` was minted by. An outbox row records
 * only the third element of the fence triple `(resource, holder, epoch)`, and
 * `D-0074`'s failure is that with two live resources the fence proves the
 * writer's own lease is live while the row predicate proves the row carries
 * *a* number -- two answers to different questions, composing into nothing.
 * The honest repair is to store the missing element, so the column holds the
 * resource itself and nothing has to map a shorter tag back to it.
 *
 * **One-way, on purpose.** {@link deliveryResourceForRun} builds a resource
 * from a run id; nothing parses one back into a run id. `outbox.run_id` is
 * already the join, and a second decoder is a second thing to disagree with
 * the first. {@link isDeliveryResource} therefore answers a question about
 * *shape* -- is this a name this deployment admits -- and never hands back the
 * run it was built from.
 */

/**
 * The global delivery resource: the name every row belonging to no run is
 * written under, and the name every row written before `0005` carries.
 *
 * Before `D-1104` this was the *only* admissible delivery resource, and the
 * endpoint refused any other at startup (`D-0053` rule 4). It is now the
 * global partition rather than the whole world: legacy rows, runless event
 * fan-out and runless gate relays live here, and the operator's `gate` verbs
 * are their delivery authority (`D-1104`).
 */
export const DELIVERY_LEASE_RESOURCE = "outbox-delivery";

/**
 * The prefix a run-scoped delivery resource begins with.
 *
 * Exported so the refusals can quote the shape they admit without respelling
 * it, and so `isDeliveryResource` and `deliveryResourceForRun` cannot drift.
 */
export const DELIVERY_LEASE_RUN_PREFIX = `${DELIVERY_LEASE_RESOURCE}:run:`;

/**
 * The delivery resource governing *runId*'s rows, or the global one when the
 * row belongs to no run.
 *
 * Total on `string | null` deliberately: `openGate` defaults `runId` to null
 * and `gate.run_id` carries no `NOT NULL`, so a runless gate relay is an
 * ordinary input rather than a hypothetical, and both unfenced producers call
 * this without a branch of their own. A null run takes the global literal,
 * which is the resource the operator's verbs already drain.
 *
 * **This is not the rule for a fenced producer.** `Outbox.enqueue` stamps
 * `writer_epoch` from its own live lease and its `runId` defaults to null, so
 * a fenced row takes its resource from the enqueuing instance and never from
 * `run_id` -- otherwise a runless fenced send would pair a per-run epoch with
 * the global resource and rebuild the ambiguity this column removes
 * (`D-1104`; design section 4.0).
 */
export function deliveryResourceForRun(runId: string | null): string {
  if (runId === null || runId === "") {
    return DELIVERY_LEASE_RESOURCE;
  }
  return `${DELIVERY_LEASE_RUN_PREFIX}${runId}`;
}

/**
 * Whether *value* is a delivery resource name this deployment admits.
 *
 * The startup admission the endpoint and the materialiser share. It widens
 * `D-0053` rule 4's equality against one literal to "the global literal, or a
 * well-formed run resource", and nothing more: an operator still cannot spell
 * an arbitrary lease resource into `INTERLOCK_MESSAGEBUS_RESOURCE`, which is
 * the mistake `D-0076` records for `--recipient`.
 *
 * Shape only. A true answer does not say which run the name was built for --
 * see the module docstring on why nothing decodes one.
 */
export function isDeliveryResource(value: string): boolean {
  if (value === DELIVERY_LEASE_RESOURCE) {
    return true;
  }
  if (!value.startsWith(DELIVERY_LEASE_RUN_PREFIX)) {
    return false;
  }
  const remainder = value.slice(DELIVERY_LEASE_RUN_PREFIX.length);
  // `acquire` admits any non-blank string as a resource (`requireIdentifier`),
  // so a blank remainder would acquire a lease named by a prefix and nothing
  // else -- a name two different runless callers could both believe was
  // theirs. Refused here rather than tolerated there.
  return remainder.trim() !== "";
}

/**
 * The admitted shapes, spelled once for every refusal that has to name them.
 *
 * A refusal that described the shape in its own words would be a second
 * spelling of `isDeliveryResource`, free to say something the predicate does
 * not do.
 */
export const DELIVERY_RESOURCE_SHAPES = `${DELIVERY_LEASE_RESOURCE} or ${DELIVERY_LEASE_RUN_PREFIX}<run id>`;
