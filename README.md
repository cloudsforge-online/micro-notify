# micro-notify

[![ci](https://github.com/cloudsforge-online/micro-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-notify/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

Preferences, templates, notifications, deliveries, digests and developer webhooks. It owns the
question "was this person told, on which channel, and did it arrive" — and nothing else. It decides
*whether* and *where* to send; it does not decide what happened, and it never originates a fact.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

> **A critical notification ignores preferences, and the database is what enforces that.** A user
> cannot opt out of being told their key left — and neither can a bug, a migration, or an operator
> with a connection. Two CHECK constraints on `notifications` carry it:
> `notifications_critical_never_suppressed` and `notifications_critical_reaches_a_channel`
> (`src/migrations.ts`). A `critical` row that is suppressed, or that reached zero channels,
> **cannot be represented**.

## Routes

Read out of `src/server.ts`. Every path is served under both `/v1` and the bare spelling.

| Method | Path | Who | What it does |
| --- | --- | --- | --- |
| `GET` | `/notifications` | user, or a service with the read scope | The in-app feed (`src/server.ts`) |
| `POST` | `/notifications/:id/read` | user | Marks one read (`src/server.ts`) |
| `GET` | `/preferences` | user, or an admin reading another's | Per-category channel and digest settings (`src/server.ts`) |
| `PUT` | `/preferences` | user | Replaces them (`src/server.ts`) |
| `POST` | `/ingest` | **HMAC signature only** — no bearer is read | The event bus inbox (`src/server.ts`). The signature over the raw bytes is the authentication; it used to also demand a service token with the ingest scope, which no outbox relay in the estate presents, so the event bus itself was refused by the route built to receive it |
| `POST` | `/admin/broadcasts` | operator | Sends to a cohort (`src/server.ts`) |
| `GET` | `/admin/deliveries` | operator | Delivery attempts, for answering "did it arrive" (`src/server.ts`) |
| `GET` | `/livez` `/readyz` `/metrics` | unauthenticated | `src/server.ts` |

**Every route above except the three probes and `/ingest` calls `authenticate()`.** No route is
open to an anonymous browser: the feed and preference routes demand a token, and `/ingest` demands
something stronger — the outbox signing secret, proved over the exact bytes received.

`POST /ingest` is the only way a notification is created. There is no "send me a notification"
route, deliberately: a notification is a consequence of something that happened elsewhere, and a
service that could be asked to invent one directly would let any caller forge a security alert.
A signed-in person still cannot reach it — not because a token is refused, but because a person
does not hold the outbox signing secret, and no token of any kind is read.

## Background work

Leased jobs only; there are no timers. A recurring job is a producer plus a leased job — the boot
seed re-arms it (`src/jobs.ts`), so a restart does not lose the schedule and two replicas do
not both hold a clock.

| Job | Lease key | Cadence | Two replicas |
| --- | --- | --- | --- |
| `notify.dispatch` | `queue` | 1s | one claims the lease; the other finds it held and does nothing (`src/jobs.ts`) |
| `notify.digest` | `windows` | 30s | same (`src/jobs.ts`) |
| `notify.broadcast` | per broadcast | on demand | one claims each broadcast (`src/jobs.ts`) |

**The lease key names the contended resource, not the row** (`src/jobs.ts`). `dispatch` drains
the whole backlog inside one lease rather than one batch per tick, because after an outage the
batch-per-tick shape lets a second replica start claiming rows the first is still working
(`src/jobs.ts`).

Per-delivery attempts and backoff live in the `deliveries` table rather than in the job, since that
table is already the thing an operator reads when asked whether a message arrived.

## The database

`inbox`, `preferences`, `channel_targets`, `notifications`, `deliveries`, `digests`,
`digest_entries`, `broadcasts`.

The constraints that carry meaning, and why each is in the schema rather than in a handler:

| Constraint | Refuses | Why here |
| --- | --- | --- |
| `notifications_critical_never_suppressed` | a suppressed `critical` row | preferences are applied in code, and code can be wrong; this holds against a migration and an operator too (`src/migrations.ts`) |
| `notifications_critical_reaches_a_channel` | a `critical` row that reached no channel | `channel_count` defaults to 0, so the insert path is *forced* to compute it — the safe value is the one that fails (`src/migrations.ts`, default) |
| `channel_targets_not_in_app` | an `in_app` channel target | in-app is the feed, which has no address to deliver to (`src/migrations.ts`) |
| `channel_targets_webhook_signed` | a webhook target with a secret under 16 bytes | an unsigned webhook is one anybody can forge; the length is not the handler's opinion (`src/migrations.ts`) |
| `channel_targets_uniq` | the same address twice on one channel | prevents delivering one notification to one address twice |

`resolveRouting` puts the critical branch **first and total** — it returns before `input.preferences`
is read at all (`src/routing.ts`), and `applyPreferences` takes a `NonCriticalPriority`, so
handing it a critical notification is a **type error rather than a bug** (`src/routing.ts`).

Deduplication is a partial unique index on `dedupe_key` per user, so the many notifications that
legitimately have no dedupe key do not collide.

## Configuration

Cross-checked against `src/env.ts`.

| Variable | Default | If wrong |
| --- | --- | --- |
| `NOTIFY_DATABASE_URL` | — | refuses to start |
| `PORT` | `4012` | — (`src/env.ts`) |
| `IDENTITY_JWKS_URL`, `IDENTITY_ISSUER` | — | every authenticated route 503s rather than 401s: an unreachable verifier must not sign the estate out |
| `NOTIFY_INGEST_SIGNING_SECRET` | — | `/ingest` refuses every event; the signature is checked **before** the body is parsed |
| `NOTIFY_DELIVERY_MAX_ATTEMPTS` | see `src/env.ts` | too low drops deliveries; too high retries a permanent failure for ever |
| `NOTIFY_DISPATCH_BATCH_SIZE` | see `src/env.ts` | throughput only |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`, `SMTP_REPLY_TO` | unset | **unconfigured is a supported mode** — email is generic SMTP, never a provider SDK, and with no host the email channel is simply unavailable rather than broken |
| `NOTIFY_WEBPUSH_URL`, `NOTIFY_MOBILEPUSH_URL`, `NOTIFY_SMS_URL` | unset | that channel is unavailable |
| `NOTIFY_PUBLIC_URL` | — | links in messages point at the wrong host |

`PORT=4012` in `.env.example` and `src/env.ts` agree, and CI now fails the build if they ever
stop agreeing — this file used to say `4600`.

## What it talks to

| Upstream | How | When it is down |
| --- | --- | --- |
| `micro-identity` | JWKS, for every authenticated route | **fail closed with 503**, never 401 |
| SMTP | outbound email | the delivery is retried with backoff and recorded as failed; nothing else stops |
| web push / mobile push / SMS | outbound HTTP | as above, per channel |
| developer webhooks | signed POST | signature covers the body and a freshness window, so a replayed body cannot be moved in time (`src/webhook.ts`) |

Nothing calls `notify` synchronously to make a user-facing request succeed. A notification that
cannot be sent must never fail the thing that caused it.

## Running it

```bash
pnpm install
docker run -d --rm --name notify-pg -e POSTGRES_USER=n -e POSTGRES_PASSWORD=n \
  -e POSTGRES_DB=notify_test -p 55445:5432 postgres:17-alpine
NOTIFY_TEST_DATABASE_URL=postgres://n:n@127.0.0.1:55445/notify_test pnpm test
```

The database name **must contain `test`** (`src/testsupport.ts`) — the suite truncates
tables, and that guard is what stops it doing so to something else. Without the variable the
database tests do not run, and CI fails a build whose suite skipped them.

`pnpm migrate` is a separate one-shot process, never the service. `pnpm start` runs it.

## Known gaps

- **~~`devplatform.*` is not a registered topic.~~ It is, and this service handles it — what is
  still missing is a producer that has ever sent one.** The claim came from
  `docs/ecosystem/18-build-status.md` §3.3, which recorded it as one of three smaller findings, and
  both halves of it have since stopped being true. `micro-contracts` registers
  `devplatform.key.issued` and `devplatform.key.revoked` in
  `contracts/packages/events/src/index.ts`, with `devplatform` in the `ProducerService` union, so
  `makeEvent` builds them. This repository then does the consumer half in full: `src/catalogue.ts`
  carries a rule for each, both `category: 'api'` and `priority: 'high'`, and `src/templates.ts`
  carries the `api.key_issued` and `api.key_revoked` bodies they render. `src/catalogue.test.ts`
  asserts both topics are mapped, and `src/topics.ts`'s `AWAITING_REGISTRATION` quarantine — which
  held exactly these two while contracts caught up — is empty again. Nothing is acknowledged and
  ignored.

  What is true is narrower and worth keeping: **no `devplatform.*` event has ever arrived.** The
  estate's `notify` database holds zero `inbox` rows on any `devplatform` topic against 15,265
  total, so the rules and templates above are untested by traffic rather than proven by it. And one
  path is designed to notify nobody, which is a decision rather than an oversight: the
  organisation-erasure route in `devplatform` revokes every live key an organisation holds as the
  actor `service:identity`, and `forUser` in `src/catalogue.ts` answers `no_recipient` for a
  `service:` actor because guessing would tell the wrong person their credentials changed. The
  payload names a key and a project, never an owner, and this service holds no project-membership
  table to look one up in. The repair is one field from the producer (`api_keys.created_by`, already
  on the row `revokeOrgKeys` updates) and is filed against `micro-devplatform`, not worked around
  here. `src/catalogue.ts` carries the long form of the argument.
- **`/metrics` is unauthenticated**, as on every service here except `micro-beacon`, which gates its
  equivalent. Nothing in this repository says whether that divergence is deliberate; today it rests
  on the assumption that the metrics port is not routed publicly. The gateway's public map
  (`micro-deploy`) does not route it.
- **~~Nothing is deployed.~~ It is deployed and it has run against a persistent database for a long
  time — but "deployed" and "delivering mail" are two claims, and only the first one holds.**
  `deploy/compose/docker-compose.estate.yml` builds this repository twice: `notify-migrate`, from
  build context `../../notify`, running `src/migrator.ts` once under `restart: "no"` and waiting on
  `postgres: service_healthy`; and `notify` itself, gated behind
  `notify-migrate: service_completed_successfully` and `identity: service_healthy`, published on
  `127.0.0.1:4110`, with `NOTIFY_DATABASE_URL` pointing at `postgres:5432/notify` and
  `INSTANCE_ID: notify-estate`. Its healthcheck is the estate's shared `*healthcheck` anchor, which
  probes **`/readyz` rather than `/livez`** — deliberately, since liveness answers while the
  database is unreachable, and that is the whole distinction the two endpoints exist to draw. So
  the schema in `src/migrations.ts` is applied to a real database by a real one-shot process, and
  the service is not counted up until it can reach it.

  The estate bears that out: the container reports healthy, and the persistent `notify` database
  holds 15,265 `inbox` rows, 15,204 `notifications`, 16,596 `deliveries` and 7,603 email
  `channel_targets` — orders of magnitude past anything a truncating test suite produces.

  **The gap that replaces this one is deliverability, not deployment.** Every one of the 15,204
  in-app deliveries is `sent`; email is 344 `sent` against 1,048 `dead`, and the recorded
  `last_error` on all 1,048 is `SMTP 535`. That is not the "unconfigured is a supported mode" branch
  described under Configuration — the compose block defaults every `SMTP_*` value to empty
  (`${SMTP_HOST:-}`) so a local drill needs rows rather than emails, but the estate does supply
  them, from a gitignored `compose/estate/tokens.env` that Compose loads as `compose/.env`. The host
  is set, the credentials authenticate, and the transactional mail provider behind them is on a free
  tier with a low daily cap that synthetic registration traffic from `micro-beacon` exhausts. A 535
  here is therefore a quota refusal wearing an authentication status code, and reading it as broken
  credentials sends you to the wrong file. Note also that `SMTP_SECURE` means *implicit* TLS and is
  port 465 only; setting it on 587, which is the port the estate uses, makes the connection fail
  rather than harden it.

  **Since 2026-08-09 the service says this itself rather than leaving it to be re-derived**
  (micro-org#243). A volume refusal is classified `quota_exhausted` rather than `upstream_error`,
  so it has its own label on `notify_failed_total`, its own value in `deliveries.reason`, its own
  `dead_quota_exhausted` / `undeliverable_quota_exhausted` spelling in the generated `outcome`
  column, and one `warn` line that states it is not a credentials failure. `last_error` now reads
  *"the mail provider's allowance is spent, not the credentials"* instead of `SMTP 535`. Alert on
  `notify_deliveries_awaiting_allowance` — above zero for longer than one allowance period means a
  real person cannot be verified right now.

  It also no longer dead-letters on it. An allowance refusal does not spend the delivery's attempt
  budget and waits out the retry-after the provider states, so the message is parked and goes out
  when the allowance resets, bounded at one provider day plus an hour of clock slack. Before that,
  `max_attempts` = 6 against a backoff that reaches its cap in about thirty seconds meant every
  message written into an exhausted window was dead by construction — which is what the 1,048 rows
  above are.

  Two things follow for anyone reading the delivery table. The dead rows are concentrated on
  accounts that no person owns — the estate has no real users yet, and the volume above is beacon
  and test residue — so this is a cold-start defect rather than an outage. And the failure is
  contained exactly where the design says it should be: a dead email delivery is recorded in
  `deliveries` with its attempts and its error, the in-app feed for the same notification is
  `sent`, and nothing upstream of `/ingest` failed because of it.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
