/**
 * The pipeline: event in, notification out, delivery attempted, retried, batched or buried.
 *
 * Four operations, and they are all the same shape underneath — which is the design constraint
 * AD-08 sets and this file honours:
 *
 *   `ingestEvent`      — a domain event becomes notifications for its recipients.
 *   `dispatchDue`      — pending deliveries are leased, sent, and either completed, backed off,
 *                        dead-lettered or marked undeliverable.
 *   `flushDueDigests`  — a batch whose window has passed becomes one summary delivery.
 *   `fanOutBroadcast`  — an operator's message becomes one notification per reachable user.
 *
 * There is one delivery path. An email, a push, an SMS and a developer webhook are the same row
 * in the same table, claimed by the same query, retried with the same backoff, and buried in the
 * same dead-letter view. That is not tidiness; it is the difference between one retry policy that
 * is tested and two that drift.
 *
 * ## Activity and notify are not a chain
 *
 * AD-11 gives the canonical feed to `activity`, and both services consume the same stream. This
 * file never calls activity, never waits for it and never checks whether it succeeded. A
 * notification blocked on a feed write is a security alert that does not arrive because a feed
 * was slow, and §10.3 does not have an exception for that.
 */

import { backoffFor } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { ERASURE_TOPICS, outcomeOf, ruleFor, type Recipient } from './catalogue.ts'
import type { AdapterRegistry, OutboundMessage } from './channels.ts'
import type { InboundEvent } from './events.ts'
import {
  DEADLETTER_TOTAL,
  DELIVERY_LATENCY_MS,
  FAILED_TOTAL,
  NOTIFICATIONS_TOTAL,
  SENT_TOTAL,
  SUPPRESSED_TOTAL,
} from './metrics.ts'
import {
  FLOOR_CHANNEL,
  resolveLocale,
  type Cadence,
  type Category,
  type Channel,
  type Locale,
  type Priority,
  type SuppressionReason,
} from './model.ts'
import { nextDigestWindow, periodName, resolveRouting, type Route } from './routing.ts'
import {
  claimDeliveries,
  deliveriesFor,
  eraseUser,
  getBroadcast,
  insertDeliveries,
  insertNotification,
  joinDigest,
  listPreferences,
  markBroadcastFannedOut,
  markDeliveryFailed,
  markDeliverySent,
  markDigestFlushed,
  dueDigests,
  reachableUsers,
  targetsFor,
  withInbox,
  type ChannelTarget,
  type Db,
  type Tx,
} from './store.ts'
import { isTemplateId, renderTemplate, templateFor, type TemplateId } from './templates.ts'

export interface PipelineDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly adapters: AdapterRegistry
  /** `NOTIFY_PUBLIC_URL`. Never a request's Host header — see `env.ts`. */
  readonly publicUrl: string
  readonly maxAttempts: number
  readonly instanceId: string
  /** Test seams. Production passes neither. */
  readonly now?: () => Date
  readonly backoff?: (attempt: number) => number
  readonly leaseMs?: number
}

const clockOf = (deps: PipelineDeps): Date => (deps.now ? deps.now() : new Date())

/* ------------------------------------------------------------------ creating a notification */

export interface NotificationRequest {
  readonly userId: string
  readonly category: Category
  readonly priority: Priority
  readonly templateId: TemplateId
  readonly params: Record<string, unknown>
  readonly dedupeKey: string | null
  readonly subjectUrn: string | null
  readonly locale: Locale
  readonly sourceTopic: string | null
  readonly sourceEventId: string | null
  readonly correlationId: string | null
}

export type CreateOutcome =
  | { readonly kind: 'created'; readonly notificationId: string; readonly routes: readonly Route[] }
  | { readonly kind: 'suppressed'; readonly reason: SuppressionReason }

/**
 * Route, write the notification, and write the deliveries — all in the caller's transaction.
 *
 * The ordering is the substance. Routing happens **before** the insert, because
 * `notifications.channel_count` carries a CHECK that a critical notification reached at least one
 * channel: the database cannot enforce §10.3 unless the count is known at insert time. Writing
 * the row first and updating the count afterwards would leave a window in which a critical
 * notification legally exists with no channels, and windows like that are what a crash finds.
 */
export async function createNotification(
  tx: Tx,
  deps: PipelineDeps,
  request: NotificationRequest,
): Promise<CreateOutcome> {
  const targets = await targetsFor(tx, request.userId)
  const preferences = await listPreferences(tx, request.userId)
  const available = channelsAvailable(targets)

  const routing = resolveRouting({
    priority: request.priority,
    category: request.category,
    availableChannels: available,
    preferences,
  })

  if (routing.kind === 'suppressed') {
    // Recorded, not discarded. A user asking "why did I not get told" needs a row that says so,
    // and the preference page needs to be able to show what it is currently hiding.
    await insertNotification(tx, {
      ...request,
      channelCount: 0,
      suppressedReason: routing.reason,
    })
    deps.metrics.increment(SUPPRESSED_TOTAL, { reason: routing.reason })
    return { kind: 'suppressed', reason: routing.reason }
  }

  const notification = await insertNotification(tx, {
    ...request,
    channelCount: routing.routes.length,
    suppressedReason: null,
  })
  if (!notification) {
    // The unique index on (user_id, dedupe_key) won. Another event already described this fact.
    deps.metrics.increment(SUPPRESSED_TOTAL, { reason: 'duplicate' })
    return { kind: 'suppressed', reason: 'duplicate' }
  }

  const instant = deliveriesFor(
    notification.id,
    request.userId,
    routing.routes,
    targets,
    deps.maxAttempts,
  )
  await insertDeliveries(tx, instant)

  const now = clockOf(deps)
  for (const route of routing.routes) {
    if (route.when === 'instant') continue
    await joinDigest(tx, {
      userId: request.userId,
      channel: route.channel,
      cadence: route.when,
      scheduledFor: nextDigestWindow(route.when, now),
      notificationId: notification.id,
    })
  }

  deps.metrics.increment(NOTIFICATIONS_TOTAL, {
    category: request.category,
    priority: request.priority,
  })
  return { kind: 'created', notificationId: notification.id, routes: routing.routes }
}

/**
 * Which channels this user can be reached on.
 *
 * The floor channel is unconditional; everything else needs an address. Routing to a channel with
 * no address would create a delivery that can only ever fail `no_address`, which is noise in the
 * dead-letter view rather than information about anything.
 */
function channelsAvailable(targets: readonly ChannelTarget[]): Channel[] {
  const channels = new Set<Channel>([FLOOR_CHANNEL])
  for (const target of targets) channels.add(target.channel)
  return [...channels]
}

/* ------------------------------------------------------------------ ingest */

export type IngestOutcome =
  | { readonly kind: 'duplicate_event' }
  | { readonly kind: 'erased'; readonly notifications: number }
  | { readonly kind: 'ignored'; readonly reason: SuppressionReason }
  | {
      readonly kind: 'processed'
      readonly created: readonly string[]
      readonly suppressed: readonly SuppressionReason[]
    }

/**
 * Map one inbound event onto notifications.
 *
 * Everything happens inside `withInbox`, so the inbox row, the notifications and the delivery
 * rows commit together. A handler that throws leaves no inbox row and the redelivery is processed
 * rather than swallowed — the property that makes at-least-once delivery safe.
 */
export async function ingestEvent(
  deps: PipelineDeps,
  event: InboundEvent,
): Promise<IngestOutcome> {
  const outcome = await withInbox(deps.sql, event.topic, event.id, async (tx) => {
    if (ERASURE_TOPICS.has(event.topic)) {
      const userId =
        typeof event.payload['user_id'] === 'string'
          ? (event.payload['user_id'] as string)
          : event.key
      const removed = await eraseUser(tx, userId)
      deps.logger.info('user erased', { topic: event.topic, notifications: removed })
      return { kind: 'erased', notifications: removed } satisfies IngestOutcome
    }

    const rule = ruleFor(event.topic)
    if (!rule) {
      deps.metrics.increment(SUPPRESSED_TOTAL, { reason: 'no_rule' })
      return { kind: 'ignored', reason: 'no_rule' } satisfies IngestOutcome
    }

    const set = rule.recipients(event)
    if (set.kind === 'none') {
      deps.metrics.increment(SUPPRESSED_TOTAL, { reason: set.reason })
      return { kind: 'ignored', reason: set.reason } satisfies IngestOutcome
    }

    // Resolved from the EVENT, not read off the rule: one topic can carry two facts, and
    // `settlement.outbound.failed` is the one that does — `refundable` decides whether this is a
    // critical "your money is held" or a high "it is coming back". See `Variant` in catalogue.ts.
    const outcome = outcomeOf(rule, event)

    const created: string[] = []
    const suppressed: SuppressionReason[] = []
    for (const recipient of set.recipients) {
      const result = await createNotification(tx, deps, requestFor(event, rule.category, outcome.priority, outcome.templateId, recipient))
      if (result.kind === 'created') created.push(result.notificationId)
      else suppressed.push(result.reason)
    }
    return { kind: 'processed', created, suppressed } satisfies IngestOutcome
  })

  if (outcome.status === 'duplicate') return { kind: 'duplicate_event' }
  return outcome.value
}

function requestFor(
  event: InboundEvent,
  category: Category,
  priority: Priority,
  templateId: TemplateId,
  recipient: Recipient,
): NotificationRequest {
  return {
    userId: recipient.userId,
    category,
    priority,
    templateId,
    params: recipient.params,
    dedupeKey: recipient.dedupeKey,
    subjectUrn: recipient.subjectUrn,
    locale: resolveLocale(
      typeof event.payload['locale'] === 'string' ? (event.payload['locale'] as string) : null,
    ),
    sourceTopic: event.topic,
    sourceEventId: event.id,
    correlationId: event.correlationId,
  }
}

/* ------------------------------------------------------------------ dispatch */

export interface DispatchSummary {
  readonly claimed: number
  readonly sent: number
  readonly retried: number
  readonly dead: number
  readonly undeliverable: number
}

/**
 * Send whatever is due.
 *
 * One pass. Called from a leased job (`jobs.ts`), never from a timer — rule 8. The lease on each
 * row means two dispatchers running at once is safe rather than merely unlikely.
 *
 * A failing adapter never throws out of here: one dead endpoint must not stop the rest of the
 * batch, and the delivery row is the durable record that the next pass will retry.
 */
export async function dispatchDue(deps: PipelineDeps, limit: number): Promise<DispatchSummary> {
  const leaseMs = deps.leaseMs ?? 60_000
  const backoff = deps.backoff ?? backoffFor
  const claimed = await claimDeliveries(deps.sql, deps.instanceId, limit, leaseMs)

  let sent = 0
  let retried = 0
  let dead = 0
  let undeliverable = 0

  for (const delivery of claimed) {
    const adapter = deps.adapters.get(delivery.channel)
    if (!adapter) {
      // A channel with no adapter registered is the same situation as a channel with no
      // credentials: nothing can send it, and no retry will change that.
      await markDeliveryFailed(deps.sql, delivery.id, {
        reason: 'no_transport',
        retryable: false,
        detail: `no adapter registered for ${delivery.channel}`,
        backoffMs: 0,
      })
      deps.metrics.increment(FAILED_TOTAL, { channel: delivery.channel, reason: 'no_transport' })
      undeliverable += 1
      continue
    }

    const message = messageFor(deps, delivery)
    let outcome
    try {
      outcome = await adapter.send(message)
    } catch (err) {
      // An adapter that throws is an adapter with a bug. Treated as a retryable upstream error
      // rather than allowed to abort the batch, because the alternative is one malformed message
      // stopping every other delivery in the estate.
      outcome = {
        ok: false as const,
        reason: 'upstream_error' as const,
        retryable: true,
        detail: err instanceof Error ? err.message : String(err),
      }
    }

    if (outcome.ok) {
      await markDeliverySent(deps.sql, delivery.id, outcome.providerRef ?? null)
      deps.metrics.increment(SENT_TOTAL, { channel: delivery.channel, category: delivery.category })
      deps.metrics.observe(
        DELIVERY_LATENCY_MS,
        Math.max(0, clockOf(deps).getTime() - Date.parse(delivery.notificationCreatedAt)),
      )
      sent += 1
      continue
    }

    const state = await markDeliveryFailed(deps.sql, delivery.id, {
      reason: outcome.reason,
      retryable: outcome.retryable,
      detail: outcome.detail,
      backoffMs: backoff(delivery.attempts),
    })
    deps.metrics.increment(FAILED_TOTAL, { channel: delivery.channel, reason: outcome.reason })
    if (state === 'dead') {
      deps.metrics.increment(DEADLETTER_TOTAL)
      dead += 1
      // Logged at error because a dead delivery is work that was requested and never done. The
      // notification id is here so an operator can find what was not said; the body is not.
      deps.logger.error('delivery dead-lettered', {
        deliveryId: delivery.id,
        notificationId: delivery.notificationId,
        channel: delivery.channel,
        reason: outcome.reason,
        attempts: delivery.attempts,
      })
    } else if (state === 'undeliverable') {
      undeliverable += 1
      // Info, not error. `no_transport` on a deployment with no SMTP is a configuration choice.
      deps.logger.info('delivery undeliverable', {
        deliveryId: delivery.id,
        channel: delivery.channel,
        reason: outcome.reason,
      })
    } else {
      retried += 1
    }
  }

  return { claimed: claimed.length, sent, retried, dead, undeliverable }
}

/**
 * Build the message an adapter sends.
 *
 * A delivery whose template no longer exists renders as its own template id rather than throwing.
 * A template can be removed by a deploy while deliveries referencing it are still pending, and
 * the correct answer to that is a slightly ugly notification, not a poisoned queue.
 */
function messageFor(
  deps: PipelineDeps,
  delivery: {
    id: string
    notificationId: string
    userId: string
    channel: Channel
    address: string | null
    secret: string | null
    category: Category
    priority: Priority
    templateId: string
    params: Record<string, unknown>
    locale: Locale
    notificationCreatedAt: string
  },
): OutboundMessage {
  const template = isTemplateId(delivery.templateId) ? templateFor(delivery.templateId) : null
  const rendered = template
    ? renderTemplate(template, delivery.params, delivery.locale, deps.publicUrl)
    : {
        subject: delivery.templateId,
        body: delivery.templateId,
        link: deps.publicUrl,
        missing: [] as readonly string[],
      }

  if (rendered.missing.length > 0) {
    // Names only. A template parameter is arbitrary domain data — an address, an amount, a device
    // — and the estate has already been burned once by putting a live credential in a log line.
    deps.logger.warn('template parameters missing', {
      templateId: delivery.templateId,
      missing: rendered.missing,
    })
  }

  return {
    deliveryId: delivery.id,
    notificationId: delivery.notificationId,
    userId: delivery.userId,
    channel: delivery.channel,
    category: delivery.category,
    priority: delivery.priority,
    templateId: delivery.templateId,
    address: delivery.address,
    secret: delivery.secret,
    subject: rendered.subject,
    body: rendered.body,
    link: rendered.link,
    params: delivery.params,
    createdAt: delivery.notificationCreatedAt,
  }
}

/* ------------------------------------------------------------------ digests */

export interface DigestSummary {
  readonly flushed: number
  readonly notifications: number
}

/**
 * Turn every batch whose window has passed into one delivery.
 *
 * The summary is itself a notification, with its own dedupe key derived from the digest id — so a
 * flush that is retried after a crash produces the same row rather than a second summary. Its
 * priority is `low` and its category `system`, because a digest is by definition the thing the
 * user asked not to be interrupted by.
 */
export async function flushDueDigests(
  deps: PipelineDeps,
  limit: number,
): Promise<DigestSummary> {
  const now = clockOf(deps)
  const due = await dueDigests(deps.sql, now, limit)
  let notifications = 0

  for (const digest of due) {
    if (digest.items.length > 0) {
      await deps.sql.begin(async (tx) => {
        const summary = await insertNotification(tx, {
          userId: digest.userId,
          category: 'system',
          priority: 'low',
          templateId: 'digest.summary',
          params: {
            count: digest.items.length,
            period: periodName(digest.cadence),
            items: digest.items.map((item) => `• ${describe(item.templateId, item.params)}`).join('\n'),
          },
          locale: digest.items[0]?.locale ?? 'en-GB',
          // Derived from the digest id, so a retried flush is idempotent.
          dedupeKey: `digest:${digest.id}`,
          subjectUrn: null,
          sourceTopic: null,
          sourceEventId: null,
          correlationId: null,
          channelCount: 1,
          suppressedReason: null,
        })
        if (!summary) return
        // Delivered on the channel whose preference asked for the digest, not re-routed: the user
        // said "batch my email", so the batch goes by email.
        const targets = (await targetsFor(tx, digest.userId)).filter(
          (target) => target.channel === digest.channel,
        )
        await insertDeliveries(
          tx,
          deliveriesFor(
            summary.id,
            digest.userId,
            [{ channel: digest.channel, when: 'instant' }],
            targets,
            deps.maxAttempts,
          ),
        )
        notifications += 1
      })
    }
    await markDigestFlushed(deps.sql, digest.id)
  }

  return { flushed: due.length, notifications }
}

/** One line per batched notification. Subjects, not bodies: a digest is an index, not a reprint. */
function describe(templateId: string, params: Record<string, unknown>): string {
  if (!isTemplateId(templateId)) return templateId
  const template = templateFor(templateId)
  const text = template.text['en-GB']
  return text.subject.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? '' : String(value)
  })
}

/* ------------------------------------------------------------------ broadcasts */

export interface BroadcastSummary {
  readonly recipients: number
  readonly created: number
}

/**
 * Fan an operator broadcast out to every reachable user.
 *
 * Paged by user id so a broadcast to a large estate is a sequence of bounded transactions rather
 * than one that holds a snapshot open for minutes. Each user's notification goes through
 * `createNotification`, which means a broadcast respects preferences exactly as an event-driven
 * notification does — including the §10.3 exception if an operator sends one at `critical`.
 */
export async function fanOutBroadcast(
  deps: PipelineDeps,
  broadcastId: string,
  pageSize = 200,
): Promise<BroadcastSummary> {
  const broadcast = await getBroadcast(deps.sql, broadcastId)
  if (!broadcast) throw new Error(`no broadcast ${broadcastId}`)
  if (!isTemplateId(broadcast.templateId)) {
    throw new Error(`broadcast ${broadcastId} names an unknown template`)
  }
  const templateId: TemplateId = broadcast.templateId

  let recipients = 0
  let created = 0
  let after: string | null = null

  for (;;) {
    const users: string[] =
      broadcast.audience === 'listed'
        ? [...broadcast.userIds].filter((id) => after === null || id > after).sort().slice(0, pageSize)
        : await reachableUsers(deps.sql, pageSize, after)
    if (users.length === 0) break

    await deps.sql.begin(async (tx) => {
      for (const userId of users) {
        const result = await createNotification(tx, deps, {
          userId,
          category: broadcast.category,
          priority: broadcast.priority,
          templateId,
          params: broadcast.params,
          // One per user per broadcast. A re-run of the fan-out after a crash produces nothing
          // new, which is what makes this job safe to retry.
          dedupeKey: broadcast.dedupeKey,
          subjectUrn: `cf:notify:broadcast:${broadcast.id}`,
          locale: 'en-GB',
          sourceTopic: null,
          sourceEventId: null,
          correlationId: broadcast.id,
        })
        recipients += 1
        if (result.kind === 'created') created += 1
      }
    })

    after = users[users.length - 1] ?? null
    if (users.length < pageSize) break
  }

  await markBroadcastFannedOut(deps.sql, broadcastId, recipients)
  return { recipients, created }
}

/** Re-exported so `jobs.ts` and the tests share one spelling of the cadence type. */
export type { Cadence }
