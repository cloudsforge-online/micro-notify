/**
 * Everything that touches Postgres.
 *
 * The HTTP layer and the job handlers depend on the interfaces at the top of this file, never on
 * the pool — so a route can be tested without a database and this file can be tested without a
 * socket. That split is the service template's convention and it is the reason `server.test.ts`
 * runs with no `NOTIFY_TEST_DATABASE_URL`.
 *
 * Two mechanisms in here carry more weight than the rest:
 *
 *   - **`withInbox`** makes at-least-once delivery effectively-once. The inbox insert and the
 *     handler share one transaction, so a handler that throws leaves no inbox row and the
 *     redelivery is processed rather than swallowed. "Record then handle" is the version of this
 *     that loses events, and it is the version people write first.
 *   - **`claimDeliveries`** leases rows with `for update skip locked`. A delivery being sent by
 *     one replica is skipped by another rather than waited on, which is what lets the dispatcher
 *     scale past one process — the defect rule 8 exists to stop.
 */

import type { Sql, TransactionSql } from 'postgres'
import type {
  Cadence,
  Category,
  Channel,
  DeliveryState,
  Digest,
  FailureReason,
  Locale,
  Priority,
  SuppressionReason,
} from './model.ts'
import type { Preference, Route } from './routing.ts'

export type Db = Sql
export type Tx = TransactionSql

/* ------------------------------------------------------------------ inbox */

export type InboxOutcome<T> =
  | { readonly status: 'processed'; readonly value: T }
  | { readonly status: 'duplicate' }

/**
 * Run an inbound event's handler exactly once.
 *
 * The insert and the handler share one transaction, so a handler that fails leaves no inbox row
 * and the redelivery is processed rather than swallowed — which is the mistake that makes a naive
 * "record then handle" dedupe lose events. AD-10.
 */
export async function withInbox<T>(
  sql: Db,
  topic: string,
  eventId: string,
  handle: (tx: Tx) => Promise<T>,
): Promise<InboxOutcome<T>> {
  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${topic}, ${eventId})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) return { result: { status: 'duplicate' } as InboxOutcome<T> }
    const value = await handle(tx)
    return { result: { status: 'processed', value } as InboxOutcome<T> }
  })
  return outcome.result
}

/* ------------------------------------------------------------------ notifications */

export interface Notification {
  readonly id: string
  readonly userId: string
  readonly category: Category
  readonly priority: Priority
  readonly templateId: string
  readonly params: Record<string, unknown>
  readonly locale: Locale
  readonly dedupeKey: string | null
  readonly subjectUrn: string | null
  readonly channelCount: number
  readonly suppressedReason: SuppressionReason | null
  readonly createdAt: string
  readonly readAt: string | null
}

export interface CreateNotification {
  readonly userId: string
  readonly category: Category
  readonly priority: Priority
  readonly templateId: string
  readonly params: Record<string, unknown>
  readonly locale: Locale
  readonly dedupeKey: string | null
  readonly subjectUrn: string | null
  readonly sourceTopic: string | null
  readonly sourceEventId: string | null
  readonly correlationId: string | null
  /**
   * How many channels the routing decision reached. Passed in rather than counted afterwards,
   * because the CHECK constraint on this column is what enforces §10.3 — a critical notification
   * whose routing produced nothing is rejected by the database at insert time, not discovered by
   * a later query.
   */
  readonly channelCount: number
  readonly suppressedReason: SuppressionReason | null
}

interface NotificationRow {
  readonly id: string
  readonly user_id: string
  readonly category: string
  readonly priority: string
  readonly template_id: string
  readonly params: Record<string, unknown>
  readonly locale: string
  readonly dedupe_key: string | null
  readonly subject_urn: string | null
  readonly channel_count: number
  readonly suppressed_reason: string | null
  readonly created_at: Date
  readonly read_at: Date | null
}

const toNotification = (row: NotificationRow): Notification => ({
  id: row.id,
  userId: row.user_id,
  category: row.category as Category,
  priority: row.priority as Priority,
  templateId: row.template_id,
  params: row.params,
  locale: row.locale as Locale,
  dedupeKey: row.dedupe_key,
  subjectUrn: row.subject_urn,
  channelCount: row.channel_count,
  suppressedReason: row.suppressed_reason as SuppressionReason | null,
  createdAt: row.created_at.toISOString(),
  readAt: row.read_at ? row.read_at.toISOString() : null,
})

/**
 * Insert a notification, or recognise that one already exists for this `(user, dedupe_key)`.
 *
 * `on conflict do nothing` returning zero rows is the second layer of deduplication: the inbox
 * stops a redelivered *event*, this stops a second *description of the same fact* — a new device
 * that produces both `identity.session.created` and `identity.device.added`.
 */
export async function insertNotification(
  tx: Tx,
  input: CreateNotification,
): Promise<Notification | null> {
  const rows = await tx<NotificationRow[]>`
    insert into notifications (
      user_id, category, priority, template_id, params, locale,
      dedupe_key, subject_urn, source_topic, source_event_id, correlation_id,
      channel_count, suppressed_reason
    ) values (
      ${input.userId}, ${input.category}, ${input.priority}, ${input.templateId},
      ${tx.json(input.params as Record<string, never>)}, ${input.locale},
      ${input.dedupeKey}, ${input.subjectUrn}, ${input.sourceTopic}, ${input.sourceEventId},
      ${input.correlationId}, ${input.channelCount}, ${input.suppressedReason}
    )
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
    returning id, user_id, category, priority, template_id, params, locale, dedupe_key,
              subject_urn, channel_count, suppressed_reason, created_at, read_at
  `
  const row = rows[0]
  return row ? toNotification(row) : null
}

export interface NotificationPage {
  readonly notifications: readonly Notification[]
  /** Opaque. Pass back as `?cursor=` for the next page. Null when there is no next page. */
  readonly nextCursor: string | null
  readonly unread: number
}

/**
 * A page of a user's notifications, newest first.
 *
 * Keyset paged on `(created_at, id)` rather than offset. An offset pager re-reads every skipped
 * row on every page, and — worse — shifts under the user when a notification arrives mid-scroll,
 * so page two silently omits an item. Neither is acceptable on a feed whose whole purpose is that
 * nothing is missed.
 */
export async function listNotifications(
  sql: Db,
  userId: string,
  options: { readonly limit: number; readonly cursor: string | null; readonly unreadOnly: boolean },
): Promise<NotificationPage> {
  const cursor = decodeCursor(options.cursor)
  const rows = await sql<NotificationRow[]>`
    select id, user_id, category, priority, template_id, params, locale, dedupe_key,
           subject_urn, channel_count, suppressed_reason, created_at, read_at
      from notifications
     where user_id = ${userId}
       and (${options.unreadOnly} = false or read_at is null)
       and (
         ${cursor === null}
         or (created_at, id) < (${cursor?.createdAt ?? new Date()}, ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid)
       )
     order by created_at desc, id desc
     limit ${options.limit + 1}
  `
  const page = rows.slice(0, options.limit).map(toNotification)
  const last = rows.length > options.limit ? page[page.length - 1] : undefined
  const unread = await countUnread(sql, userId)
  return {
    notifications: page,
    nextCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    unread,
  }
}

export async function countUnread(sql: Db, userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from notifications where user_id = ${userId} and read_at is null
  `
  return rows[0]?.n ?? 0
}

/**
 * Mark one notification read.
 *
 * Scoped by `user_id` in the WHERE clause rather than checked afterwards: an authorisation check
 * that runs after the row is fetched is one `if` away from being a way to read someone else's
 * notification by guessing a UUID.
 */
export async function markRead(sql: Db, userId: string, id: string): Promise<Notification | null> {
  const rows = await sql<NotificationRow[]>`
    update notifications
       set read_at = coalesce(read_at, now())
     where id = ${id} and user_id = ${userId}
    returning id, user_id, category, priority, template_id, params, locale, dedupe_key,
              subject_urn, channel_count, suppressed_reason, created_at, read_at
  `
  const row = rows[0]
  return row ? toNotification(row) : null
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const separator = decoded.lastIndexOf('|')
  if (separator < 0) return null
  const createdAt = new Date(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)
  if (Number.isNaN(createdAt.getTime()) || !id) return null
  return { createdAt, id }
}

/* ------------------------------------------------------------------ preferences */

interface PreferenceRow {
  readonly category: string
  readonly channel: string
  readonly enabled: boolean
  readonly digest: string
  readonly min_priority: string
}

const toPreference = (row: PreferenceRow): Preference => ({
  category: row.category as Category,
  channel: row.channel as Channel,
  enabled: row.enabled,
  digest: row.digest as Digest,
  minPriority: row.min_priority as Priority,
})

export async function listPreferences(sql: Db | Tx, userId: string): Promise<Preference[]> {
  const rows = await sql<PreferenceRow[]>`
    select category, channel, enabled, digest, min_priority
      from preferences where user_id = ${userId}
  `
  return rows.map(toPreference)
}

/**
 * Upsert a set of preferences.
 *
 * A partial update by design: the page sends the rows it changed. Replacing the whole set would
 * mean a client on an older build, which does not know about a channel added last week, silently
 * resetting that channel to its default.
 */
export async function upsertPreferences(
  sql: Db,
  userId: string,
  preferences: readonly Preference[],
): Promise<Preference[]> {
  await sql.begin(async (tx) => {
    for (const preference of preferences) {
      await tx`
        insert into preferences (user_id, category, channel, enabled, digest, min_priority, updated_at)
        values (${userId}, ${preference.category}, ${preference.channel}, ${preference.enabled},
                ${preference.digest}, ${preference.minPriority}, now())
        on conflict (user_id, category, channel) do update
          set enabled = excluded.enabled,
              digest = excluded.digest,
              min_priority = excluded.min_priority,
              updated_at = now()
      `
    }
  })
  return listPreferences(sql, userId)
}

/* ------------------------------------------------------------------ channel targets */

export interface ChannelTarget {
  readonly id: string
  readonly channel: Channel
  readonly address: string
  readonly secret: string | null
  readonly label: string | null
}

interface TargetRow {
  readonly id: string
  readonly channel: string
  readonly address: string
  readonly secret: string | null
  readonly label: string | null
}

/**
 * Where this user can be reached.
 *
 * `secret` is selected because the webhook adapter needs it to sign. It is never put in a log
 * line, never returned by a route, and never included in an error — see `webhook.ts`.
 */
export async function targetsFor(sql: Db | Tx, userId: string): Promise<ChannelTarget[]> {
  const rows = await sql<TargetRow[]>`
    select id, channel, address, secret, label
      from channel_targets
     where user_id = ${userId} and active
     order by channel, created_at
  `
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel as Channel,
    address: row.address,
    secret: row.secret,
    label: row.label,
  }))
}

export async function upsertTarget(
  sql: Db | Tx,
  input: {
    readonly userId: string
    readonly channel: Channel
    readonly address: string
    readonly secret?: string | null
    readonly label?: string | null
  },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into channel_targets (user_id, channel, address, secret, label)
    values (${input.userId}, ${input.channel}, ${input.address}, ${input.secret ?? null}, ${input.label ?? null})
    on conflict (user_id, channel, address) do update
      set active = true, secret = coalesce(excluded.secret, channel_targets.secret),
          label = coalesce(excluded.label, channel_targets.label)
    returning id
  `
  const row = rows[0]
  if (!row) throw new Error('upsert returned no row')
  return row.id
}

/* ------------------------------------------------------------------ deliveries */

export interface CreateDelivery {
  readonly notificationId: string
  readonly userId: string
  readonly channel: Channel
  readonly targetId: string | null
  readonly maxAttempts: number
}

export async function insertDeliveries(
  tx: Tx,
  deliveries: readonly CreateDelivery[],
): Promise<number> {
  let created = 0
  for (const delivery of deliveries) {
    await tx`
      insert into deliveries (notification_id, user_id, channel, target_id, max_attempts)
      values (${delivery.notificationId}, ${delivery.userId}, ${delivery.channel},
              ${delivery.targetId}, ${delivery.maxAttempts})
    `
    created += 1
  }
  return created
}

/** A delivery, joined to everything the adapter needs to render and address it. */
export interface ClaimedDelivery {
  readonly id: string
  readonly notificationId: string
  readonly userId: string
  readonly channel: Channel
  readonly attempts: number
  readonly maxAttempts: number
  readonly address: string | null
  readonly secret: string | null
  readonly category: Category
  readonly priority: Priority
  readonly templateId: string
  readonly params: Record<string, unknown>
  readonly locale: Locale
  readonly notificationCreatedAt: string
}

interface ClaimedRow {
  readonly id: string
  readonly notification_id: string
  readonly user_id: string
  readonly channel: string
  readonly attempts: number
  readonly max_attempts: number
  readonly address: string | null
  readonly secret: string | null
  readonly category: string
  readonly priority: string
  readonly template_id: string
  readonly params: Record<string, unknown>
  readonly locale: string
  readonly notification_created_at: Date
}

/**
 * Claim due deliveries under a lease.
 *
 * `for update skip locked` is what makes this safe with N replicas: a row already being claimed
 * by another transaction is skipped rather than waited on, so dispatchers never serialise and
 * never hand one delivery to two processes. `attempts` is incremented at claim time, not at
 * failure time — a process that dies mid-send has still used an attempt, which is what stops a
 * delivery that reliably crashes its worker from being retried for ever.
 */
export async function claimDeliveries(
  sql: Db,
  owner: string,
  limit: number,
  leaseMs: number,
): Promise<ClaimedDelivery[]> {
  const rows = await sql<ClaimedRow[]>`
    with due as (
      select id from deliveries
       where state = 'pending'
         and next_attempt_at <= now()
         and (leased_until is null or leased_until < now())
       order by next_attempt_at
       limit ${limit}
       for update skip locked
    ), leased as (
      update deliveries d
         set leased_by = ${owner},
             leased_until = now() + (${String(leaseMs)} || ' milliseconds')::interval,
             attempts = d.attempts + 1
        from due
       where d.id = due.id
      returning d.id, d.notification_id, d.user_id, d.channel, d.target_id, d.attempts, d.max_attempts
    )
    select l.id, l.notification_id, l.user_id, l.channel, l.attempts, l.max_attempts,
           t.address, t.secret,
           n.category, n.priority, n.template_id, n.params, n.locale,
           n.created_at as notification_created_at
      from leased l
      join notifications n on n.id = l.notification_id
      left join channel_targets t on t.id = l.target_id
  `
  return rows.map((row) => ({
    id: row.id,
    notificationId: row.notification_id,
    userId: row.user_id,
    channel: row.channel as Channel,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    address: row.address,
    secret: row.secret,
    category: row.category as Category,
    priority: row.priority as Priority,
    templateId: row.template_id,
    params: row.params,
    locale: row.locale as Locale,
    notificationCreatedAt: row.notification_created_at.toISOString(),
  }))
}

export async function markDeliverySent(
  sql: Db,
  id: string,
  providerRef: string | null,
): Promise<void> {
  await sql`
    update deliveries
       set state = 'sent', sent_at = now(), leased_by = null, leased_until = null,
           last_error = null, reason = null, provider_ref = ${providerRef}
     where id = ${id}
  `
}

/**
 * Record a failed attempt.
 *
 * Three outcomes, and the difference between them is the whole retry policy:
 *
 *   - **not retryable** → `undeliverable`, immediately. `no_transport` is the common case, and it
 *     is not an error: there is no configured way to send, and no number of retries will invent
 *     one. The row is retained.
 *   - **retryable, budget left** → stays `pending` with `next_attempt_at` pushed out by the
 *     caller's backoff. There is deliberately no `failed` state: a state meaning "failed but will
 *     be retried" is one two queries will disagree about.
 *   - **retryable, budget spent** → `dead`. Retained, because the row is the only durable record
 *     that this was requested and never done, and an operator needs to find it.
 */
export async function markDeliveryFailed(
  sql: Db,
  id: string,
  input: {
    readonly reason: FailureReason
    readonly retryable: boolean
    readonly detail: string
    readonly backoffMs: number
  },
): Promise<DeliveryState> {
  const rows = await sql<{ state: string }[]>`
    update deliveries
       set leased_by = null,
           leased_until = null,
           reason = ${input.reason},
           last_error = ${input.detail.slice(0, 2_000)},
           state = case
                     when ${input.retryable} = false then 'undeliverable'
                     when attempts >= max_attempts then 'dead'
                     else 'pending'
                   end,
           next_attempt_at = case
                     when ${input.retryable} = true and attempts < max_attempts
                       then now() + (${String(input.backoffMs)} || ' milliseconds')::interval
                     else next_attempt_at
                   end
     where id = ${id}
    returning state
  `
  return (rows[0]?.state ?? 'pending') as DeliveryState
}

export interface DeliveryHistoryRow {
  readonly id: string
  readonly notificationId: string
  readonly userId: string
  readonly channel: Channel
  readonly state: DeliveryState
  /** `undeliverable_no_transport`, `dead_upstream_error`, `sent`, `pending` — one column. */
  readonly outcome: string
  readonly reason: FailureReason | null
  readonly attempts: number
  readonly maxAttempts: number
  readonly lastError: string | null
  readonly category: Category
  readonly priority: Priority
  readonly templateId: string
  readonly createdAt: string
  readonly nextAttemptAt: string
  readonly sentAt: string | null
}

/**
 * The dead-letter view. One view over every channel, developer webhooks included — AD-08.
 *
 * Defaults to the terminal states, because that is the question an operator is asking. `state`
 * widens it when the question is "is anything stuck".
 */
export async function listDeliveries(
  sql: Db,
  options: {
    readonly states: readonly DeliveryState[]
    readonly channel: Channel | null
    readonly limit: number
    readonly cursor: string | null
  },
): Promise<{ readonly deliveries: readonly DeliveryHistoryRow[]; readonly nextCursor: string | null }> {
  const cursor = decodeCursor(options.cursor)
  const rows = await sql<
    Array<{
      id: string
      notification_id: string
      user_id: string
      channel: string
      state: string
      outcome: string
      reason: string | null
      attempts: number
      max_attempts: number
      last_error: string | null
      category: string
      priority: string
      template_id: string
      created_at: Date
      next_attempt_at: Date
      sent_at: Date | null
    }>
  >`
    select d.id, d.notification_id, d.user_id, d.channel, d.state, d.outcome, d.reason,
           d.attempts, d.max_attempts, d.last_error, d.created_at, d.next_attempt_at, d.sent_at,
           n.category, n.priority, n.template_id
      from deliveries d
      join notifications n on n.id = d.notification_id
     where d.state = any(${options.states as string[]})
       and (${options.channel === null} or d.channel = ${options.channel ?? ''})
       and (
         ${cursor === null}
         or (d.created_at, d.id) < (${cursor?.createdAt ?? new Date()}, ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid)
       )
     order by d.created_at desc, d.id desc
     limit ${options.limit + 1}
  `
  const page = rows.slice(0, options.limit).map((row) => ({
    id: row.id,
    notificationId: row.notification_id,
    userId: row.user_id,
    channel: row.channel as Channel,
    state: row.state as DeliveryState,
    outcome: row.outcome,
    reason: row.reason as FailureReason | null,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    category: row.category as Category,
    priority: row.priority as Priority,
    templateId: row.template_id,
    createdAt: row.created_at.toISOString(),
    nextAttemptAt: row.next_attempt_at.toISOString(),
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
  }))
  const last = rows.length > options.limit ? page[page.length - 1] : undefined
  return { deliveries: page, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null }
}

/** For `notify_deadletter_total` and the readiness of an operator to be told about a backlog. */
export async function deliveryStats(
  sql: Db,
): Promise<{ pending: number; dead: number; undeliverable: number; overdue: number }> {
  const rows = await sql<
    Array<{ pending: number; dead: number; undeliverable: number; overdue: number }>
  >`
    select count(*) filter (where state = 'pending')::int as pending,
           count(*) filter (where state = 'dead')::int as dead,
           count(*) filter (where state = 'undeliverable')::int as undeliverable,
           count(*) filter (where state = 'pending' and next_attempt_at < now() - interval '5 minutes')::int as overdue
      from deliveries
  `
  return rows[0] ?? { pending: 0, dead: 0, undeliverable: 0, overdue: 0 }
}

/* ------------------------------------------------------------------ digests */

/**
 * Add a notification to the user's open batch for this channel and window, creating it if needed.
 *
 * `on conflict do update` rather than `do nothing` because the update has to return the id, and
 * a `do nothing` conflict returns no rows at all — which is the subtle way this kind of upsert
 * silently drops the second item in every batch.
 */
export async function joinDigest(
  tx: Tx,
  input: {
    readonly userId: string
    readonly channel: Channel
    readonly cadence: Cadence
    readonly scheduledFor: Date
    readonly notificationId: string
  },
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into digests (user_id, channel, cadence, scheduled_for)
    values (${input.userId}, ${input.channel}, ${input.cadence}, ${input.scheduledFor})
    on conflict (user_id, channel, cadence, scheduled_for) do update set state = digests.state
    returning id
  `
  const row = rows[0]
  if (!row) throw new Error('digest upsert returned no row')
  await tx`
    insert into digest_entries (digest_id, notification_id)
    values (${row.id}, ${input.notificationId})
    on conflict do nothing
  `
  return row.id
}

export interface DueDigest {
  readonly id: string
  readonly userId: string
  readonly channel: Channel
  readonly cadence: Cadence
  readonly items: readonly { readonly notificationId: string; readonly templateId: string; readonly params: Record<string, unknown>; readonly locale: Locale }[]
}

/**
 * Digests whose window has passed.
 *
 * `now` is a parameter rather than `now()` so a test can fire a window without waiting an hour
 * for it. Production passes the real clock; nothing else about the query changes.
 */
export async function dueDigests(sql: Db, now: Date, limit: number): Promise<DueDigest[]> {
  const digests = await sql<
    Array<{ id: string; user_id: string; channel: string; cadence: string }>
  >`
    select id, user_id, channel, cadence
      from digests
     where state = 'open' and scheduled_for <= ${now}
     order by scheduled_for
     limit ${limit}
     for update skip locked
  `
  const out: DueDigest[] = []
  for (const digest of digests) {
    const items = await sql<
      Array<{ notification_id: string; template_id: string; params: Record<string, unknown>; locale: string }>
    >`
      select e.notification_id, n.template_id, n.params, n.locale
        from digest_entries e
        join notifications n on n.id = e.notification_id
       where e.digest_id = ${digest.id}
       order by n.created_at
    `
    out.push({
      id: digest.id,
      userId: digest.user_id,
      channel: digest.channel as Channel,
      cadence: digest.cadence as Cadence,
      items: items.map((item) => ({
        notificationId: item.notification_id,
        templateId: item.template_id,
        params: item.params,
        locale: item.locale as Locale,
      })),
    })
  }
  return out
}

export async function markDigestFlushed(sql: Db, id: string): Promise<void> {
  await sql`update digests set state = 'flushed', flushed_at = now() where id = ${id}`
}

/** How many notifications are sitting in open digest batches. A gauge an operator watches. */
export async function openDigestCount(sql: Db): Promise<number> {
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from digests where state = 'open'`
  return rows[0]?.n ?? 0
}

/* ------------------------------------------------------------------ broadcasts */

export interface Broadcast {
  readonly id: string
  readonly category: Category
  readonly priority: Priority
  readonly templateId: string
  readonly params: Record<string, unknown>
  readonly audience: 'all' | 'listed'
  readonly userIds: readonly string[]
  readonly dedupeKey: string
  readonly createdBy: string
  readonly createdAt: string
  readonly recipients: number | null
}

interface BroadcastRow {
  readonly id: string
  readonly category: string
  readonly priority: string
  readonly template_id: string
  readonly params: Record<string, unknown>
  readonly audience: string
  readonly user_ids: string[]
  readonly dedupe_key: string
  readonly created_by: string
  readonly created_at: Date
  readonly recipients: number | null
}

const toBroadcast = (row: BroadcastRow): Broadcast => ({
  id: row.id,
  category: row.category as Category,
  priority: row.priority as Priority,
  templateId: row.template_id,
  params: row.params,
  audience: row.audience as 'all' | 'listed',
  userIds: row.user_ids,
  dedupeKey: row.dedupe_key,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  recipients: row.recipients,
})

export async function insertBroadcast(
  sql: Db,
  input: {
    readonly category: Category
    readonly priority: Priority
    readonly templateId: string
    readonly params: Record<string, unknown>
    readonly audience: 'all' | 'listed'
    readonly userIds: readonly string[]
    readonly dedupeKey: string
    readonly createdBy: string
  },
): Promise<Broadcast> {
  const rows = await sql<BroadcastRow[]>`
    insert into broadcasts (category, priority, template_id, params, audience, user_ids, dedupe_key, created_by)
    values (${input.category}, ${input.priority}, ${input.templateId},
            ${sql.json(input.params as Record<string, never>)}, ${input.audience},
            ${input.userIds as string[]}, ${input.dedupeKey}, ${input.createdBy})
    returning id, category, priority, template_id, params, audience, user_ids, dedupe_key,
              created_by, created_at, recipients
  `
  const row = rows[0]
  if (!row) throw new Error('broadcast insert returned no row')
  return toBroadcast(row)
}

export async function getBroadcast(sql: Db, id: string): Promise<Broadcast | null> {
  const rows = await sql<BroadcastRow[]>`
    select id, category, priority, template_id, params, audience, user_ids, dedupe_key,
           created_by, created_at, recipients
      from broadcasts where id = ${id}
  `
  const row = rows[0]
  return row ? toBroadcast(row) : null
}

export async function markBroadcastFannedOut(sql: Db, id: string, recipients: number): Promise<void> {
  await sql`
    update broadcasts set fanned_out_at = now(), recipients = ${recipients} where id = ${id}
  `
}

/**
 * Every user this service can reach.
 *
 * Notify is not the user registry. "Everyone" is the union of users with a delivery target and
 * users with a stored preference — which is every user who has ever been seen. Asking identity
 * for a full list would make a broadcast fail when identity is having a bad minute, which is
 * exactly when an operator most wants to send one.
 */
export async function reachableUsers(sql: Db, limit: number, after: string | null): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select user_id from (
      select user_id from channel_targets where active
      union
      select user_id from preferences
      union
      select user_id from notifications
    ) u
    where (${after === null} or user_id > ${after ?? '00000000-0000-0000-0000-000000000000'}::uuid)
    order by user_id
    limit ${limit}
  `
  return rows.map((row) => row.user_id)
}

/* ------------------------------------------------------------------ erasure */

/**
 * Delete everything this service holds about a user.
 *
 * `identity.user.deleted` has no subscriber anywhere in the estate today, which is why there is
 * no GDPR erasure path at all. Notify holds notification bodies, email addresses, phone numbers
 * and push tokens, so it is among the services that most need to honour it.
 *
 * Deliveries and digest entries go by cascade from `notifications`. The inbox row is deliberately
 * kept: it holds only `(topic, event_id)`, no personal data, and removing it would let a
 * redelivery of the deletion event run again against a user who no longer exists.
 */
export async function eraseUser(tx: Tx, userId: string): Promise<number> {
  const deleted = await tx<{ id: string }[]>`
    delete from notifications where user_id = ${userId} returning id
  `
  await tx`delete from channel_targets where user_id = ${userId}`
  await tx`delete from preferences where user_id = ${userId}`
  await tx`delete from digests where user_id = ${userId}`
  return deleted.length
}

/* ------------------------------------------------------------------ routes to deliveries */

/**
 * Turn a routing decision into the delivery rows it implies.
 *
 * Instant routes become deliveries; digest routes do not — they join a batch, and the batch
 * produces one delivery when its window fires. Both count towards `channel_count`, because both
 * are channels the notification reached; a digest is a delayed delivery, not a suppressed one.
 *
 * **One delivery per target, not per channel.** A user with two verified addresses on a channel,
 * or a developer with three registered webhook endpoints, gets one delivery each — with its own
 * attempts, its own backoff and its own dead-letter row. Collapsing them onto the first target
 * would mean one broken endpoint silently stopping delivery to the other two, which is the
 * failure the per-`(event, subscription)` delivery table in the outbox relay already exists to
 * avoid. `in_app` has no target row at all, so it produces exactly one.
 */
export function deliveriesFor(
  notificationId: string,
  userId: string,
  routes: readonly Route[],
  targets: readonly ChannelTarget[],
  maxAttempts: number,
): CreateDelivery[] {
  const byChannel = new Map<Channel, ChannelTarget[]>()
  for (const target of targets) {
    const existing = byChannel.get(target.channel)
    if (existing) existing.push(target)
    else byChannel.set(target.channel, [target])
  }
  const out: CreateDelivery[] = []
  for (const route of routes) {
    if (route.when !== 'instant') continue
    const forChannel = byChannel.get(route.channel) ?? []
    if (forChannel.length === 0) {
      out.push({ notificationId, userId, channel: route.channel, targetId: null, maxAttempts })
      continue
    }
    for (const target of forChannel) {
      out.push({ notificationId, userId, channel: route.channel, targetId: target.id, maxAttempts })
    }
  }
  return out
}

/* ------------------------------------------------------------------ the port the routes see */

/**
 * What the HTTP layer is allowed to do.
 *
 * Narrow on purpose: a route may not reach the pool, may not open a transaction and may not write
 * a delivery. Everything transactional — ingest, dispatch, digests, fan-out — lives in
 * `pipeline.ts` and is exercised by database tests, while the routes are exercised by
 * `server.test.ts` with a fake store and no database at all. That split is the service template's
 * convention, and it is the reason the route suite runs in CI without a Postgres service.
 */
export interface NotifyStore {
  listNotifications(
    userId: string,
    options: { readonly limit: number; readonly cursor: string | null; readonly unreadOnly: boolean },
  ): Promise<NotificationPage>
  markRead(userId: string, id: string): Promise<Notification | null>
  listPreferences(userId: string): Promise<Preference[]>
  upsertPreferences(userId: string, preferences: readonly Preference[]): Promise<Preference[]>
  insertBroadcast(input: {
    readonly category: Category
    readonly priority: Priority
    readonly templateId: string
    readonly params: Record<string, unknown>
    readonly audience: 'all' | 'listed'
    readonly userIds: readonly string[]
    readonly dedupeKey: string
    readonly createdBy: string
  }): Promise<Broadcast>
  listDeliveries(options: {
    readonly states: readonly DeliveryState[]
    readonly channel: Channel | null
    readonly limit: number
    readonly cursor: string | null
  }): Promise<{ readonly deliveries: readonly DeliveryHistoryRow[]; readonly nextCursor: string | null }>
}

export function postgresNotifyStore(sql: Db): NotifyStore {
  return {
    listNotifications: (userId, options) => listNotifications(sql, userId, options),
    markRead: (userId, id) => markRead(sql, userId, id),
    listPreferences: (userId) => listPreferences(sql, userId),
    upsertPreferences: (userId, preferences) => upsertPreferences(sql, userId, preferences),
    insertBroadcast: (input) => insertBroadcast(sql, input),
    listDeliveries: (options) => listDeliveries(sql, options),
  }
}
