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
  malformedProposals,
  staleGaps,
  unmappedTopics,
  unregisteredRuleTopics,
} from './topics.ts'

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
  assert.ok(UNPRODUCED_NOTIFICATIONS.length >= 10)
  for (const gap of UNPRODUCED_NOTIFICATIONS) {
    assert.ok(gap.requirement.length > 5, `${gap.guessedTopic}: name the AD-08 requirement`)
    assert.equal(hasRule(gap.guessedTopic), false, `${gap.guessedTopic} is recorded AND mapped`)
    assert.ok(
      gap.evidence.length > 80,
      `${gap.guessedTopic}: cite the source that proves what the producer emits — under 80 characters is a guess`,
    )
    // A gap whose `emits` is a topic must spell it as a legal topic name, or the next reader
    // greps for a string that cannot exist.
    for (const emitted of gap.emits?.split(', ') ?? []) {
      assert.match(emitted, /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/, `${gap.guessedTopic}: ${emitted}`)
    }
  }
})

test('a recorded gap disappears once its real topic is registered', () => {
  assert.deepEqual(
    staleGaps(),
    [],
    'contracts now names the topic these producers emit — write the rule and delete the record',
  )
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
