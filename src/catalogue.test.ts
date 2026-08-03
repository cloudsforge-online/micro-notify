/**
 * The mapping table: coverage, dedupe keys, and the parameters each rule must supply.
 *
 * These are the tests that fail when somebody adds a topic to the shared registry and nobody
 * decides what notify should do about it — which, given the fan-in is the entire bus, is the most
 * likely way this service quietly stops covering something.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOPIC_NAMES } from '@cloudsforge/contracts-events'
import {
  MAPPED_TOPICS,
  NON_NOTIFYING_TOPICS,
  RULES,
  outcomeOf,
  outcomesOf,
  ruleFor,
  unmappedRegistryTopics,
} from './catalogue.ts'
import { CATEGORIES, DEFAULT_LOCALE, PRIORITIES, isCategory, isPriority } from './model.ts'
import { TEMPLATES, isTemplateId, renderTemplate, templateFor } from './templates.ts'
import { UNPRODUCED_NOTIFICATIONS } from './topics.ts'
import { registeredEvent, unregisteredEvent, ALICE, BOB } from './testsupport.ts'

test('every topic in the registry is either mapped or explicitly not notifying', () => {
  assert.deepEqual(
    unmappedRegistryTopics(),
    [],
    'a registry topic with no rule and no recorded reason — decide what notify does with it',
  )
  // And the registry is actually being read, rather than the check passing vacuously.
  assert.ok(TOPIC_NAMES.length >= 18)
})

test('every non-notifying topic records why', () => {
  for (const [topic, reason] of Object.entries(NON_NOTIFYING_TOPICS)) {
    assert.ok(reason.length > 40, `${topic} needs a real reason, not a label`)
  }
})

/**
 * AD-08's notifications, and the one thing this test used to get wrong.
 *
 * It listed twenty-eight TOPICS and asserted a rule for each. Eleven of those topic names were
 * guesses at events that no producer emits, so eleven of its assertions passed against rules that
 * could never fire — the test was the reason nobody noticed, because it reported full AD-08
 * coverage while the notifications behind it were unreachable.
 *
 * AD-08 names KINDS of notification, not topics. So each requirement is now either a live rule on
 * a registered topic, or a recorded gap in `topics.ts` carrying the topic its producer really
 * emits. Both halves are checked, and a requirement that is in neither fails.
 */
test('every notification AD-08 names is either live or a recorded gap', () => {
  const live = [
    // new-device sign-in — two producers, one fact
    'identity.session.created',
    'identity.device.added',
    // password change — carried by the revocation, which is what identity actually emits
    'identity.session.revoked',
    // MFA change, both halves
    'identity.mfa.removed',
    'identity.mfa.added',
    // wallet created
    'wallet.wallet.created',
    // key exported
    'custody.export.requested',
    'custody.key.exported',
    // deposit confirmed
    'wallet.deposit.confirmed',
    // withdrawal requested / completed / late / failed outright
    'wallet.withdrawal.requested',
    'settlement.withdrawal.completed',
    'settlement.withdrawal.stuck',
    // "withdrawal transaction failed outright". Recorded as impossible for the life of this
    // service because the envelope named nobody; settlement added `userId` (withdrawals.ts:537)
    // and the record in topics.ts had to go, because contradictedGaps() refuses to hold both.
    'settlement.outbound.failed',
    // marketplace sale
    'market.listing.sold',
    // token deployment
    'mint.deploy.confirmed',
    // game reward
    'worlds.reward.granted',
    // community proposal / governance vote
    'community.proposal.opened',
    'community.proposal.executed',
    'community.vote.cast',
    // trading-bot event, and the two API-key events. All three were RECORDED as impossible while
    // their producers were emitting them under the names this service had already written down —
    // see topics.ts. They were quarantined in AWAITING_REGISTRATION with the specs that would
    // register them; micro-contracts has since pasted all three into the registry, so the
    // quarantine is empty and these are ordinary registered rules.
    'trade.bot.paused',
    'devplatform.key.issued',
    'devplatform.key.revoked',
  ]
  for (const topic of live) {
    assert.ok(ruleFor(topic), `AD-08 requires a rule for ${topic}`)
  }

  // The rest of AD-08's list, each with no event to hang a rule on. The record names the producer
  // and what it emits instead; `topics.test.ts` checks the evidence and fails when one becomes
  // registrable. Naming them here keeps the requirement visible from the coverage test rather
  // than only from the deletion's commit message.
  const recorded = new Set(UNPRODUCED_NOTIFICATIONS.map((gap) => gap.requirement))
  for (const requirement of [
    'risk limit reached',
    'deposit detected, before confirmation',
    // Names a topic a live producer emits — which is why it LOOKS like the ones that became rules,
    // and is not. market/src/bids.ts:432 puts the OFFERER on the envelope and the notification is
    // for the SELLER, so `blockedBy: 'no-subject'` and one field on market's payload closes it.
    'marketplace offer received',
    'auction ended',
    'service incident',
  ]) {
    assert.ok(recorded.has(requirement), `AD-08 names "${requirement}" and nothing here accounts for it`)
  }
  // And the one that closed. It was in the list above until settlement put `userId` on the failure
  // payload; keeping it there while a rule exists is the exact contradiction contradictedGaps()
  // fails on. Asserted from BOTH sides so neither half can be forgotten.
  assert.equal(
    recorded.has('withdrawal transaction failed outright'),
    false,
    'this is a rule now — a record saying it cannot be produced contradicts the catalogue',
  )
  assert.ok(MAPPED_TOPICS.length >= live.length)
})

/**
 * §10.3's critical list, walked over EVERY outcome a rule can produce rather than over
 * `rule.priority`.
 *
 * The distinction is load-bearing now that one topic carries two facts: reading `rule.priority`
 * alone would have counted `settlement.outbound.failed` as wholly critical and never looked at its
 * variant, so a variant promoted to critical by a later edit would have been invisible to the one
 * test whose job is to keep that set from growing.
 */
test('exactly the events 04-domain-model §10.3 names are critical', () => {
  const critical = MAPPED_TOPICS.filter((topic) => {
    const rule = RULES[topic]
    return rule !== undefined && outcomesOf(rule).some((each) => each.priority === 'critical')
  }).sort()
  assert.deepEqual(critical, [
    'custody.export.requested',
    'custody.key.exported',
    'identity.device.added',
    'identity.mfa.added',
    'identity.mfa.removed',
    'identity.session.created',
    'identity.session.revoked',
    // §10.3's list names "withdrawal", and both of these are it: the request, which is the only
    // window in which a theft can be stopped, and the failure that leaves the money HELD, which
    // nothing else in the estate reports. The refunded half of that same topic is `high` — see the
    // test below, which pins that it is not critical.
    'settlement.outbound.failed',
    'wallet.withdrawal.requested',
  ])
})

test('every outcome a rule can produce names a real category, priority and template', () => {
  for (const [topic, rule] of Object.entries(RULES)) {
    assert.ok(isCategory(rule.category), `${topic}: unknown category ${rule.category}`)
    assert.ok(rule.why.length > 30, `${topic}: say why this interrupts someone`)
    assert.ok(CATEGORIES.includes(rule.category))
    for (const outcome of outcomesOf(rule)) {
      assert.ok(isPriority(outcome.priority), `${topic}: unknown priority ${outcome.priority}`)
      assert.ok(isTemplateId(outcome.templateId), `${topic}: unknown template ${outcome.templateId}`)
      assert.ok(PRIORITIES.includes(outcome.priority))
    }
    // A variant is a second fact, so it argues for itself separately or it is decoration.
    if (rule.variant) {
      assert.ok(rule.variant.why.length > 30, `${topic}: say why the variant is different news`)
      assert.notEqual(
        rule.variant.templateId,
        rule.templateId,
        `${topic}: a variant rendering the same template says the same thing twice`,
      )
    }
  }
})

test("a rule's category agrees with its template's", () => {
  for (const [topic, rule] of Object.entries(RULES)) {
    for (const outcome of outcomesOf(rule)) {
      if (!isTemplateId(outcome.templateId)) continue
      const template = templateFor(outcome.templateId)
      assert.equal(
        rule.category,
        template.category,
        `${topic} files under ${rule.category} but renders a ${template.category} template`,
      )
    }
  }
})

test('every rule supplies every parameter its template requires', () => {
  // The check that stops "Hello undefined" reaching a user. Each rule is run against a payload
  // holding nothing at all, so it passes only if the rule's fallbacks cover every parameter — and
  // against every template it could choose, so a variant's template is covered too.
  for (const [topic, rule] of Object.entries(RULES)) {
    const event = unregisteredEvent(topic, ALICE, { user_ids: [ALICE], new_device: true })
    const set = rule.recipients({ ...event, actor: `user:${ALICE}` })
    if (set.kind === 'none') continue
    for (const outcome of outcomesOf(rule)) {
      if (!isTemplateId(outcome.templateId)) continue
      const template = templateFor(outcome.templateId)
      for (const recipient of set.recipients) {
        for (const name of template.params) {
          assert.notEqual(
            recipient.params[name],
            undefined,
            `${topic} does not supply ${name} for ${outcome.templateId}`,
          )
        }
      }
    }
  }
})

test('the two new-device events produce one dedupe key, so one sign-in is one alert', () => {
  const deviceId = 'device-abc'
  const session = registeredEvent('identity.session.created', ALICE, {
    device_id: deviceId,
    new_device: true,
    ip_prefix: '203.0.113.0/24',
  })
  const added = registeredEvent('identity.device.added', ALICE, { device_id: deviceId })

  const fromSession = RULES['identity.session.created']?.recipients(session)
  const fromAdded = RULES['identity.device.added']?.recipients(added)
  assert.equal(fromSession?.kind, 'recipients')
  assert.equal(fromAdded?.kind, 'recipients')
  if (fromSession?.kind !== 'recipients' || fromAdded?.kind !== 'recipients') return
  assert.equal(fromSession.recipients[0].dedupeKey, fromAdded.recipients[0].dedupeKey)
  assert.equal(fromSession.recipients[0].dedupeKey, `security.new_device:${deviceId}`)
})

test('a sign-in from a known device is not applicable, not a failure', () => {
  const event = registeredEvent('identity.session.created', ALICE, {
    device_id: 'device-known',
    new_device: false,
  })
  assert.deepEqual(RULES['identity.session.created']?.recipients(event), {
    kind: 'none',
    reason: 'not_applicable',
  })
})

test('a rule that cannot find a user says no_recipient, which is a producer to fix', () => {
  const event = registeredEvent('wallet.deposit.confirmed', 'wallet-1', { amount: '10' })
  assert.deepEqual(RULES['wallet.deposit.confirmed']?.recipients(event), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('a deposit keyed by wallet_id is never attributed to the key as if it were a user', () => {
  // The registry says wallet.deposit.confirmed is keyed by wallet_id, so the key must not be used
  // as a user id. Telling the wrong person about someone else's money is the worst thing this
  // service could do, and it would be a one-line mistake.
  const event = registeredEvent('wallet.deposit.confirmed', 'wallet-1', {
    user_id: ALICE,
    amount: '10',
    asset_code: 'ETH',
  })
  const set = RULES['wallet.deposit.confirmed']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].userId, ALICE)
  assert.notEqual(set.recipients[0].userId, 'wallet-1')
})

test('a battle report reaches the DEFENDER — never the raider, whoever the actor was', () => {
  // aetherholm.battle.resolved is keyed by battle id and its envelope actor is the ATTACKER
  // (aetherholm/src/fleets.ts, `user:` actor on the emit). forUser's actor fallback would hand
  // "your city was raided" to the raider, so the rule reads defender_user_id explicitly.
  const event = registeredEvent('aetherholm.battle.resolved', 'battle-1', {
    attackerUserId: BOB,
    defenderUserId: ALICE,
    battleId: 'battle-1',
    cityName: 'Aerie',
    outcome: 'raided',
  })
  const set = RULES['aetherholm.battle.resolved']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  assert.notEqual(set.recipients[0].userId, BOB)
  assert.equal(set.recipients[0].dedupeKey, 'aetherholm.battle:battle-1')
  // Without a defender the answer is no_recipient — a producer to fix, not a guess.
  const anonymous = registeredEvent('aetherholm.battle.resolved', 'battle-2', { outcome: 'raided' })
  assert.deepEqual(RULES['aetherholm.battle.resolved']?.recipients(anonymous), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('spire heraldry reaches every member the producer names, and nobody it guesses', () => {
  const event = registeredEvent('aetherholm.spire.captured', 'island-1', {
    seasonId: 'season-1',
    seasonName: 'Season 1',
    islandId: 'island-1',
    userIds: [ALICE, BOB],
  })
  const set = RULES['aetherholm.spire.captured']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.deepEqual(set.recipients.map((recipient) => recipient.userId).sort(), [ALICE, BOB].sort())
  for (const recipient of set.recipients) {
    assert.equal(recipient.dedupeKey, 'aetherholm.spire:season-1:island-1')
    assert.equal(recipient.params['seasonName'], 'Season 1')
  }
  // No member list, no recipients: notify holds no membership table and must not guess.
  const bare = registeredEvent('aetherholm.spire.captured', 'island-2', { seasonId: 'season-1' })
  assert.deepEqual(RULES['aetherholm.spire.captured']?.recipients(bare), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('a dedupe key never contains the event id for a fact that two events can describe', () => {
  const first = registeredEvent('custody.key.exported', ALICE, { key_id: 'key-1' })
  const second = registeredEvent('custody.key.exported', ALICE, { key_id: 'key-1' })
  const a = RULES['custody.key.exported']?.recipients(first)
  const b = RULES['custody.key.exported']?.recipients(second)
  if (a?.kind !== 'recipients' || b?.kind !== 'recipients') {
    assert.fail('expected recipients')
    return
  }
  assert.notEqual(first.id, second.id, 'two distinct events')
  assert.equal(a.recipients[0].dedupeKey, b.recipients[0].dedupeKey, 'one fact, one key')
})

test('every template is reachable from some rule, or is a platform template', () => {
  // Over every OUTCOME, not `rule.templateId`: a variant's template is reachable too, and reading
  // only the rule's own would have reported `withdrawal.failed_refunded` as written-but-unrendered.
  const used = new Set<string>(
    Object.values(RULES).flatMap((rule) => outcomesOf(rule).map((each) => each.templateId)),
  )
  // Produced by the service itself rather than by an event. `system.incident` joined them when
  // the admin_api.incident.opened rule was deleted: an incident reaches users as an operator
  // broadcast (POST /admin/broadcasts names a template id, pipeline.ts:555), which is the path
  // that was actually carrying it — the deleted rule was a no-op that never routed anything.
  const platform = new Set(['system.broadcast', 'digest.summary', 'system.incident'])
  for (const id of Object.keys(TEMPLATES)) {
    assert.ok(used.has(id) || platform.has(id), `${id} is written but nothing renders it`)
  }
})

test('provision.failed notifies the SUBJECT, and the service actor never becomes a recipient', () => {
  // worlds.provision.failed is keyed by entitlement id, the buyer is payload.subject
  // (worlds/src/provisioning.ts:608), and the envelope actor is `service:worlds` — so userIdOf's
  // fallbacks find nobody. The rule reads subject explicitly; this pins both directions, the same
  // trap as aetherholm.battle.resolved's raider/defender.
  const event = registeredEvent('worlds.provision.failed', 'ent-1', {
    provisionId: 'p-1',
    entitlementId: 'ent-1',
    subject: ALICE,
    sku: 'private_world',
    reason: 'title unreachable',
  })
  const set = RULES['worlds.provision.failed']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].dedupeKey, 'provision.failed:ent-1')
  // Without a subject: no_recipient, never a guess off the service actor.
  const anonymous = registeredEvent('worlds.provision.failed', 'ent-2', { entitlementId: 'ent-2' })
  assert.deepEqual(RULES['worlds.provision.failed']?.recipients(anonymous), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('emberkin.reward.granted names the Shards and dedupes on the journal entry', () => {
  const event = registeredEvent('emberkin.reward.granted', 'season-1:' + ALICE, {
    seasonId: 'season-1',
    userId: ALICE,
    reason: 'season placement',
    amount: '250',
    journalEntryId: 'j-9',
  })
  const set = RULES['emberkin.reward.granted']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].dedupeKey, 'emberkin.reward:j-9')
  assert.equal(set.recipients[0].params['rewardName'], '250 Shards')
})


/**
 * **The MFA rules had never once been reachable.**
 *
 * identity emitted `identity.mfa.changed` — a name on no registry and in no consumer — carrying a
 * four-value `change` discriminator. Both rules below were written against the topics the registry
 * and this service agreed on, and no event ever arrived on either. The producer has been split into
 * `identity.mfa.removed` and `identity.mfa.added`; these pin the payload contract so the two sides
 * cannot drift apart again silently.
 *
 * `identity.mfa.added` is still unregistered, which is exactly the registry-lag case `events.ts`
 * exists to tolerate: a rule for it is what makes the delivery acceptable, so it is built with
 * `unregisteredEvent` rather than `registeredEvent`.
 */
test('a last-factor removal reports zero remaining, from the field identity actually sends', () => {
  const event = registeredEvent('identity.mfa.removed', ALICE, {
    userId: ALICE,
    kind: 'totp',
    factorId: 'factor-1',
    wasLast: true,
    remainingActive: 0,
    critical: true,
  })
  const set = RULES['identity.mfa.removed']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].dedupeKey, 'security.mfa_changed:factor-1')
  assert.equal(set.recipients[0].params['change'], 'removed')
  // Zero, not "unknown". The producer's field is `remainingActive`; reading only the older
  // `remainingFactors` spelling would silently render the wrong sentence to someone whose account
  // has just dropped to password-only.
  assert.equal(set.recipients[0].params['remainingFactors'], '0')
})

test('an ordinary removal reports what is left rather than the last-factor zero', () => {
  const event = registeredEvent('identity.mfa.removed', ALICE, {
    userId: ALICE,
    kind: 'totp',
    factorId: 'factor-2',
    wasLast: false,
    remainingActive: 1,
    critical: false,
  })
  const set = RULES['identity.mfa.removed']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].params['remainingFactors'], '1')
})

test('identity.mfa.added is reachable, and is the other half of the same template', () => {
  const event = unregisteredEvent('identity.mfa.added', ALICE, {
    userId: ALICE,
    kind: 'recovery_code',
    factorId: 'factor-3',
    replacedPrevious: true,
    remainingActive: 2,
    critical: true,
  })
  const set = RULES['identity.mfa.added']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].params['change'], 'added')
  assert.equal(set.recipients[0].params['remainingFactors'], '2')
  // Keyed on the factor, so an add and a remove of the SAME factor collapse into one notification
  // while two different factors do not.
  assert.equal(set.recipients[0].dedupeKey, 'security.mfa_changed:factor-3')
})

/**
 * `identity.user.registered` is the first thing the platform ever says to someone, and identity
 * never emitted it — the route wrote an `audit: 'user_registered'` log line instead, which is what
 * every reader looking for the emit kept finding. The producer now emits it in the same
 * transaction as the account; this pins the one field the greeting is built from.
 */
test('a registration greets the user by the handle identity sends, not by a display name', () => {
  const event = registeredEvent('identity.user.registered', ALICE, {
    userId: ALICE,
    handle: 'sam',
    organisationId: 'org-1',
    organisationSlug: 'sam',
  })
  const set = RULES['identity.user.registered']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].params['handle'], 'sam')
  assert.equal(set.recipients[0].subjectUrn, `cf:identity:user:${ALICE}`)
})

/* ==================================================================================================
 * settlement.outbound.failed — the rule that could not be written until settlement named a user.
 *
 * These are the tests that have to fail if the WRONG PERSON is told or the WRONG THING is said, and
 * the two are separate failures with separate traps.
 *
 * **The wrong person.** The withdrawal id on this envelope is a uuid (`wallet/src/migrations.ts`
 * keys `withdrawals` by one) and it is the envelope KEY, because the registry keys this topic by
 * `withdrawal_id`. So a key fallback would return a well-formed, queryable, wrong user id, and the
 * fixtures below deliberately give the key a different uuid from the recipient so that mistake
 * cannot pass. The actor is `service:settlement`, which is what settlement's relay stamps when an
 * emit names none — and `failedEvents` names none — so the payload is the only route that exists.
 *
 * **The wrong thing.** `refundable` decides whether the money is coming back or is held. Absent is
 * held. The tests assert on the RENDERED SENTENCE and not only on a template id, because a template
 * id is an identifier a refactor can move while the words stay wrong, and because the two sentences
 * are the entire point of the distinction.
 * ================================================================================================== */

/** A uuid, and deliberately NOT a user's — this is the envelope key for this topic. */
const WITHDRAWAL = '33333333-3333-4333-8333-333333333333'

/** The exact payload `settlement/src/withdrawals.ts:537` builds. `undefined` omits the field. */
function failedWithdrawal(refundable: unknown): Record<string, unknown> {
  return {
    withdrawalId: WITHDRAWAL,
    userId: ALICE,
    reason: 'the chain rejected the transaction',
    ...(refundable === undefined ? {} : { refundable }),
  }
}

/** Rendered as a user reads it, so a test can assert words rather than an identifier. */
function sentence(event: Parameters<typeof outcomeOf>[1]): string {
  const rule = RULES['settlement.outbound.failed']
  assert.ok(rule)
  const set = rule.recipients(event)
  assert.equal(set.kind, 'recipients')
  if (set.kind !== 'recipients') return ''
  const outcome = outcomeOf(rule, event)
  assert.ok(isTemplateId(outcome.templateId))
  if (!isTemplateId(outcome.templateId)) return ''
  const rendered = renderTemplate(
    templateFor(outcome.templateId),
    set.recipients[0].params,
    DEFAULT_LOCALE,
    'https://app.cloudsforge.test',
  )
  assert.deepEqual(rendered.missing, [], 'a failed-withdrawal notification must never have a gap in it')
  return `${rendered.subject}\n${rendered.body}`
}

test('a failed withdrawal reaches the user settlement names, never the withdrawal id it is keyed by', () => {
  const event = registeredEvent('settlement.outbound.failed', WITHDRAWAL, failedWithdrawal(false), {
    // What settlement's relay actually stamps: `failedEvents` sets no actor, so the payload is the
    // only route to a person. An `actor` fallback would find `service:settlement` and nobody.
    actor: 'service:settlement',
  })
  const set = RULES['settlement.outbound.failed']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  // The two assertions that catch a key fallback. Both are needed: the first fails if the key is
  // preferred, the second states the thing that must never be true even if ALICE ever equals it.
  assert.notEqual(set.recipients[0].userId, WITHDRAWAL)
  assert.notEqual(set.recipients[0].userId, event.key)
  assert.equal(set.recipients[0].subjectUrn, `cf:settlement:withdrawal:${WITHDRAWAL}`)
})

/**
 * **Yesterday's payload, fed to today's reader.**
 *
 * This is the test that fails when the PRODUCER regresses rather than when this file changes. The
 * shape below is exactly what `failedEvents` emitted before settlement added the field —
 * `{ withdrawalId, reason, refundable }` — and every assertion above still passes against it if
 * this rule ever acquires a fallback to the key or to the actor. It answers `no_recipient`, which
 * is the honest "a producer to go and fix", and never a guess.
 *
 * An end-to-end test that only sent today's payload would stay green with the recipient logic
 * deliberately broken, because an absent field is null to every reader. That has happened twice in
 * this estate; this is the shape that catches it.
 */
test("yesterday's failure payload, with no userId, is no_recipient rather than a guess", () => {
  const event = registeredEvent(
    'settlement.outbound.failed',
    WITHDRAWAL,
    { withdrawalId: WITHDRAWAL, reason: 'the chain rejected the transaction', refundable: false },
    { actor: 'service:settlement' },
  )
  assert.deepEqual(RULES['settlement.outbound.failed']?.recipients(event), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('a refundable failure says the money is coming back, and is high rather than critical', () => {
  const event = registeredEvent('settlement.outbound.failed', WITHDRAWAL, failedWithdrawal(true), {
    actor: 'service:settlement',
  })
  const rule = RULES['settlement.outbound.failed']
  assert.ok(rule)
  assert.deepEqual(outcomeOf(rule, event), {
    priority: 'high',
    templateId: 'withdrawal.failed_refunded',
  })
  const text = sentence(event)
  assert.match(text, /coming back|being returned to your balance/)
  assert.doesNotMatch(text, /still held/, 'the money is back; saying it is held is the other fact')
  assert.match(text, new RegExp(WITHDRAWAL), 'the id a person quotes to support')
  assert.match(text, /the chain rejected the transaction/, "the producer's reason, not a stock line")
})

test('a non-refundable failure says the money is held, is critical, and never suggests a retry', () => {
  const event = registeredEvent('settlement.outbound.failed', WITHDRAWAL, failedWithdrawal(false), {
    actor: 'service:settlement',
  })
  const rule = RULES['settlement.outbound.failed']
  assert.ok(rule)
  assert.deepEqual(outcomeOf(rule, event), {
    priority: 'critical',
    templateId: 'withdrawal.failed_held',
  })
  const text = sentence(event)
  assert.match(text, /still held/)
  assert.doesNotMatch(
    text,
    /coming back|being returned to your balance/,
    'the expensive error: telling somebody their money is back while wallet is holding it',
  )
  // The payment may have left the platform. "Try again" here is an invitation to pay twice, and
  // wallet refuses to refund for exactly that reason (wallet/src/withdrawals.ts, failWithdrawal).
  assert.doesNotMatch(text, /You can request it again/)
})

/**
 * The default, and the reason this rule has a `variant` rather than a ternary somebody wrote the
 * right way round once.
 *
 * `refundable` is a required boolean on settlement's emit today, so an absent field means the
 * producer regressed, a relay dropped it, or an older event is being replayed. Every one of those
 * is a case where the truthful answer is "we do not know", and "we do not know" must read as HELD:
 * `wallet/src/server.ts:875` refuses to refund without proof because refunding a payment that
 * really landed pays the user twice, and `activity/src/classify.ts:192` mirrors it so a feed entry
 * cannot contradict the balance on the same screen. This rule is the third reader and defaults the
 * same way. The string and the number are here because `refundable` arriving over JSON from a
 * producer that stringified it is the realistic near-miss, and `=== true` refuses all of them.
 */
test('an absent, string or numeric refundable reads as HELD — the only safe direction', () => {
  const rule = RULES['settlement.outbound.failed']
  assert.ok(rule)
  for (const value of [undefined, 'true', 1, null, {}, 'yes']) {
    const event = registeredEvent('settlement.outbound.failed', WITHDRAWAL, failedWithdrawal(value), {
      actor: 'service:settlement',
    })
    assert.deepEqual(
      outcomeOf(rule, event),
      { priority: 'critical', templateId: 'withdrawal.failed_held' },
      `refundable=${JSON.stringify(value)} must not be read as "the money is coming back"`,
    )
    assert.doesNotMatch(sentence(event), /coming back|being returned to your balance/)
  }
})

test('a late withdrawal and a failed one are two notifications, not one deduped into silence', () => {
  // settlement.withdrawal.stuck keys `withdrawal.failed:<id>`. If this rule reused that key, a
  // withdrawal that went late and then failed would collapse into the "it is late" notification
  // and the user would never hear how it ended. The disposition is in the key for that reason,
  // and because a held failure later corrected to a refunded one must not dedupe into the thing
  // it corrects.
  const stuck = registeredEvent('settlement.withdrawal.stuck', 'ethereum:mainnet', {
    withdrawalId: WITHDRAWAL,
    userId: ALICE,
  })
  const held = registeredEvent('settlement.outbound.failed', WITHDRAWAL, failedWithdrawal(false), {
    actor: 'service:settlement',
  })
  const refunded = registeredEvent('settlement.outbound.failed', WITHDRAWAL, failedWithdrawal(true), {
    actor: 'service:settlement',
  })
  const keys = [stuck, held, refunded].map((event) => {
    const set = RULES[event.topic]?.recipients(event)
    assert.equal(set?.kind, 'recipients')
    return set?.kind === 'recipients' ? set.recipients[0].dedupeKey : ''
  })
  assert.equal(new Set(keys).size, 3, `three facts, three keys: ${keys.join(', ')}`)
  assert.deepEqual(keys, [
    `withdrawal.failed:${WITHDRAWAL}`,
    `withdrawal.failed_held:${WITHDRAWAL}`,
    `withdrawal.failed_refunded:${WITHDRAWAL}`,
  ])
  // And a redelivery of the same failure is one key, so at-least-once delivery is still one alert.
  const again = registeredEvent('settlement.outbound.failed', WITHDRAWAL, failedWithdrawal(false), {
    actor: 'service:settlement',
  })
  assert.notEqual(again.id, held.id)
  const set = RULES['settlement.outbound.failed']?.recipients(again)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].dedupeKey, keys[1])
})
