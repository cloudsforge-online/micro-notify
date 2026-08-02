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
  ruleFor,
  unmappedRegistryTopics,
} from './catalogue.ts'
import { CATEGORIES, PRIORITIES, isCategory, isPriority } from './model.ts'
import { TEMPLATES, isTemplateId, templateFor } from './templates.ts'
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

test('every event AD-08 names has a rule', () => {
  // The list from AD-08 and the notify epic, spelled as topics. Each entry is one of the
  // twenty-one kinds of notification this service exists to make real.
  const required = [
    // new-device sign-in — two producers, one fact
    'identity.session.created',
    'identity.device.added',
    // password or MFA change
    'identity.password.changed',
    'identity.mfa.removed',
    'identity.mfa.added',
    // wallet created
    'wallet.wallet.created',
    // key exported
    'custody.export.requested',
    'custody.key.exported',
    // deposit detected / confirmed
    'wallet.deposit.detected',
    'wallet.deposit.confirmed',
    // withdrawal requested / completed / failed
    'wallet.withdrawal.requested',
    'settlement.withdrawal.completed',
    'settlement.withdrawal.stuck',
    'settlement.transaction.failed',
    // trading-bot event
    'trade.bot.triggered',
    'trade.bot.stopped',
    // risk limit reached
    'policy.limit.reached',
    // marketplace sale / offer / auction
    'market.listing.sold',
    'market.offer.received',
    'market.auction.ended',
    // token deployment
    'mint.deploy.confirmed',
    // game reward
    'worlds.reward.granted',
    // community proposal / governance vote
    'community.proposal.opened',
    'community.proposal.executed',
    'community.vote.cast',
    // API-key event
    'devplatform.apikey.created',
    'devplatform.apikey.revoked',
    // service incident
    'admin_api.incident.opened',
  ]
  for (const topic of required) {
    assert.ok(ruleFor(topic), `AD-08 requires a rule for ${topic}`)
  }
  assert.ok(MAPPED_TOPICS.length >= required.length)
})

test('exactly the events 04-domain-model §10.3 names are critical', () => {
  const critical = MAPPED_TOPICS.filter((topic) => RULES[topic]?.priority === 'critical').sort()
  assert.deepEqual(critical, [
    'custody.export.requested',
    'custody.key.exported',
    'identity.device.added',
    'identity.mfa.added',
    'identity.mfa.removed',
    'identity.password.changed',
    'identity.session.created',
    'wallet.withdrawal.requested',
  ])
})

test('every rule names a real category, priority and template', () => {
  for (const [topic, rule] of Object.entries(RULES)) {
    assert.ok(isCategory(rule.category), `${topic}: unknown category ${rule.category}`)
    assert.ok(isPriority(rule.priority), `${topic}: unknown priority ${rule.priority}`)
    assert.ok(isTemplateId(rule.templateId), `${topic}: unknown template ${rule.templateId}`)
    assert.ok(rule.why.length > 30, `${topic}: say why this interrupts someone`)
    assert.ok(CATEGORIES.includes(rule.category))
    assert.ok(PRIORITIES.includes(rule.priority))
  }
})

test("a rule's category agrees with its template's", () => {
  for (const [topic, rule] of Object.entries(RULES)) {
    if (!isTemplateId(rule.templateId)) continue
    const template = templateFor(rule.templateId)
    assert.equal(
      rule.category,
      template.category,
      `${topic} files under ${rule.category} but renders a ${template.category} template`,
    )
  }
})

test('every rule supplies every parameter its template requires', () => {
  // The check that stops "Hello undefined" reaching a user. Each rule is run against a payload
  // holding nothing at all, so it passes only if the rule's fallbacks cover every parameter.
  for (const [topic, rule] of Object.entries(RULES)) {
    const event = unregisteredEvent(topic, ALICE, { user_ids: [ALICE], new_device: true })
    const set = rule.recipients({ ...event, actor: `user:${ALICE}` })
    if (set.kind === 'none') continue
    if (!isTemplateId(rule.templateId)) continue
    const template = templateFor(rule.templateId)
    for (const recipient of set.recipients) {
      for (const name of template.params) {
        assert.notEqual(
          recipient.params[name],
          undefined,
          `${topic} does not supply ${name} for ${rule.templateId}`,
        )
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
  const used = new Set<string>(Object.values(RULES).map((rule) => rule.templateId))
  // These three are produced by the service itself rather than by an event.
  const platform = new Set(['system.broadcast', 'digest.summary'])
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
