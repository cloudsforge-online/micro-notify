/**
 * The consumer half of the bus contract, checked in both directions.
 *
 * The direction this service already had — every registry topic is mapped or has a written reason
 * — is asserted here too, so both halves are read together. The direction it did not have is the
 * first test: a rule for a topic no registry names is a notification that cannot fire, and fifteen
 * of them shipped because nothing looked.
 *
 * No database. Pure set arithmetic over the rule table and the frozen registry, so it runs in CI
 * even when the database-backed suite skips.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOPIC_NAMES, isRegisteredTopic } from '@cloudsforge/contracts-events'
import { MAPPED_TOPICS, NON_NOTIFYING_TOPICS, RULES, hasRule, isKnownTopic } from './catalogue.ts'
import {
  AWAITING_REGISTRATION,
  UNPRODUCED_NOTIFICATIONS,
  adoptedProposals,
  contradictedGaps,
  inconsistentGaps,
  malformedProposals,
  unmappedTopics,
  unregisteredRuleTopics,
} from './topics.ts'
import { unregisteredEvent, ALICE } from './testsupport.ts'

test('every rule maps a topic the estate has a name for', () => {
  // The direction that was missing. A rule keyed to a topic no producer can legally emit is a
  // feature that reports itself as delivered: the coverage test counts it, AD-08 is satisfied on
  // paper, and no notification is ever produced.
  assert.deepEqual(
    unregisteredRuleTopics(),
    [],
    'a rule for a topic in neither the registry nor AWAITING_REGISTRATION — find the producer, then delete the rule or register the topic it really emits',
  )
  // And the registry is being read rather than the check passing vacuously.
  assert.ok(TOPIC_NAMES.length >= 40)
  assert.ok(MAPPED_TOPICS.length >= 25)
})

test('every registry topic is mapped or explicitly not notifying', () => {
  // The half that already existed, asserted beside its opposite so neither is read alone.
  assert.deepEqual(
    unmappedTopics(),
    [],
    'a registry topic with no rule and no recorded reason — decide what notify does with it',
  )
})

test('a pending proposal disappears once contracts adopts it', () => {
  assert.deepEqual(
    adoptedProposals(),
    [],
    'the registry now names these — delete them from AWAITING_REGISTRATION',
  )
})

test('every pending proposal carries a spec that could be pasted into the registry', () => {
  assert.deepEqual(
    malformedProposals(),
    [],
    'a proposal needs a valid topic name under its producer, a real ordering key, the emit site that proves the producer sends it, and a reason worth reading',
  )
})

/**
 * The eleven rules that could never fire, and what each one's producer actually emits.
 *
 * This is the regression pin. Re-adding any of these names is re-adding the defect, because the
 * name is the thing that was wrong — the notification each one described is still wanted, and the
 * repair is to register what the producer really sends and key a rule to that.
 *
 * Four of the eleven have since had that repair: `trade.bot.stopped` is now a rule on
 * `trade.bot.paused`, `devplatform.apikey.created` and `.revoked` are rules on
 * `devplatform.key.issued` and `.revoked`, and `identity.password.changed` rides
 * `identity.session.revoked`. The guessed names below stay wrong and stay refused.
 */
test('the rules for topics nobody emits stay deleted', () => {
  for (const topic of [
    'identity.password.changed',
    'policy.limit.reached',
    'wallet.deposit.detected',
    'settlement.transaction.failed',
    'trade.bot.triggered',
    'trade.bot.stopped',
    'market.offer.received',
    'market.auction.ended',
    'devplatform.apikey.created',
    'devplatform.apikey.revoked',
    'admin_api.incident.opened',
  ]) {
    assert.equal(hasRule(topic), false, `${topic} has no producer — a rule for it cannot fire`)
    assert.equal(isRegisteredTopic(topic), false, `${topic} is emitted by nobody; do not register it`)
    // And it is not accepted at /ingest either, so a POST naming one is refused rather than stored.
    assert.equal(isKnownTopic(topic), false)
  }
})

test('every unproduced notification names the producer that decided it', () => {
  assert.ok(UNPRODUCED_NOTIFICATIONS.length >= 5, 'the records are being read, not an empty array')
  for (const gap of UNPRODUCED_NOTIFICATIONS) {
    assert.ok(gap.requirement.length > 5, `${gap.guessedTopic}: name the AD-08 requirement`)
    assert.equal(hasRule(gap.guessedTopic), false, `${gap.guessedTopic} is recorded AND mapped`)
    assert.ok(
      gap.evidence.length > 80,
      `${gap.guessedTopic}: cite the source that proves what the producer emits — under 80 characters is a guess`,
    )
    // A gap whose `emits` is a topic must spell it as ONE legal topic name. A list would be prose,
    // and micro-org's estate check matches this field as a literal — the record that spelled three
    // topics into it ('trade.bot.created, trade.bot.started, trade.bot.paused') was invisible to
    // that check for exactly this reason.
    if (gap.emits !== null) {
      assert.match(gap.emits, /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/, `${gap.guessedTopic}: ${gap.emits}`)
    }
    // An owner, or the one reason there is nothing to own.
    if (gap.blockedBy === 'other-channel') {
      assert.equal(gap.owner, null, `${gap.guessedTopic}: already delivered; nothing to change`)
    } else {
      assert.match(gap.owner ?? '', /^micro-[a-z-]+$/, `${gap.guessedTopic}: name the repository that closes it`)
    }
  }
})

test('a record cannot claim a reason its own fields contradict', () => {
  assert.deepEqual(
    inconsistentGaps(),
    [],
    "a record's blockedBy disagrees with its emits/owner — see UnproducedNotification for what each reason implies",
  )
})

/**
 * The check that replaced `staleGaps()`, and the only staleness this checkout can prove.
 *
 * The old one asked whether the shared registry NAMED the topic a producer emits. It never fired
 * and never could have: every record it watched described a topic a live producer emits and no
 * registry names, which is the state it read as "still true". Five records sat here for weeks
 * saying a notification was impossible while trade, market and devplatform were emitting the exact
 * names this service had written down.
 *
 * This asks the question notify owns instead: does this service's own rule table contradict the
 * record? Writing the rule now deletes the record, which is the failure mode the five had. The
 * cross-repository half — is a producer emitting it at all — belongs to micro-org's
 * tools/estate-topics.mjs, which is the only checkout that can see both halves, and is what found
 * these. Neither half pretends to do the other's job.
 */
test('a recorded gap disappears once this service writes the rule it said was impossible', () => {
  assert.deepEqual(
    contradictedGaps(),
    [],
    'a rule exists for the topic this record says cannot be notified on — delete the record',
  )
})

/**
 * The three rules the five stale records were hiding, driven with the producer's REAL payload.
 *
 * A rule that resolves no recipient is as dead as no rule, and two of the five turned out to be
 * exactly that — their records stayed, with the reason. These three must therefore be shown to
 * address somebody from the shape the producer actually emits, copied field for field from the
 * emit site named in each quarantine entry. Asserting `hasRule` alone would repeat the mistake the
 * whole file exists to stop: counting a rule as coverage without ever running it.
 */
test('each newly live rule addresses a real recipient from the payload its producer really sends', () => {
  const cases = [
    {
      // trade/src/bots.ts:614 — payload { botId }, actor the bot's OWNER.
      topic: 'trade.bot.paused',
      payload: { botId: 'bot-1' },
      actor: `user:${ALICE}`,
      dedupeKey: 'trading.bot_paused:bot-1',
    },
    {
      // devplatform/src/apikeys.ts:272 — the display and the project, never the key, and the actor
      // is the caller: `user:<id>` for a session, which under a stolen session IS the victim's id.
      topic: 'devplatform.key.issued',
      payload: { keyId: 'key-1', projectId: 'p-1', environment: 'live', display: 'cfk_live_abc', scopes: [] },
      actor: `user:${ALICE}`,
      dedupeKey: 'api.key_issued:key-1',
    },
    {
      topic: 'devplatform.key.revoked',
      payload: { keyId: 'key-1', projectId: 'p-1', environment: 'live', display: 'cfk_live_abc', lookupId: 'abc', reason: '' },
      actor: `user:${ALICE}`,
      dedupeKey: 'api.key_revoked:key-1',
    },
  ] as const

  for (const each of cases) {
    assert.equal(hasRule(each.topic), true, `${each.topic} has no rule`)
    // Unregistered on purpose: each is quarantined with the spec that registers it, and `events.ts`
    // accepts an unregistered topic exactly when a rule exists.
    assert.equal(isRegisteredTopic(each.topic), false, `${each.topic} is registered — delete the quarantine entry`)
    assert.ok(Object.hasOwn(AWAITING_REGISTRATION, each.topic), `${each.topic} is not quarantined`)

    const event = unregisteredEvent(each.topic, 'k-1', { ...each.payload }, { actor: each.actor })
    const set = RULES[each.topic]?.recipients(event)
    assert.equal(set?.kind, 'recipients', `${each.topic} resolves nobody from what its producer sends`)
    if (set?.kind !== 'recipients') continue
    assert.equal(set.recipients.length, 1)
    assert.equal(set.recipients[0].userId, ALICE)
    assert.equal(set.recipients[0].dedupeKey, each.dedupeKey, 'keyed on the domain id, never on the event id')
  }

  // And an envelope with no user anywhere is no_recipient rather than a guess — the `key:<display>`
  // and `system:identity` actors devplatform also emits under (server.ts:965, :1527).
  const anonymous = unregisteredEvent(
    'devplatform.key.revoked',
    'k-1',
    { keyId: 'key-1', projectId: 'p-1' },
    { actor: 'service:devplatform' },
  )
  assert.deepEqual(RULES['devplatform.key.revoked']?.recipients(anonymous), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

/**
 * The two that did NOT become rules, and why the difference is not a judgement call.
 *
 * Both topics are emitted by a live producer, which is what micro-org's check saw. Neither envelope
 * names anybody this service could notify: settlement's failure is wallet's narrow handover with no
 * userId and no actor, and market's offer names the OFFERER while the notification is for the
 * SELLER. A rule on either would answer no_recipient for ever, or — worse for market — address the
 * wrong person. This pins that they stay recorded rather than quietly acquiring a rule that reports
 * coverage it does not have.
 */
test('a topic whose envelope names nobody stays a record, not a rule', () => {
  for (const topic of ['settlement.outbound.failed', 'market.offer.made']) {
    assert.equal(hasRule(topic), false, `${topic} has a rule and its envelope names no recipient`)
    const gap = UNPRODUCED_NOTIFICATIONS.find((each) => each.emits === topic)
    assert.ok(gap, `${topic} is neither ruled nor recorded`)
    assert.equal(gap?.blockedBy, 'no-subject')
    assert.match(gap?.owner ?? '', /^micro-(settlement|market)$/)
  }
  // settlement.outbound.failed was registered by contracts while this change was being written, so
  // it needs the OTHER half of the coverage rule as well: a registered topic must be mapped or have
  // a written reason. Its reason has to name the requirement that is still owed, or registering it
  // would look like closing it.
  assert.equal(isKnownTopic('settlement.outbound.failed'), true)
  assert.match(
    NON_NOTIFYING_TOPICS['settlement.outbound.failed'] ?? '',
    /withdrawal transaction failed outright/,
    'the non-notifying reason must point at the notification that is still missing',
  )
  // market.offer.made is not registered, so it is not accepted at /ingest either.
  assert.equal(isKnownTopic('market.offer.made'), false)
})

/**
 * The rules the registration wave made reachable.
 *
 * Each was mapped here and emitted by a live producer while the registry named neither, so each
 * was a written, signed, delivered event that every consumer refused. Registering the topic is
 * what turns the existing rule on.
 */
test('the topics registered from a live producer are the ones this service already mapped', () => {
  for (const topic of [
    'identity.mfa.added',
    'wallet.wallet.created',
    'community.proposal.opened',
    'community.vote.cast',
  ]) {
    assert.equal(isRegisteredTopic(topic), true, `${topic} is emitted today`)
    assert.equal(hasRule(topic), true, `${topic} has a rule and can now fire`)
  }
})

test('the password-change notification is keyed to the event identity really emits', () => {
  // identity announces no password change; it revokes every session with a reason
  // (identity/src/server.ts:960). §10.3's password-change entry rides that event or it does not
  // exist at all, which is what it did for the whole life of this service.
  assert.equal(hasRule('identity.session.revoked'), true)
  assert.equal(isRegisteredTopic('identity.session.revoked'), true)
  assert.equal(RULES['identity.session.revoked']?.priority, 'critical')
  assert.equal(hasRule('identity.password.changed'), false)
})

test('a non-notifying reason is a decision, and only for topics that exist', () => {
  for (const [topic, reason] of Object.entries(NON_NOTIFYING_TOPICS)) {
    assert.equal(isRegisteredTopic(topic), true, `${topic} is not in the registry at all`)
    assert.ok(reason.length > 40, `${topic} needs a real reason, not a label`)
    assert.equal(hasRule(topic), false, `${topic} is both mapped and recorded as not notifying`)
  }
})

test('the quarantine is a rule-side escape hatch, not a rule-side exemption', () => {
  // Every quarantined topic must actually have a rule: the quarantine explains a rule that is
  // ahead of the registry, and an entry with no rule explains nothing.
  for (const topic of Object.keys(AWAITING_REGISTRATION)) {
    assert.equal(hasRule(topic), true, `${topic} is quarantined but this service has no rule for it`)
  }
})
