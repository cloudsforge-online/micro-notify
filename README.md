# micro-notify

[![ci](https://github.com/cloudsforge-online/micro-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-notify/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

Preferences, templates, notifications, deliveries, digests and developer webhooks. It owns the
question "was this person told, on which channel, and did it arrive" — and nothing else. It decides
*whether* and *where* to send; it does not decide what happened, and it never originates a fact.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

> **A critical notification ignores preferences, and the database is what enforces that.** A user
> cannot opt out of being told their key left — and neither can a bug, a migration, or an operator
> with a connection. Two CHECK constraints on `notifications` carry it:
> `notifications_critical_never_suppressed` and `notifications_critical_reaches_a_channel`
> (`src/migrations.ts:140-143`). A `critical` row that is suppressed, or that reached zero channels,
> **cannot be represented**.

## Routes

Read out of `src/server.ts`. Every path is served under both `/v1` and the bare spelling.

| Method | Path | Who | What it does |
| --- | --- | --- | --- |
| `GET` | `/notifications` | user, or a service with the read scope | The in-app feed (`src/server.ts:308`) |
| `POST` | `/notifications/:id/read` | user | Marks one read (`src/server.ts:333`) |
| `GET` | `/preferences` | user, or an admin reading another's | Per-category channel and digest settings (`src/server.ts:355`) |
| `PUT` | `/preferences` | user | Replaces them (`src/server.ts:385`) |
| `POST` | `/ingest` | **HMAC signature only** — no bearer is read | The event bus inbox (`src/server.ts:409`). The signature over the raw bytes is the authentication; it used to also demand a service token with the ingest scope, which no outbox relay in the estate presents, so the event bus itself was refused by the route built to receive it |
| `POST` | `/admin/broadcasts` | operator | Sends to a cohort (`src/server.ts:482`) |
| `GET` | `/admin/deliveries` | operator | Delivery attempts, for answering "did it arrive" (`src/server.ts:533`) |
| `GET` | `/livez` `/readyz` `/metrics` | unauthenticated | `src/server.ts:268`, `:279`, `:287` |

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
seed re-arms it (`src/jobs.ts:54-62`), so a restart does not lose the schedule and two replicas do
not both hold a clock.

| Job | Lease key | Cadence | Two replicas |
| --- | --- | --- | --- |
| `notify.dispatch` | `queue` | 1s | one claims the lease; the other finds it held and does nothing (`src/jobs.ts:55`) |
| `notify.digest` | `windows` | 30s | same (`src/jobs.ts:56`) |
| `notify.broadcast` | per broadcast | on demand | one claims each broadcast (`src/jobs.ts:41`) |

**The lease key names the contended resource, not the row** (`src/jobs.ts:10`). `dispatch` drains
the whole backlog inside one lease rather than one batch per tick, because after an outage the
batch-per-tick shape lets a second replica start claiming rows the first is still working
(`src/jobs.ts:111-114`).

Per-delivery attempts and backoff live in the `deliveries` table rather than in the job, since that
table is already the thing an operator reads when asked whether a message arrived.

## The database

`inbox`, `preferences`, `channel_targets`, `notifications`, `deliveries`, `digests`,
`digest_entries`, `broadcasts`.

The constraints that carry meaning, and why each is in the schema rather than in a handler:

| Constraint | Refuses | Why here |
| --- | --- | --- |
| `notifications_critical_never_suppressed` | a suppressed `critical` row | preferences are applied in code, and code can be wrong; this holds against a migration and an operator too (`src/migrations.ts:140`) |
| `notifications_critical_reaches_a_channel` | a `critical` row that reached no channel | `channel_count` defaults to 0, so the insert path is *forced* to compute it — the safe value is the one that fails (`src/migrations.ts:142`, default at `:133`) |
| `channel_targets_not_in_app` | an `in_app` channel target | in-app is the feed, which has no address to deliver to (`src/migrations.ts:102`) |
| `channel_targets_webhook_signed` | a webhook target with a secret under 16 bytes | an unsigned webhook is one anybody can forge; the length is not the handler's opinion (`src/migrations.ts:105-106`) |
| `channel_targets_uniq` | the same address twice on one channel | prevents delivering one notification to one address twice |

`resolveRouting` puts the critical branch **first and total** — it returns before `input.preferences`
is read at all (`src/routing.ts:97-102`), and `applyPreferences` takes a `NonCriticalPriority`, so
handing it a critical notification is a **type error rather than a bug** (`src/routing.ts:21`).

Deduplication is a partial unique index on `dedupe_key` per user, so the many notifications that
legitimately have no dedupe key do not collide.

## Configuration

Cross-checked against `src/env.ts`.

| Variable | Default | If wrong |
| --- | --- | --- |
| `NOTIFY_DATABASE_URL` | — | refuses to start |
| `PORT` | `4012` | — (`src/env.ts:211`) |
| `IDENTITY_JWKS_URL`, `IDENTITY_ISSUER` | — | every authenticated route 503s rather than 401s: an unreachable verifier must not sign the estate out |
| `NOTIFY_INGEST_SIGNING_SECRET` | — | `/ingest` refuses every event; the signature is checked **before** the body is parsed |
| `NOTIFY_DELIVERY_MAX_ATTEMPTS` | see `src/env.ts` | too low drops deliveries; too high retries a permanent failure for ever |
| `NOTIFY_DISPATCH_BATCH_SIZE` | see `src/env.ts` | throughput only |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`, `SMTP_REPLY_TO` | unset | **unconfigured is a supported mode** — email is generic SMTP, never a provider SDK, and with no host the email channel is simply unavailable rather than broken |
| `NOTIFY_WEBPUSH_URL`, `NOTIFY_MOBILEPUSH_URL`, `NOTIFY_SMS_URL` | unset | that channel is unavailable |
| `NOTIFY_PUBLIC_URL` | — | links in messages point at the wrong host |

`PORT=4012` in `.env.example` and `src/env.ts:211` agree, and CI now fails the build if they ever
stop agreeing — this file used to say `4600`.

## What it talks to

| Upstream | How | When it is down |
| --- | --- | --- |
| `micro-identity` | JWKS, for every authenticated route | **fail closed with 503**, never 401 |
| SMTP | outbound email | the delivery is retried with backoff and recorded as failed; nothing else stops |
| web push / mobile push / SMS | outbound HTTP | as above, per channel |
| developer webhooks | signed POST | signature covers the body and a freshness window, so a replayed body cannot be moved in time (`src/webhook.ts:15-22`) |

Nothing calls `notify` synchronously to make a user-facing request succeed. A notification that
cannot be sent must never fail the thing that caused it.

## Running it

```bash
pnpm install
docker run -d --rm --name notify-pg -e POSTGRES_USER=n -e POSTGRES_PASSWORD=n \
  -e POSTGRES_DB=notify_test -p 55445:5432 postgres:17-alpine
NOTIFY_TEST_DATABASE_URL=postgres://n:n@127.0.0.1:55445/notify_test pnpm test
```

The database name **must contain `test`** (`src/testsupport.ts:25-30`) — the suite truncates
tables, and that guard is what stops it doing so to something else. Without the variable the
database tests do not run, and CI fails a build whose suite skipped them.

`pnpm migrate` is a separate one-shot process, never the service. `pnpm start` runs it.

## Known gaps

- **`devplatform.*` is not a registered topic**, so developer-webhook events from the developer
  platform are acknowledged and ignored rather than delivered. Recorded in
  `docs/ecosystem/18-build-status.md` §3.3.
- **`/metrics` is unauthenticated**, as on every service here except `micro-beacon`, which gates its
  equivalent. Nothing in this repository says whether that divergence is deliberate; today it rests
  on the assumption that the metrics port is not routed publicly. The gateway's public map
  (`micro-deploy`) does not route it.
- **Nothing is deployed.** This service has never run against a persistent database outside a test.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
