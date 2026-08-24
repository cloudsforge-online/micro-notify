/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not
 * arbitrary. Each step below carries the reason it must precede the next; the ordering is the
 * substance of this file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env, transportSummary } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import {
  registerServiceMetrics,
  AWAITING_ALLOWANCE,
  DELIVERIES_DEAD,
  DELIVERIES_PENDING,
  DIGESTS_OPEN,
  RESERVED_DOMAIN_DELIVERIES,
  RESERVED_DOMAIN_GUARD,
  RESERVED_DOMAIN_WINDOW_MS,
} from './metrics.ts'
import { createServer } from './server.ts'
import { BROADCAST_KIND, DISPATCH_KIND, registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { emailAdapter, smtpConfigured } from './email.ts'
import { gatewayAdapter, inAppAdapter, registryOf } from './channels.ts'
import { webhookAdapter } from './webhook.ts'
import { deliveryStats, openDigestCount, postgresNotifyStore, reservedDomainDeliveries } from './store.ts'
import { reservedDomainGuardIntact, type PipelineDeps } from './pipeline.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

// Which channels this deployment can actually reach, at info, on every boot. Nimbus already does
// this for mail and it is the single most useful line in its output: "did this deployment send
// that, or did it record it and stay silent" is otherwise answered by reading configuration on a
// host you may not have. Channel names only — never a credential.
logger.info('transports', transportSummary(env))

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does **not** migrate. Failing here rather than serving is the point:
//    a replica of the new code answering requests against the old schema corrupts data quietly,
//    whereas a container that refuses to start is a deploy that visibly stops.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores
      // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
      // database is not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(
    // Soft. If identity is down this service still serves everything that does not need a fresh
    // key — and marking it hard means one identity blip removes every service in the estate from
    // its balancer at once, which is a cascade, not a safety measure.
    httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
  )

// 6. The channel adapters. Every one is constructed whether or not it is configured: an
//    unconfigured adapter answers `no_transport`, which is a recorded, countable delivery outcome
//    and an explicitly supported way to run. Omitting the adapter instead would produce
//    "no adapter registered", which says the same thing in a way an operator cannot act on.
const adapters = registryOf([
  inAppAdapter(),
  emailAdapter({ smtp: env.smtp }),
  gatewayAdapter({ channel: 'web_push', url: env.gateways.webPushUrl, token: env.gateways.token }),
  gatewayAdapter({ channel: 'mobile_push', url: env.gateways.mobilePushUrl, token: env.gateways.token }),
  gatewayAdapter({ channel: 'sms', url: env.gateways.smsUrl, token: env.gateways.token }),
  webhookAdapter(),
])

const pipeline: PipelineDeps = {
  sql,
  logger,
  metrics,
  adapters,
  publicUrl: env.publicUrl,
  maxAttempts: env.deliveryMaxAttempts,
  instanceId: env.instanceId,
  // The same predicate the adapter uses to decide whether it can send at all, read once here so
  // the pipeline and the adapter cannot disagree about whether this deployment has a mailer. It
  // decides whether a notification that reaches nobody by email is counted: on a deployment with
  // no SMTP that is a configuration choice, and on this one it is the defect the owner reported.
  emailConfigured: smtpConfigured(env.smtp),
}

// 7. Routes. Constructed after the Lifecycle so the health handlers report real state, and after
//    the pool so the stores are real rather than a lazily-connected surprise on first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  store: postgresNotifyStore(sql),
  pipeline,
  ...(env.singleNetwork ? { singleNetwork: env.singleNetwork as 'mainnet' | 'testnet' } : {}),
  ingestSecrets: env.ingestSigningSecrets,
  enqueueBroadcast: async (broadcastId) => {
    await queue.enqueue({
      kind: BROADCAST_KIND,
      // The lease key names one broadcast: two broadcasts must fan out concurrently, and one
      // must not fan out twice.
      key: `broadcast:${broadcastId}`,
      payload: { broadcastId },
      onConflict: 'keep',
    })
  },
  enqueueDispatch,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const jobs = await queue.stats()
    metrics.set('jobs_pending', jobs.pending)
    metrics.set('jobs_overdue', jobs.overdue)
    const deliveries = await deliveryStats(sql)
    metrics.set(DELIVERIES_PENDING, deliveries.pending)
    metrics.set(DELIVERIES_DEAD, deliveries.dead, { state: 'dead' })
    metrics.set(DELIVERIES_DEAD, deliveries.undeliverable, { state: 'undeliverable' })
    metrics.set(AWAITING_ALLOWANCE, deliveries.awaitingAllowance)
    metrics.set(DIGESTS_OPEN, await openDigestCount(sql))
    // micro-org#390. Answered HERE, at scrape time, and not once at boot: a boot-time answer
    // describes the build that booted, and a rolling replacement puts a different build behind the
    // same service name without ever booting this line again. The question is "does the process
    // being scraped right now still refuse", so it is asked of the process being scraped right now.
    metrics.set(RESERVED_DOMAIN_GUARD, reservedDomainGuardIntact() ? 1 : 0)
    metrics.set(RESERVED_DOMAIN_DELIVERIES, await reservedDomainDeliveries(sql, RESERVED_DOMAIN_WINDOW_MS))
  },
})

// 8. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that. Starting it after `listen()` would leave a window in which
//    the service takes requests it cannot follow up with background work.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

/**
 * Pull the dispatcher forward.
 *
 * `earliest` moves the existing recurring row's `run_at` back rather than creating a second
 * dispatcher, so calling it on every ingest is safe. Without it a critical notification waits for
 * the next poll — up to a second, which is fine, but the digest flush needs the same nudge and
 * "the batch fires on its schedule" is a promise this service makes.
 */
async function enqueueDispatch(): Promise<void> {
  await queue.enqueue({ kind: DISPATCH_KIND, key: 'queue', onConflict: 'earliest' })
}

registerHandlers(runner, { pipeline, batchSize: env.dispatchBatchSize, enqueueDispatch })
await seedRecurring(queue)
runner.start()

// 9. Listen. Last of the construction steps, because a socket that accepts before its
//    dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 10. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and
//     the balancer is allowed to send traffic.
lifecycle.markReady()

// 11. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready, and the drain races the construction above.
//     Hooks run in reverse registration order, so the server closes first, then the runner stops
//     claiming and drains, then the pool closes with nothing left to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
