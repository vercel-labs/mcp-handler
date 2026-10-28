# Experimental MCP Events

`experimental_registerMcpEvents` adds the webhook control methods from the
[MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md)
to an existing MCP handler. The proposal is experimental; this API may change
alongside it.

```typescript
import {
  createMcpHandler,
  experimental_registerMcpEvents,
  withMcpAuth,
  type ExperimentalMcpEventDefinition,
} from "mcp-handler";
import { z } from "zod";
import {
  subscriptionStore,
  durableWebhookDelivery,
  principalFromVerifiedAuth,
  canReadAnyProject,
  canReadProject,
  verifyToken,
} from "./events-backend";

const issueCreated: ExperimentalMcpEventDefinition = {
  name: "issue.created",
  description: "A new issue is created in a project.",
  inputSchema: z.strictObject({ project_id: z.string() }),
  payloadSchema: z.object({ id: z.string(), title: z.string() }),
  authorizeDiscovery: ({ principal }) => canReadAnyProject(principal),
  authorize: (args, { principal }) =>
    canReadProject(principal, args.project_id as string),
};

const handler = createMcpHandler((server) => {
  experimental_registerMcpEvents(server, {
    events: [issueCreated],
    getPrincipal: principalFromVerifiedAuth,
    subscriptions: subscriptionStore,
    delivery: durableWebhookDelivery,
  });
});

export const POST = withMcpAuth(handler, verifyToken, { required: true });
```

`./events-backend` is application code, not an included adapter. It supplies
verified identity, authorization, durable subscription storage and delivery
infrastructure. Registration does not create a database or start background
timers. Optional [webhook helpers](#optional-webhook-helpers) implement callback
verification and individual delivery attempts for Node.js backends.

## Methods and capabilities

The existing MCP endpoint advertises `capabilities.events: {}` and serves:

| Method               | Behavior                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events/list`        | Returns the authenticated account's catalog with `delivery: ["webhook"]`, input schemas and payload schemas.                                                                                       |
| `events/subscribe`   | Validates and authorizes arguments, derives subscription identity, reserves a fenced operation, verifies callback consent, and delegates conditional creation/refresh to the subscription adapter. |
| `events/unsubscribe` | Resolves the same principal/callback/event/arguments key and delegates cancellation.                                                                                                               |

All methods use the same `/mcp` route (or whichever route hosts the handler).
There is no extra inbound event route on this server: webhook delivery is an
outbound operation to the client's callback. Poll and push are not advertised
or implemented. The helper does not add anything to `tools/list`; a client that
wants model-callable subscription tools must build those from `events/list`.

The current `@modelcontextprotocol/client` 2.0 capability parser drops the draft
`events` field from `getServerCapabilities()`, even though it is present in the
server's `server/discover` response. An Events-aware client must preserve the
extension in discovery or call `events/list` explicitly. The generic SDK's
capability accessor alone cannot determine whether this extension is available.

The catalog is returned as a single page, without `nextCursor`. Requests with a
catalog cursor are rejected. For account-specific discovery, supply a resolver:

```typescript
events: async (context) => {
  return await catalogForPrincipal(context.principal);
},
```

The resolver runs within each authenticated request. An event can additionally
provide `authorizeDiscovery(context)` to hide its definition from callers who
cannot subscribe to that event type. This optional policy receives the verified
request context (`principal`, `authInfo`, `signal`) and must explicitly return
`true` to expose the event. It runs for both static arrays and resolved catalogs,
on every list and subscribe request. A hidden name cannot bypass the policy by
being supplied directly to `events/subscribe`; it returns `NotFound` before
filter authorization, reservation or callback verification. Policy exceptions
fail the request through the normal safe error handling. Omit the hook when the
catalog resolver already determines visibility or all callers may discover it.

Discovery has no event arguments, so the helper does not call `authorize` with
empty or invented filters. Each event's required `authorize(arguments, context)`
separately checks the actual requested filters before verification or storage
changes. For example, `authorizeDiscovery` can check whether the caller has any
readable projects, while `authorize` checks access to the specific `project_id`.
Visibility does not grant permission to every set of filters. Unsubscribe stays
available when discovery permission is removed so existing subscriptions can
still be stopped.

The filter policy receives `{ principal, signal }` so it can also run in a
delivery worker without request credentials. The catalog and adapter callbacks
still receive request `authInfo`. Use non-transforming Standard Schemas:
defaults, stripping fields, coercion or other argument transformations are
rejected when they change the input, because arguments are part of identity.

## Principal and subscription identity

`getPrincipal` receives the verified `AuthInfo` provided by `withMcpAuth`. Return
a stable, tenant/issuer-scoped user or app identifier. For example, derive it from
the issuer, tenant and subject established by your token verifier. Do not derive
it from event arguments or use the OAuth `clientId` as an end-user identity; many
users can share one OAuth client. The helper rejects missing/expired auth and
empty principals, and requires authentication for catalog discovery too.

This helper has no anonymous mode. Public demo feeds can be useful, but a
callback challenge only proves control of the receiving endpoint; it does not
establish permission to read another user's events. Do not manufacture an
`AuthInfo` or accept a user ID from event arguments to bypass authentication.
For a ChatGPT connection to private data, use OAuth and enforce the event's
`authorize` policy both at subscription time and in delivery workers.

The server derives `sub_<sha256>` from the canonical JSON tuple
`[principal, delivery.url, name, arguments]`. Object key order does not affect
identity. The callback URL is used as supplied, after validation. Changing any
identity component creates a different subscription. Changing the secret,
requested TTL or replay cursor refreshes the same key. Subscription IDs are
routing handles, never authorization grants. Namespace a shared storage adapter
per logical MCP server so unrelated servers cannot mix their subscriptions.

Unsubscribe accepts `name`, `arguments` and `delivery.url`, not a subscription
ID. It remains available when an event disappears or its schema changes: cleanup
uses the saved identity, not the current catalog. A missing subscription returns
the draft's `-32011` error with `data.kind: "subscription"`.

## Adapter contracts

The exported types describe the required methods:

| Adapter                            | Method                                       | Required behavior                                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExperimentalMcpWebhookDelivery`   | `verifyEndpoint(target, context)`            | Prove callback consent before activation. Return `{ verified: true }` only after a signed challenge succeeds or another verification mechanism allowed by the draft establishes consent; otherwise return a categorized failure.    |
| `ExperimentalMcpSubscriptionStore` | `prepare(key, context)`                      | Reserve a bounded, durable operation and return its unique fencing token. Apply admission limits before verification. Preserve any current active grant.                                                                            |
| `ExperimentalMcpSubscriptionStore` | `upsert(subscription, context, operationId)` | Atomically require the current, unexpired operation token before persisting/refreshing the verified subscription and arranging activation/reconciliation. Return `{ cursor, truncated, deliveryStatus? }` from the delivery system. |
| `ExperimentalMcpSubscriptionStore` | `remove(key, context)`                       | Atomically invalidate pending operations, stop delivery and arrange cleanup. Return true for a grant or pending reservation; false if neither exists.                                                                               |

These can be two interfaces to the same durable backend. The store is a lifecycle
adapter, not just a raw key/value database client: `upsert` must not commit a row
and then launch an untracked asynchronous delivery task. Use a transactional
outbox or equivalent recovery mechanism. Both create/refresh and cancellation
must be atomic and idempotent under concurrent requests and backend retries.
Requests can fail after a commit; a retry must converge on the same subscription.

The application backend is responsible for:

- Endpoint consent cached per `(principal, url)`, failed-verification rate limits,
  and egress policy enforcement on every verification and delivery attempt,
  including DNS resolution. Do not follow redirects; bound timeouts and response
  sizes. Registration only validates HTTPS URL syntax; the optional webhook
  helpers also enforce these network protections when making requests.
- Standard Webhooks signing using a vetted implementation. Event deliveries need
  `webhook-id`, `webhook-timestamp`, `webhook-signature` and
  `X-MCP-Subscription-Id`. Re-sign each retry with a fresh timestamp; support
  in-flight secret rotation and signed verification/gap/termination controls.
- Event sources, filter matching, payload-schema validation and ongoing
  authorization. Admission authorization alone does not authorize delivery after
  access is revoked. Enforce quotas, expiry and cancellation in the worker.
- Durable, bounded retries and acknowledgement handling. Stop retrying an event
  on `410` or `413` without deleting its subscription. Keep cancelled delivery
  work from becoming active after a delayed create/refresh.
- Safe replay watermarks and gap reporting. `upsert` receives the requested
  `cursor` (missing becomes null) and `maxAgeMs`. Return a safe watermark that
  does not run ahead of unacknowledged events. For a live source without replay,
  return `cursor: null`. Return `truncated: true` when resumption skipped events.
- Secret protection at rest and redaction in backend logs. Adapter exceptions
  and invalid return values become a generic protocol error. Explicit
  `ProtocolError`s with the draft's codes retain their code and only fixed,
  allowlisted diagnostic categories; endpoint response content is never returned.

Adapters receive the verified auth context and an abort signal. Do not retain
access tokens in subscription records or log them. Storage and delivery must
outlive the HTTP handler: `createMcpHandler` creates a fresh `McpServer` per
request, so a Map or timer inside its initializer cannot maintain subscriptions.
Only consent established by the verifier is passed into `upsert`. A `prepare`
reservation does not activate delivery or change a current grant's secret or
expiry. It may record pending operation metadata before verification.

### Coordinating verification with cancellation

The call order is `prepare → verifyEndpoint → upsert`. The helper passes the
opaque token returned by `prepare` as `upsert`'s third argument. The token stays
inside the server and is never returned to the MCP client. Storage implements
these steps using short transactions:

1. `prepare` assigns a unique operation token to the subscription key and a
   bounded reservation deadline. A newer operation supersedes the previous one.
   Existing active delivery continues under its previously verified grant.
2. `verifyEndpoint` performs network verification outside the transaction.
3. `upsert` checks the token and reservation deadline in the same transaction
   that commits the verified grant. A mismatched or expired token fails without
   changing the subscription or activating delivery. Repeating a committed
   operation must converge without replaying an older grant over newer state.
4. `remove` invalidates the reservation and stops the grant atomically. Pending
   reservations count as existing subscriptions for cancellation, even when
   verification has not finished.

For example, if unsubscribe completes while a callback challenge is outstanding,
its response may still arrive successfully. The subsequent `upsert` must reject
that operation. The same check prevents an older refresh from overwriting a
newer secret or deadline. Do not hold a database transaction across HTTP calls.

The backend must reclaim reservations after failed verification, request aborts,
and process crashes. Use bounded deadlines and a durable cleanup worker; the
helper does not promise a cleanup callback after a process crash. Reclaiming a
reservation must preserve any active grant and must never make its old token
valid again. `upsert` must not interpret a missing reservation as permission to
insert. Backend exceptions remain generic protocol errors, without leaking
operation tokens or endpoint responses.

The tests demonstrate this ordering with an in-memory adapter fixture. Real
adapters need database-backed fencing and their own concurrency/recovery tests.

### Migrating an existing server

Preserve the server-selected principal and callback URL representation used by
existing subscriptions. This helper hashes the supplied URL verbatim; a backend
that previously normalized URLs must reconcile existing keys before migration.
Keep no-expiry behavior explicit with `ttl.allowNoExpiry`, and reject unsupported
replay cursors in the backend instead of returning a false success. Applications
without replay should continue returning `cursor: null`.

## Optional webhook helpers

Two experimental Node.js helpers provide the signed challenge exchange and a
single event delivery attempt. They use `standardwebhooks` for signatures and
`request-filtering-agent` for address checks at connection time. Both require
HTTPS, reject credentials and URL fragments, reject private/special-use
addresses, preserve TLS certificate verification, and never follow redirects.
These restrictions also apply in development. There is no custom `fetch` or
agent override; applications with a different egress policy can keep their own
`ExperimentalMcpWebhookDelivery` implementation.

### Verify callback consent

`experimental_verifyMcpWebhookEndpoint(target, context)` has the existing
`verifyEndpoint` signature. It sends one signed verification challenge and
returns `{ verified: true }` only when a complete `2xx` JSON response echoes the
nonce. Mismatches and transport failures return `{ verified: false, reason }`
with the existing diagnostic categories. It never returns endpoint content.

Wrap it in your application's consent cache and admission controls:

```typescript
import {
  experimental_verifyMcpWebhookEndpoint,
  type ExperimentalMcpWebhookDelivery,
} from "mcp-handler";
import { consentStore, verificationLimiter } from "./events-backend";

export const webhookDelivery: ExperimentalMcpWebhookDelivery = {
  async verifyEndpoint(target, context) {
    // Scope this store to this logical MCP server; isVerified checks expiry.
    const key = { principal: context.principal, url: target.url };
    if (await consentStore.isVerified(key)) return { verified: true };

    // Bound attempts per destination host, including failed challenges.
    await verificationLimiter.check(new URL(target.url).hostname);
    const result = await experimental_verifyMcpWebhookEndpoint(target, context);
    if (result.verified) await consentStore.markVerified(key);
    return result;
  },
};
```

`consentStore` and `verificationLimiter` are application APIs. The helper has no
process-global consent cache: verification for one principal or logical MCP
server must not authorize another. Cache consent per `(principal, exact URL)`
with a bounded lifetime, coalesce concurrent checks, and retain verified status
with durable no-expiry subscriptions. Keep the existing `prepare → verifyEndpoint
→ upsert` ordering; a successful challenge alone does not activate delivery or
make a stale reservation valid.

### Send one event

`experimental_deliverMcpEvent` invokes `experimental_validateMcpEventDelivery`
first, then signs and sends the event. Use it from a durable worker after loading
current active state and matching the source event to the subscription filters:

```typescript
import { experimental_deliverMcpEvent } from "mcp-handler";
import { issueCreated, subscriptionStore } from "./events-backend";

async function attemptDelivery(job) {
  const subscription = await subscriptionStore.get(job.subscriptionId);
  if (!subscription) return;

  // The worker owns filter matching and coordination with cancellation.
  const result = await experimental_deliverMcpEvent({
    event: issueCreated,
    subscription,
    payload: job.payload,
    eventId: job.eventId,
    timestamp: new Date(job.occurredAt),
    cursor: job.safeWatermark,
    previousSecrets: await subscriptionStore.getPreviousSecrets(subscription.id),
    signal: job.signal,
  });

  // Return to the durable queue's bounded retry/acknowledgement policy.
  return result;
}
```

| Input | Meaning |
| --- | --- |
| `event`, `subscription`, `payload` | Trusted definition, freshly loaded active subscription, and matching source data. The helper checks the current permission policy, both schemas, event name and expiry. |
| `eventId` | Stable event identifier, reused across retries; also sent as `webhook-id`. |
| `timestamp` | Required `Date` when the event occurred. Persist it with the job and preserve it across retries. |
| `cursor` | Optional safe acknowledged/abandoned watermark, default `null`. The helper never copies the subscription's requested replay cursor into the delivery. |
| `previousSecrets` | Up to two additional trusted secrets for a short rotation grace period. Each attempt signs with the subscription's current secret plus these keys. Load current rotation state on each retry. |
| `signal` | Optional worker cancellation signal. Cancellation rejects with the caller's abort reason and destroys the request. |

The request body is `{ eventId, name, timestamp, data, cursor }`. Every attempt
gets fresh Standard Webhooks signing headers and `X-MCP-Subscription-Id`. The
helper snapshots the selected subscription fields and plain JSON payload before
async validation; unrelated database metadata is ignored. Unpadded valid
`whsec_` secrets are accepted, as in subscription registration.

Success returns `{ ok: true }`. Transport failures return
`{ ok: false, reason, retryable, status? }`, with no endpoint response content.
`410` and `413` are non-retryable for this event, without deleting or terminating
the subscription. Redirects and oversized responses are also non-retryable.
Other HTTP failures and network failures are retryable under the worker's
bounded retry policy. `reason` is one of `connection_refused`, `timeout`,
`tls_error`, `http_4xx`, `http_5xx`, `redirect`, or `response_too_large`.

Schema/authorization/expiry failures throw `ExperimentalMcpEventDeliveryError`;
policy-service exceptions also propagate. Invalid URL, key or identifier inputs,
invalid timestamps/cursors, and oversized outgoing bodies throw before dispatch.
Do not treat a policy-service outage as revoked access. The helper does not
schedule retries, update acknowledgement state, compute watermarks, cache
permissions, or delete subscriptions.

Both network operations use a ten-second total request deadline and a 64 KiB
response limit; outgoing event envelopes are limited to 256 KiB. DNS address
checks apply on each attempt, with no pooled connections. Timeouts, aborts,
truncated responses and oversized responses tear down the request/response.
These helpers do not send `gap` or `terminated` controls; lifecycle adapters
remain responsible for those. The validation-only helper below remains useful
when your backend already provides signing and delivery.

## Validating delivery in a worker

Export the same event definition for your MCP handler and durable worker. Before
each delivery attempt, load the current active subscription and validate the
candidate data:

```typescript
import { experimental_validateMcpEventDelivery } from "mcp-handler";
import {
  issueCreated,
  subscriptionStore,
  durableWebhookDelivery,
} from "./events-backend";

async function deliverIssue(subscriptionId: string, payload: unknown) {
  // Application-specific get(): return only current, active subscriptions.
  const subscription = await subscriptionStore.get(subscriptionId);
  if (!subscription) return;

  await experimental_validateMcpEventDelivery({
    event: issueCreated,
    subscription,
    payload,
  });

  // The durable backend gates dispatch against cancellation, then signs/sends.
  await durableWebhookDelivery.send({ subscription, payload });
}
```

`get()` and `send()` above are application APIs, not new required adapter methods.
The helper returns `Promise<void>` and throws on failure. It checks the event
name, a nonempty stored principal, and the granted `refreshBefore`; `null` permits
no expiry, while missing or malformed deadlines fail closed. It validates the
stored arguments and `payload` (the event's `data`, not the webhook envelope)
against the current schemas, then invokes `event.authorize(arguments, {
principal, signal })`. It rechecks expiry and an optional caller-provided `signal`
after asynchronous validation and authorization. It does not transform data:
coercion, stripping, defaults or mutation that change the JSON value are rejected
so the worker can send the original validated payload. Use plain JSON values.

The helper needs only `principal`, `name`, `arguments` and `refreshBefore` from
the stored record; it does not need the original access token or signing secret.
`authorize` must consult current application permissions and any durable grant
restrictions maintained by your backend. Access-token expiry and subscription
expiry are separate; a user does not need to stay logged in. The draft recommends
periodic permission rechecks; it does not mandate token verification for every
event. This helper invokes the policy on each call and does not cache its result.

Known failures throw `ExperimentalMcpEventDeliveryError` with a fixed message and
one of these `code` values:

| Code                   | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `invalid_subscription` | Missing record, invalid identity/arguments shape, or malformed deadline. |
| `event_mismatch`       | The supplied definition belongs to another event name.                   |
| `expired`              | The stored grant expired, including during an asynchronous check.        |
| `invalid_arguments`    | Stored filters no longer match the current input schema unchanged.       |
| `invalid_payload`      | Candidate data is not JSON matching the payload schema unchanged.        |
| `forbidden`            | The authorization policy did not explicitly allow delivery.              |

Do not send on any failure. Policy/schema exceptions and abort reasons propagate
unchanged: a permissions-service outage is not proof of revocation. Let the
durable worker decide retries and termination; this helper does not delete
subscriptions or send signed termination controls.

This validates a candidate against the supplied state, not against the database.
It cannot detect a cancelled or suspended subscription in an old snapshot.
The backend must coordinate active state, expiry, cancellation and dispatch,
including on retries and after queue delays. It also owns matching source events
to the subscription's filters: schema validation alone cannot prove that an
issue belongs to an authorized project. Keep definitions and subscription
records trusted, and do not mutate validated values before sending. The helper
does not sign or verify webhook signatures, make network requests, or schedule
work.

## TTL and refresh

By default, the server grants one hour, clamps requests to a one-minute minimum
and one-day maximum, and does not grant no-expiry subscriptions. Configure this
with `ttl: { minMs, defaultMs, maxMs, allowNoExpiry }`.

An explicit `ttlMs: null` requests no expiry. The helper grants it only when
`allowNoExpiry: true`; otherwise it grants the default finite TTL. Omitted TTLs
and finite requests always receive finite grants, even when no expiry is enabled.
Only enable no expiry when the backend persists subscriptions across restarts
and provides sustained-failure cleanup. Storage must honor every granted expiry.

The client renews a finite subscription by re-calling `events/subscribe` with the
same identity before `refreshBefore`. The adapter updates expiry and secret,
reactivates suspended delivery, and returns its latest cursor/status. No-expiry
clients should still occasionally refresh for health checks and cursor progress.
Webhook mode does not need push heartbeat notifications or a held-open connection.

## Request telemetry

`onEvent` continues to report requests, but telemetry for every `events/*`
method replaces a supplied `params.delivery.secret` with `[REDACTED]`, including
unknown methods and servers where the extension is not registered. This also
protects callers that reuse subscribe parameters when unsubscribing. The actual
protocol request still receives the original secret.
Application logging outside this hook needs equivalent redaction.
