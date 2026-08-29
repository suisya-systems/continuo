/**
 * S8 -- the `MessageBus`: worker-outbound delivery, with no session edge.
 *
 * **Spike scaffold, throwaway by default (interlock D-0026).** The durable half
 * of interlock Issue `#19` is the suite under `test/messagebus/` and the static
 * no-edge assertion; nothing in this package is promoted by being imported.
 *
 * Ported from interlock `src/claude_org_runtime/messagebus/__init__.py` at
 * `65f36c5`.
 *
 * This package is the delivery half of interlock D-0009's two-contract split.
 * The other half, `src/session/`, manages sessions and deliberately carries
 * **no delivery verb** (see `DELIVERY_ABSENCE_IS_DELIBERATE` there). The
 * mirror-image property holds here and is enforced structurally: **no module in
 * this package imports** `src/session/` **or any session backend** --
 * `test/messagebus/import-graph.test.ts` fails the build the day such an edge
 * appears (interlock gate item 6's static assertion, paired with item 11's).
 *
 * Per interlock's F1 there is no non-interactive way to push a message *into* a
 * running worker session, so the transport is **worker-outbound**: the worker
 * connects to `./endpoint.js` as an MCP client and pulls. Delivery decisions --
 * what is due, what resends, what is settled -- derive from SQLite alone
 * ({@link Outbox.due}), never from a session readout, which is what item 6 asks
 * and what the missing import edge makes structural rather than disciplinary.
 *
 * The barrel names the bus and its envelope only. The endpoint is a process
 * (`node dist/messagebus/endpoint.js`), reached by path the way the deny hook
 * is, and its `Endpoint` / `EndpointConfig` are the transport's own vocabulary
 * rather than a delivery surface a consumer of this package would call.
 */

export {
  DeliveredEnvelope,
  type DeliveredEnvelopeFields,
  MessageBus,
  type MessageBusOptions,
  MessageBusUsageError,
  type PollOptions,
} from "./bus.js";
