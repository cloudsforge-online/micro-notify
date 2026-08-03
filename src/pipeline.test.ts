/**
 * The pipeline, against a real database.
 *
 * These are the tests the brief asks for by name, and they are database tests because every one
 * of them is about a guarantee the database itself enforces or a state it retains:
 *
 *   - a critical notification delivered with every preference disabled;
 *   - one notification from a redelivered event, and from two events describing one fact;
 *   - a failing channel that backs off, dead-letters, and keeps the row;
 *   - a digest that batches rather than sending, and fires on its window;
 *   - an unconfigured SMTP transport recorded as `undeliverable_no_transport`;
 *   - a developer webhook whose signature a receiver can verify.
 *
 * They skip without `NOTIFY_TEST_DATABASE_URL`, and the suite runs `--test-concurrency=1` because
 * `resetNotify` truncates.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type postgres from 'postgres'
import { SIGNATURE_HEADER, verifyDelivery } from '@cloudsforge/contracts-events'
import { CATEGORIES, CHANNELS } from './model.ts'
import { emailAdapter } from './email.ts'
import { webhookAdapter } from './webhook.ts'
import { dispatchDue, fanOutBroadcast, flushDueDigests, ingestEvent } from './pipeline.ts'
import {
  insertBroadcast,
  listDeliveries,
  listNotifications,
  upsertPreferences,
  upsertTarget,
} from './store.ts'
import type { Preference } from './routing.ts'
import {
  ALICE,
  BOB,
  enabled,
  migrateTestDb,
  openDb,
  counterValue,
  registeredEvent,
  resetNotify,
  skip,
  testRig,
  unregisteredEvent,
} from './testsupport.ts'

const WEBHOOK_SECRET = 'a-developer-webhook-secret-value'

/** Every category, every channel, switched off, muted and batched into oblivion. */
function everythingDisabled(): Preference[] {
  return CATEGORIES.flatMap((category) =>
    CHANNELS.map((channel) => ({
      category,
      channel,
      enabled: false,
      digest: 'off' as const,
      minPriority: 'critical' as const,
    })),
  )
}

describe('pipeline', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    if (!enabled) return
    sql = openDb()
    await migrateTestDb(sql)
  })

  beforeEach(async () => {
    if (!enabled) return
    await resetNotify(sql)
  })

  after(async () => {
    if (!enabled) return
    await sql.end({ timeout: 5 })
  })

  /* ---------------------------------------------------------------- the invariant */

  test('a critical notification is delivered with every preference disabled', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })
    await upsertTarget(sql, { userId: ALICE, channel: 'sms', address: '+441234567890' })

    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    assert.equal(outcome.kind, 'processed')
    if (outcome.kind !== 'processed') return
    assert.equal(outcome.created.length, 1)

    const rows = await sql<Array<{ priority: string; channel_count: number; suppressed_reason: string | null }>>`
      select priority, channel_count, suppressed_reason from notifications
    `
    assert.equal(rows[0]?.priority, 'critical')
    assert.equal(rows[0]?.suppressed_reason, null, 'a critical notification is never suppressed')
    assert.ok((rows[0]?.channel_count ?? 0) >= 1, '04-domain-model §10.3')

    const summary = await dispatchDue(rig.deps, 50)
    assert.equal(summary.sent, 3, 'in-app, email and SMS all went')
    assert.ok(rig.adapters.in_app.sent.length === 1)
    assert.ok(rig.adapters.email.sent.length === 1)
    assert.ok(rig.adapters.sms.sent.length === 1)
  })

  test('a critical notification reaches a user with no addresses at all', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await dispatchDue(rig.deps, 50)

    // The floor. In-app needs no address and no transport, which is what makes "at least one
    // channel" unconditional rather than a hope that an email address is on file.
    assert.equal(rig.adapters.in_app.sent.length, 1)
  })

  test('the database itself refuses a critical notification that reached nothing', async () => {
    // The third, independent guard. Even with the routing bypassed entirely, the row cannot be
    // written — not by this service, not by a migration, not by an operator with psql.
    await assert.rejects(
      () => sql`
        insert into notifications (user_id, category, priority, template_id, channel_count)
        values (${ALICE}, 'security', 'critical', 'security.key_exported', 0)
      `,
      /notifications_critical_reaches_a_channel/,
    )
    await assert.rejects(
      () => sql`
        insert into notifications (user_id, category, priority, template_id, channel_count, suppressed_reason)
        values (${ALICE}, 'security', 'critical', 'security.key_exported', 1, 'channel_disabled')
      `,
      /notifications_critical_never_suppressed/,
    )
  })

  test('a non-critical notification with every preference disabled is recorded as suppressed', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())

    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('market.listing.sold', 'listing-1', { user_id: ALICE, item_name: 'A thing' }),
    )
    assert.equal(outcome.kind, 'processed')
    if (outcome.kind !== 'processed') return
    assert.deepEqual(outcome.suppressed, ['channel_disabled'])

    // Recorded, not discarded: "why was I not told" has to be answerable.
    const rows = await sql<Array<{ suppressed_reason: string; channel_count: number }>>`
      select suppressed_reason, channel_count from notifications
    `
    assert.equal(rows[0]?.suppressed_reason, 'channel_disabled')
    assert.equal(rows[0]?.channel_count, 0)
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
  })

  /* ---------------------------------------------------------------- deduplication */

  test('a redelivered event produces one notification, not two', async () => {
    const rig = testRig(sql)
    const event = registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' })

    const first = await ingestEvent(rig.deps, event)
    const second = await ingestEvent(rig.deps, event)

    assert.equal(first.kind, 'processed')
    // The inbox unique on (topic, event_id) won. The handler was never re-run.
    assert.deepEqual(second, { kind: 'duplicate_event' })

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 1)
  })

  test('two different events describing one fact produce one notification', async () => {
    const rig = testRig(sql)
    // A new device produces both of these, with different event ids. The inbox cannot tell they
    // are the same news; the dedupe_key can, and the unique index enforces it.
    await ingestEvent(
      rig.deps,
      registeredEvent('identity.session.created', ALICE, {
        user_id: ALICE,
        device_id: 'device-1',
        new_device: true,
        ip_prefix: '203.0.113.0/24',
      }),
    )
    const second = await ingestEvent(
      rig.deps,
      registeredEvent('identity.device.added', ALICE, { user_id: ALICE, device_id: 'device-1' }),
    )

    assert.equal(second.kind, 'processed')
    if (second.kind !== 'processed') return
    assert.deepEqual(second.suppressed, ['duplicate'])

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 1, 'one sign-in, one alert')
  })

  test('a handler that fails leaves no inbox row, so the redelivery is processed', async () => {
    const rig = testRig(sql)
    const event = registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' })

    // Force the transaction to fail after the inbox insert by making the notification insert
    // impossible: a template id longer than any column would allow is not available, so instead
    // the erasure path is used with a malformed user id, which the uuid cast rejects.
    await assert.rejects(() =>
      ingestEvent(rig.deps, {
        ...registeredEvent('identity.user.deleted', 'not-a-uuid', {}),
        key: 'not-a-uuid',
      }),
    )

    const inbox = await sql<Array<{ n: number }>>`select count(*)::int as n from inbox`
    assert.equal(inbox[0]?.n, 0, 'record-then-handle would have left a row here and lost the event')

    // And an unrelated event still works.
    assert.equal((await ingestEvent(rig.deps, event)).kind, 'processed')
  })

  /* ---------------------------------------------------------------- retries and the dead letter */

  test('a failing channel backs off before it is retried', async () => {
    const rig = testRig(sql, { backoffMs: 60_000, maxAttempts: 6 })
    rig.adapters.email.failAlways({
      ok: false,
      reason: 'upstream_error',
      retryable: true,
      detail: 'the relay is refusing connections',
    })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const first = await dispatchDue(rig.deps, 50)
    assert.equal(first.retried, 1)
    assert.equal(first.sent, 1, 'in-app still went; one bad channel does not stop the others')

    const rows = await sql<Array<{ state: string; attempts: number; due_in_seconds: number; last_error: string }>>`
      select state, attempts, extract(epoch from (next_attempt_at - now()))::int as due_in_seconds, last_error
        from deliveries where channel = 'email'
    `
    assert.equal(rows[0]?.state, 'pending', 'there is no "failed" state to disagree about')
    assert.equal(rows[0]?.attempts, 1)
    assert.ok((rows[0]?.due_in_seconds ?? 0) > 30, 'the next attempt is pushed out by the backoff')
    assert.match(rows[0]?.last_error ?? '', /refusing connections/)

    // And it is not claimable until then.
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
  })

  test('a failing channel eventually dead-letters, and the row is retained', async () => {
    const rig = testRig(sql, { backoffMs: 0, maxAttempts: 3 })
    rig.adapters.email.failAlways({
      ok: false,
      reason: 'upstream_error',
      retryable: true,
      detail: 'the relay is refusing connections',
    })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )

    let dead = 0
    for (let pass = 0; pass < 5; pass += 1) dead += (await dispatchDue(rig.deps, 50)).dead
    assert.equal(dead, 1)

    const rows = await sql<Array<{ state: string; outcome: string; attempts: number; last_error: string }>>`
      select state, outcome, attempts, last_error from deliveries where channel = 'email'
    `
    assert.equal(rows.length, 1, 'the row is retained — it is the only record the work was asked for')
    assert.equal(rows[0]?.state, 'dead')
    assert.equal(rows[0]?.outcome, 'dead_upstream_error')
    assert.equal(rows[0]?.attempts, 3)
    assert.match(rows[0]?.last_error ?? '', /refusing connections/)

    // And it appears in the one dead-letter view, alongside every other channel.
    const page = await listDeliveries(sql, { states: ['dead', 'undeliverable'], channel: null, limit: 20, cursor: null })
    assert.equal(page.deliveries.length, 1)
    assert.equal(page.deliveries[0]?.outcome, 'dead_upstream_error')

    // The notification itself is untouched: it is still readable in-app.
    const inApp = await listNotifications(sql, ALICE, { limit: 10, cursor: null, unreadOnly: false })
    assert.equal(inApp.notifications.length, 1)
  })

  test('an unconfigured SMTP transport is undeliverable_no_transport, not lost and not an error', async () => {
    const rig = testRig(sql, {
      override: {
        email: emailAdapter({
          smtp: { host: null, port: 587, secure: false, user: null, pass: null, from: null, replyTo: null },
        }),
      },
    })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const summary = await dispatchDue(rig.deps, 50)
    assert.equal(summary.undeliverable, 1)
    assert.equal(summary.dead, 0, 'not a dead letter: no attempt budget was burned')

    const rows = await sql<Array<{ state: string; outcome: string; attempts: number }>>`
      select state, outcome, attempts from deliveries where channel = 'email'
    `
    assert.equal(rows[0]?.outcome, 'undeliverable_no_transport')
    assert.equal(rows[0]?.attempts, 1, 'tried once, then recorded; not retried five more times')

    // Not lost: the notification exists, is readable, and went out in-app.
    const page = await listNotifications(sql, ALICE, { limit: 10, cursor: null, unreadOnly: false })
    assert.equal(page.notifications.length, 1)
    assert.equal(rig.adapters.in_app.sent.length, 1)

    // Nothing is due again — this is a terminal state, so it never re-enters the queue.
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
  })

  /* ---------------------------------------------------------------- digests */

  test('a digest preference batches rather than sending, and the batch fires on its schedule', async () => {
    const at = new Date('2026-07-30T10:20:00.000Z')
    const rig = testRig(sql, { now: () => at })
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })
    await upsertPreferences(sql, ALICE, [
      { category: 'transfer', channel: 'email', enabled: true, digest: 'hourly', minPriority: 'low' },
      { category: 'transfer', channel: 'in_app', enabled: true, digest: 'hourly', minPriority: 'low' },
    ])

    for (const entry of ['entry-1', 'entry-2', 'entry-3']) {
      await ingestEvent(
        rig.deps,
        registeredEvent('ledger.entry.posted', 'account-1', {
          user_id: ALICE,
          entry_id: entry,
          amount: '5',
          asset_code: 'SHARD',
          description: 'a marketplace fee',
        }),
      )
    }

    // Nothing sent. The whole point of a digest is that the interruption does not happen now.
    assert.equal((await dispatchDue(rig.deps, 50)).claimed, 0)
    const batched = await sql<Array<{ n: number }>>`select count(*)::int as n from digest_entries`
    assert.equal(batched[0]?.n, 6, 'three notifications, two channels')

    const windows = await sql<Array<{ scheduled_for: Date; cadence: string }>>`
      select scheduled_for, cadence from digests order by channel
    `
    // Aligned to the wall clock: the top of the next hour, not "an hour from the first item".
    assert.equal(windows[0]?.scheduled_for.toISOString(), '2026-07-30T11:00:00.000Z')

    // Before the window, nothing fires.
    assert.equal((await flushDueDigests(rig.deps, 50)).flushed, 0)

    // On the window, one summary per channel, each carrying all three.
    const later = testRig(sql, { now: () => new Date('2026-07-30T11:00:01.000Z') })
    const flushed = await flushDueDigests(later.deps, 50)
    assert.equal(flushed.flushed, 2)
    assert.equal(flushed.notifications, 2)

    await dispatchDue(later.deps, 50)
    const summaries = later.adapters.email.sent
    assert.equal(summaries.length, 1)
    assert.match(summaries[0]?.message.subject ?? '', /3 updates/)
    // Each line distinguishes its notification. A digest of three identical lines is worse than
    // no digest, and this assertion is what keeps a parameterless subject out of a batch.
    assert.match(summaries[0]?.message.body ?? '', /5 SHARD/)
    assert.equal(summaries[0]?.message.body.split('\n').filter((line) => line.startsWith('•')).length, 3)

    // Flushing again is a no-op: the batch is closed and the summary deduped on the digest id.
    assert.equal((await flushDueDigests(later.deps, 50)).flushed, 0)
  })

  /* ---------------------------------------------------------------- webhooks */

  test('a webhook delivery carries a signature the receiver can verify', async () => {
    let verified: ReturnType<typeof verifyDelivery> | null = null
    let body = ''
    const rig = testRig(sql, {
      override: {
        webhook: webhookAdapter({
          // A third-party application, verifying with the shared package rather than
          // recomputing an HMAC of its own.
          post: async (_url, request) => {
            body = request.body
            verified = verifyDelivery(request.body, request.headers[SIGNATURE_HEADER] ?? '', WEBHOOK_SECRET)
            return { status: 200 }
          },
        }),
      },
    })
    await upsertTarget(sql, {
      userId: ALICE,
      channel: 'webhook',
      address: 'https://developer.example.test/hooks/cf',
      secret: WEBHOOK_SECRET,
      label: 'Acme integration',
    })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const summary = await dispatchDue(rig.deps, 50)
    assert.equal(summary.sent, 2, 'in-app and the webhook — one pipeline, not two')
    assert.deepEqual(verified, { ok: true, keyIndex: 0 })

    const payload = JSON.parse(body) as Record<string, unknown>
    assert.equal(payload['userId'], ALICE)
    assert.equal(payload['category'], 'security')
    // The internal envelope is never forwarded to a third party.
    assert.equal(payload['topic'], undefined)
    assert.equal(payload['producer'], undefined)
  })

  test('a webhook is retried and dead-lettered by the same policy as an email', async () => {
    const rig = testRig(sql, { backoffMs: 0, maxAttempts: 2 })
    rig.adapters.webhook.failAlways({
      ok: false,
      reason: 'upstream_error',
      retryable: true,
      detail: 'endpoint answered 502',
    })
    await upsertTarget(sql, {
      userId: ALICE,
      channel: 'webhook',
      address: 'https://developer.example.test/hooks/cf',
      secret: WEBHOOK_SECRET,
    })

    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    for (let pass = 0; pass < 3; pass += 1) await dispatchDue(rig.deps, 50)

    const page = await listDeliveries(sql, {
      states: ['dead', 'undeliverable'],
      channel: 'webhook',
      limit: 10,
      cursor: null,
    })
    assert.equal(page.deliveries.length, 1)
    assert.equal(page.deliveries[0]?.state, 'dead')
    assert.equal(page.deliveries[0]?.attempts, 2)
  })

  test('one broken webhook endpoint does not stop the others', async () => {
    const rig = testRig(sql, { backoffMs: 60_000 })
    let calls = 0
    const failing = 'https://broken.example.test/hooks'
    const rigWithReceiver = testRig(sql, {
      backoffMs: 60_000,
      override: {
        webhook: webhookAdapter({
          post: async (url) => {
            calls += 1
            return { status: url === failing ? 500 : 200 }
          },
        }),
      },
    })
    void rig

    await upsertTarget(sql, { userId: ALICE, channel: 'webhook', address: failing, secret: WEBHOOK_SECRET })
    await upsertTarget(sql, {
      userId: ALICE,
      channel: 'webhook',
      address: 'https://working.example.test/hooks',
      secret: WEBHOOK_SECRET,
    })

    await ingestEvent(
      rigWithReceiver.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    const summary = await dispatchDue(rigWithReceiver.deps, 50)
    assert.equal(calls, 2, 'one delivery row per endpoint, each with its own attempts')
    assert.equal(summary.sent, 2, 'in-app and the working endpoint')
    assert.equal(summary.retried, 1)
  })

  /* ---------------------------------------------------------------- registry lag, erasure, broadcast */

  /**
   * This used to ingest `identity.password.changed` and assert a "password was changed" subject.
   * It passed, and the notification it proved could never happen: identity emits no such topic. It
   * revokes every session with a reason (identity/src/server.ts:960), which is the event below.
   */
  test('a password change reaches the user as the session revocation identity really emits', async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('identity.session.revoked', 'session-1', {
        sessionId: 'session-1',
        userId: ALICE,
        reason: 'password_changed',
      }),
    )
    assert.equal(outcome.kind, 'processed')
    await dispatchDue(rig.deps, 50)
    assert.match(rig.adapters.in_app.sent[0]?.message.subject ?? '', /session .* was ended/i)
    assert.match(rig.adapters.in_app.sent[0]?.message.body ?? '', /your password was changed/)
  })

  test('an ordinary sign-out is not news, and is recorded as such', async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      registeredEvent('identity.session.revoked', 'session-2', {
        sessionId: 'session-2',
        userId: ALICE,
        reason: 'signed_out',
      }),
    )
    // `not_applicable`, never `no_recipient`: the rule found the user and decided, which is the
    // distinction an operator reads to know whether a producer needs fixing.
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'not_applicable' })
  })

  test('an event on a topic no rule covers is ignored rather than stored as a notification', async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      unregisteredEvent('identity.password.changed', ALICE, { user_id: ALICE }),
    )
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'no_rule' })
  })

  test('identity.user.deleted erases everything this service holds', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })
    await upsertPreferences(sql, ALICE, [
      { category: 'market', channel: 'email', enabled: false, digest: 'off', minPriority: 'low' },
    ])
    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'key-1' }),
    )
    await ingestEvent(
      rig.deps,
      registeredEvent('custody.key.exported', BOB, { user_id: BOB, key_id: 'key-2' }),
    )

    const erased = await ingestEvent(rig.deps, registeredEvent('identity.user.deleted', ALICE, { user_id: ALICE }))
    assert.equal(erased.kind, 'erased')

    const mine = await sql<Array<{ n: number }>>`
      select (select count(*) from notifications where user_id = ${ALICE})
           + (select count(*) from channel_targets where user_id = ${ALICE})
           + (select count(*) from preferences where user_id = ${ALICE}) as n
    `
    assert.equal(Number(mine[0]?.n), 0)
    // Deliveries go by cascade, and nobody else is touched.
    const theirs = await sql<Array<{ n: number }>>`
      select count(*)::int as n from notifications where user_id = ${BOB}
    `
    assert.equal(theirs[0]?.n, 1)
  })

  test('an operator broadcast reaches every reachable user exactly once', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })
    await upsertTarget(sql, { userId: BOB, channel: 'email', address: 'bob@example.test' })

    const broadcast = await insertBroadcast(sql, {
      category: 'system',
      priority: 'normal',
      templateId: 'system.broadcast',
      params: { title: 'Scheduled maintenance', message: 'Withdrawals pause at 02:00 UTC.' },
      audience: 'all',
      userIds: [],
      dedupeKey: 'broadcast:maintenance-2026-07-30',
      createdBy: 'operator:root',
    })

    const first = await fanOutBroadcast(rig.deps, broadcast.id)
    assert.equal(first.recipients, 2)
    assert.equal(first.created, 2)

    // Re-running the fan-out after a crash produces nothing new: the dedupe key is per user.
    const second = await fanOutBroadcast(rig.deps, broadcast.id)
    assert.equal(second.created, 0)

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 2)
  })

  /* ---------------------------------------------------------------- the failed withdrawal
   *
   * The whole path for `settlement.outbound.failed`, from settlement's real payload to the words
   * a channel is handed, because every intermediate step has somewhere for the fact to be lost:
   * the rule picks the recipient, `outcomeOf` picks the priority and template, the database's two
   * §10.3 CHECK constraints decide whether a critical row may exist at all, and the renderer
   * produces the sentence. A unit test on the rule alone proves none of the last three.
   *
   * `WITHDRAWAL` is a uuid that is NOT a user's, because it is the envelope key for this topic and
   * a key fallback would be well-formed and wrong.
   */

  const WITHDRAWAL = '44444444-4444-4444-8444-444444444444'

  function failure(payload: Record<string, unknown>) {
    // `service:settlement` is what settlement's relay stamps: `failedEvents` names no actor, so
    // there is no actor route to a person and the payload is the only one.
    return registeredEvent('settlement.outbound.failed', WITHDRAWAL, payload, {
      actor: 'service:settlement',
    })
  }

  /**
   * Held money is critical, so it survives a user who has muted everything.
   *
   * This is the §10.3 invariant applied to the case it was not written for, and the reason it has
   * to hold here is specific: wallet's non-refundable branch moves the row to `stuck` and emits
   * nothing (`wallet/src/withdrawals.ts:592`), so this notification is the only account the owner
   * of that money will ever get. A preference that could silence it would turn "your withdrawal
   * failed and your funds are held" into silence.
   */
  test('a failed withdrawal with the money held reaches a user who has muted everything', async () => {
    const rig = testRig(sql)
    await upsertPreferences(sql, ALICE, everythingDisabled())
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })

    const outcome = await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'the chain rejected it', refundable: false }),
    )
    assert.equal(outcome.kind, 'processed')

    const rows = await sql<
      Array<{ user_id: string; priority: string; template_id: string; channel_count: number; suppressed_reason: string | null }>
    >`select user_id, priority, template_id, channel_count, suppressed_reason from notifications`
    assert.equal(rows.length, 1)
    // The right person: settlement's userId, never the withdrawal id the envelope is keyed by.
    assert.equal(rows[0]?.user_id, ALICE)
    assert.notEqual(rows[0]?.user_id, WITHDRAWAL)
    assert.equal(rows[0]?.priority, 'critical')
    assert.equal(rows[0]?.template_id, 'withdrawal.failed_held')
    assert.equal(rows[0]?.suppressed_reason, null, '04-domain-model §10.3')
    assert.ok((rows[0]?.channel_count ?? 0) >= 1)

    await dispatchDue(rig.deps, 50)
    const sent = [...rig.adapters.in_app.sent, ...rig.adapters.email.sent]
    assert.equal(sent.length, 2, 'in-app and email, with every preference switched off')
    for (const { message } of sent) {
      assert.equal(message.userId, ALICE)
      const text = `${message.subject}\n${message.body}`
      assert.match(text, /still held/)
      assert.doesNotMatch(
        text,
        /coming back|being returned to your balance/,
        'the expensive error, delivered: their money is held and they have been told it is back',
      )
    }
  })

  test('a refundable failure says the money is coming back, and is muteable', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })

    await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'the chain rejected it', refundable: true }),
    )
    const rows = await sql<Array<{ user_id: string; priority: string; template_id: string }>>`
      select user_id, priority, template_id from notifications
    `
    assert.equal(rows[0]?.user_id, ALICE)
    assert.equal(rows[0]?.priority, 'high')
    assert.equal(rows[0]?.template_id, 'withdrawal.failed_refunded')

    await dispatchDue(rig.deps, 50)
    const email = rig.adapters.email.sent[0]?.message
    const text = `${email?.subject}\n${email?.body}`
    assert.match(text, /being returned to your balance/)
    assert.doesNotMatch(text, /still held/)

    // And `high` really is muteable, which is the half of the priority argument a unit test on the
    // rule cannot show: the same event, for a user who has switched the category off, is
    // suppressed rather than forced through. That is the difference from the test above, and it is
    // the reason the two dispositions are not one priority.
    await upsertPreferences(sql, BOB, everythingDisabled())
    const muted = await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, userId: BOB, reason: 'the chain rejected it', refundable: true }),
    )
    assert.equal(muted.kind, 'processed')
    if (muted.kind !== 'processed') return
    assert.deepEqual(muted.created, [])
    assert.equal(muted.suppressed.length, 1)
  })

  /**
   * **Yesterday's payload, through the whole pipeline.**
   *
   * The trap this exists for: an end-to-end test that only ever sends today's payload stays GREEN
   * with the recipient logic deliberately broken, because an absent field is null to every reader
   * and a rule that guesses from the key produces a notification that looks perfectly well formed.
   * It has a user id, it has a template, it renders. It goes to a user who does not exist.
   *
   * So the pre-fix shape — `{ withdrawalId, reason, refundable }`, exactly what `failedEvents`
   * emitted before settlement added the field — is driven through `ingestEvent`, and the assertion
   * is that NOTHING is written. `no_recipient` is the honest answer and it names a producer to go
   * and fix; a row here would mean this service had invented a recipient.
   */
  test("yesterday's failure payload writes no notification at all, rather than one for nobody", async () => {
    const rig = testRig(sql)
    const outcome = await ingestEvent(
      rig.deps,
      failure({ withdrawalId: WITHDRAWAL, reason: 'the chain rejected it', refundable: false }),
    )
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'no_recipient' })

    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from notifications`
    assert.equal(rows[0]?.n, 0, 'a notification was written for a recipient nobody named')
    // And the absence is counted, so an operator sees a producer to page rather than silence.
    assert.equal(counterValue(rig.metrics, 'notify_suppressed_total', { reason: 'no_recipient' }), 1)
  })

  /**
   * The regression that costs the most, driven end to end: the producer stops sending `refundable`.
   *
   * settlement made it a required boolean, so this is a relay dropping a field, a replay of an old
   * event, or a rewrite that made it optional again. In every one of those the truthful answer is
   * "we do not know", and the notification must read as HELD — because `wallet/src/server.ts:875`
   * refuses to refund without proof, and a notification saying the money is on its way back while
   * wallet holds it is the one error nobody can take back.
   */
  test('a failure payload with refundable dropped is delivered as HELD, not as a refund', async () => {
    const rig = testRig(sql)
    await upsertTarget(sql, { userId: ALICE, channel: 'email', address: 'alice@example.test' })

    await ingestEvent(rig.deps, failure({ withdrawalId: WITHDRAWAL, userId: ALICE, reason: 'unknown' }))
    const rows = await sql<Array<{ priority: string; template_id: string }>>`
      select priority, template_id from notifications
    `
    assert.equal(rows[0]?.priority, 'critical')
    assert.equal(rows[0]?.template_id, 'withdrawal.failed_held')

    await dispatchDue(rig.deps, 50)
    const email = rig.adapters.email.sent[0]?.message
    const text = `${email?.subject}\n${email?.body}`
    assert.match(text, /still held/)
    assert.doesNotMatch(text, /coming back|being returned to your balance/)
  })
})
