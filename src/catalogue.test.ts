/**
 * The mapping table: coverage, dedupe keys, and the parameters each rule must supply.
 *
 * These are the tests that fail when somebody adds a topic to the shared registry and nobody
 * decides what notify should do about it — which, given the fan-in is the entire bus, is the most
 * likely way this service quietly stops covering something.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TOPIC_NAMES, isRegisteredTopic } from '@cloudsforge/contracts-events'
import {
  MAPPED_TOPICS,
  NON_NOTIFYING_TOPICS,
  RULES,
  hasRule,
  isKnownTopic,
  outcomeOf,
  outcomesOf,
  ruleFor,
  unmappedRegistryTopics,
} from './catalogue.ts'
import { CATEGORIES, DEFAULT_LOCALE, PRIORITIES, PRIORITY_RANK, isCategory, isPriority } from './model.ts'
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
    // service because the envelope named nobody; settlement added `userId` (withdrawals.ts)
    // and the record in topics.ts had to go, because contradictedGaps() refuses to hold both.
    'settlement.outbound.failed',
    // marketplace sale, and the offer that precedes one
    'market.listing.sold',
    // "marketplace offer received". Refused for the life of the service because the envelope named
    // only the OFFERER; market/src/bids.ts now sends `sellerSubject`, so the rule goes to the
    // person who did NOT act. Still unregistered, so it is quarantined in AWAITING_REGISTRATION.
    'market.offer.made',
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
    'auction ended',
    'service incident',
  ]) {
    assert.ok(recorded.has(requirement), `AD-08 names "${requirement}" and nothing here accounts for it`)
  }
  // And the two that closed within an hour of each other, each because a producer added ONE FIELD.
  // Both were in the list above; keeping either there while a rule exists is the exact
  // contradiction contradictedGaps() fails on. Asserted from BOTH sides so neither half is
  // forgotten — the requirement must be live in `live`, and absent from the records.
  for (const closed of ['withdrawal transaction failed outright', 'marketplace offer received']) {
    assert.equal(
      recorded.has(closed),
      false,
      `"${closed}" is a rule now — a record saying it cannot be produced contradicts the catalogue`,
    )
  }
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

/**
 * The rule that teaches this service an address, graded against the payload it will actually get.
 *
 * `pipeline.test.ts` proves the mail goes; this proves the rule reads the right FIELDS, which is
 * the half a pipeline test cannot see — a rule that read the wrong key would still produce a
 * perfectly well-formed notification, addressed to nobody, exactly as the last year of this service
 * did. Every field below is one identity is to emit: `userId`, `handle`, `email`, `verifyUrl`.
 *
 * The negative half is `identity.user.registered`, and it is not padding. Its payload is
 * `{ userId, handle, organisationId, organisationSlug }` (identity/src/users.ts) and carries
 * **no address at all**, which is why the registration mail could never have gone out however well
 * the SMTP was configured. A `learns` on that rule would read `undefined` and store nothing while
 * reporting the gap closed.
 */
test('the verification rule reads the fields identity emits, and registration carries no address', () => {
  const rule = RULES['identity.email.verification_requested']
  assert.ok(rule, 'the only event in the estate that carries an email address has no rule')
  if (!rule) return

  const link = 'https://app.cloudsforge.test/verify/this-is-not-a-real-token'
  const event = unregisteredEvent(
    'identity.email.verification_requested',
    ALICE,
    { userId: ALICE, handle: 'alice', email: 'alice@example.test', verifyUrl: link },
    { actor: `user:${ALICE}` },
  )

  assert.equal(rule.learns?.channel, 'email')
  assert.equal(rule.learns?.read(event), 'alice@example.test')
  // Read from the payload, never from the envelope actor — see `LearnedAddress.subject`.
  assert.equal(rule.learns?.subject(event), ALICE)
  const anonymous = unregisteredEvent(
    'identity.email.verification_requested',
    ALICE,
    { handle: 'alice', email: 'alice@example.test' },
    { actor: `user:${BOB}` },
  )
  assert.equal(rule.learns?.subject(anonymous), null, 'the actor was read as the address owner')

  const set = rule.recipients(event)
  assert.equal(set.kind, 'recipients')
  if (set.kind !== 'recipients') return
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].params['handle'], 'alice')
  assert.equal(set.recipients[0].params['verifyUrl'], link)
  assert.equal(set.recipients[0].subjectUrn, `cf:identity:user:${ALICE}`)
  // Keyed on the event, uniquely among every rule in this table. Two requests are two links and
  // two facts; collapsing them would leave a reader who asked for a second one with nothing.
  assert.equal(set.recipients[0].dedupeKey, `account.verify_email:${event.id}`)

  // And the registration event, which is where everybody assumed the address was.
  assert.equal(RULES['identity.user.registered']?.learns, undefined)
})

test('a link this service would not put in a mail becomes the page that can issue a new one', () => {
  const rule = RULES['identity.email.verification_requested']
  const read = (verifyUrl: unknown) => {
    const event = unregisteredEvent(
      'identity.email.verification_requested',
      ALICE,
      { userId: ALICE, handle: 'alice', email: 'alice@example.test', verifyUrl },
      { actor: `user:${ALICE}` },
    )
    const set = rule?.recipients(event)
    return set?.kind === 'recipients' ? set.recipients[0].params['verifyUrl'] : undefined
  }

  // `renderTemplate` resolves the value with `new URL(path, base)`, which returns these unchanged
  // — and the message exists to ask somebody to open the thing it carries.
  for (const hostile of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url', '', 42]) {
    assert.equal(read(hostile), '/settings/account', `${String(hostile)} reached a mail body`)
  }
  // A relative fallback resolves against NOTIFY_PUBLIC_URL rather than leaving a blank link.
  const rendered = renderTemplate(
    TEMPLATES['account.verify_email'],
    { handle: 'alice', verifyUrl: '/settings/account' },
    DEFAULT_LOCALE,
    'https://app.cloudsforge.test',
  )
  assert.equal(rendered.link, 'https://app.cloudsforge.test/settings/account')
  assert.deepEqual(rendered.missing, [])

  // And a real one survives untouched, query string and all.
  assert.equal(
    read('https://app.cloudsforge.test/verify?t=this-is-not-a-real-token'),
    'https://app.cloudsforge.test/verify?t=this-is-not-a-real-token',
  )
})

test('an address the producer did not send is null, never a fallback string', () => {
  // A fallback here would write a durable channel_targets row addressed at something that is not an
  // address, and every later delivery would fail at a provider instead of being visibly absent.
  const rule = RULES['identity.email.verification_requested']
  for (const email of [undefined, '', 'not-an-address', 'two words@example.test', 12]) {
    const event = unregisteredEvent(
      'identity.email.verification_requested',
      ALICE,
      { userId: ALICE, handle: 'alice', email },
      { actor: `user:${ALICE}` },
    )
    assert.equal(rule?.learns?.read(event), null, `${String(email)} was kept as an address`)
  }
})

test('every template is reachable from some rule, or is a platform template', () => {
  // Over every OUTCOME, not `rule.templateId`: a variant's template is reachable too, and reading
  // only the rule's own would have reported `withdrawal.failed_refunded` as written-but-unrendered.
  const used = new Set<string>(
    Object.values(RULES).flatMap((rule) => outcomesOf(rule).map((each) => each.templateId)),
  )
  // Produced by the service itself rather than by an event. `system.incident` joined them when
  // the admin_api.incident.opened rule was deleted: an incident reaches users as an operator
  // broadcast (POST /admin/broadcasts names a template id, pipeline.ts), which is the path
  // that was actually carrying it — the deleted rule was a no-op that never routed anything.
  const platform = new Set(['system.broadcast', 'digest.summary', 'system.incident'])
  for (const id of Object.keys(TEMPLATES)) {
    assert.ok(used.has(id) || platform.has(id), `${id} is written but nothing renders it`)
  }
})

test('provision.failed notifies the SUBJECT, and the service actor never becomes a recipient', () => {
  // worlds.provision.failed is keyed by entitlement id, the buyer is payload.subject
  // (worlds/src/provisioning.ts), and the envelope actor is `service:worlds` — so userIdOf's
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

/** The exact payload `settlement/src/withdrawals.ts` builds. `undefined` omits the field. */
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
 * `wallet/src/server.ts` refuses to refund without proof because refunding a payment that
 * really landed pays the user twice, and `activity/src/classify.ts` mirrors it so a feed entry
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
  // settlement.withdrawal.stuck keys `withdrawal.stuck:<id>`. If this rule reused that key, a
  // withdrawal that went late and then failed would collapse into the "it is late" notification
  // and the user would never hear how it ended. The disposition is in the key for that reason,
  // and because a held failure later corrected to a refunded one must not dedupe into the thing
  // it corrects.
  //
  // The stuck key was `withdrawal.failed:<id>` until #221: the topic rendered the failure
  // template, so its key inherited the failure's name for a withdrawal that had not failed. The
  // three keys were already distinct, so this test stayed green through the whole defect — it
  // pins that the dispositions differ, not that any of them is named truthfully.
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
    `withdrawal.stuck:${WITHDRAWAL}`,
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

/* --------------------------------------------------------------------------------------------
 * #221 — a stuck withdrawal must never tell the user their balance is untouched.
 *
 * The reservation posts `available → reserved` when the withdrawal is REQUESTED, and reaching
 * `stuck` returns none of it: settlement's `markStuck` is "never a refund"
 * (`settlement/src/worker.ts`) and wallet's twin sweep "does not refund anything — the payment
 * may have landed" (`wallet/src/withdrawals.ts`). So while this mail is being read, the money
 * is reserved and unspendable — and the mail said "Nothing has left your balance. You can try
 * again."
 *
 * These tests drive the real rule and render the real template. They assert on the FACT the words
 * convey, not that a message renders: a build that reinstates the reassurance, or invites a retry
 * against a balance that is still holding the first reservation, goes red here.
 * -------------------------------------------------------------------------------------------- */

/** Settlement's payload, as `stuckEvents` really builds it (`settlement/src/withdrawals.ts`). */
function stuckWithdrawal(broadcastAt: string | null): Record<string, unknown> {
  return {
    outboundId: '44444444-4444-4444-8444-444444444444',
    purpose: 'withdrawal',
    chain: 'litecoin',
    network: 'mainnet',
    assetCode: 'LTC',
    from: 'ltc1qplatform',
    to: 'ltc1quser',
    // SMALLEST UNITS. Litecoin is 8 decimals, so this is 1.5 LTC — and it is the shape #199 is
    // about: rendered as money it reads as a hundred and fifty million.
    amount: '150000000',
    fee: '1000',
    txHash: broadcastAt === null ? null : `0x${'ab'.repeat(32)}`,
    withdrawalId: WITHDRAWAL,
    userId: ALICE,
    reason: 'this payment has not been seen on chain since it was broadcast',
    signedNonce: '7',
    broadcastAt,
    adjudicateWith: 'POST /v1/outbound/44444444-4444-4444-8444-444444444444/adjudicate',
  }
}

/** Drive topic → rule → outcome → template, exactly as the pipeline does. */
function stuckMail(broadcastAt: string | null): { subject: string; body: string; templateId: string } {
  const event = registeredEvent('settlement.withdrawal.stuck', 'litecoin:mainnet', stuckWithdrawal(broadcastAt), {
    actor: 'service:settlement',
    occurredAt: '2026-08-06T09:30:00.000Z',
  })
  const rule = RULES[event.topic]
  assert.ok(rule, 'a stuck withdrawal must reach the user')
  const set = rule.recipients(event)
  assert.equal(set.kind, 'recipients')
  if (set.kind !== 'recipients') return { subject: '', body: '', templateId: '' }
  const outcome = outcomeOf(rule, event)
  assert.ok(isTemplateId(outcome.templateId))
  if (!isTemplateId(outcome.templateId)) return { subject: '', body: '', templateId: '' }
  const rendered = renderTemplate(
    templateFor(outcome.templateId),
    set.recipients[0].params,
    DEFAULT_LOCALE,
    'https://app.cloudsforge.test',
  )
  assert.deepEqual(rendered.missing, [], 'a gap in a message about held money')
  return { subject: rendered.subject, body: rendered.body, templateId: outcome.templateId }
}

test('a stuck withdrawal is never told the balance is untouched, in either state it can be in', () => {
  for (const broadcastAt of [null, '2026-08-06T09:00:00.000Z']) {
    const { subject, body } = stuckMail(broadcastAt)
    const text = `${subject}\n${body}`
    const where = broadcastAt === null ? 'not broadcast' : 'broadcast'

    // The defect, verbatim and in the family it belongs to. The funds ARE reserved as this is read.
    assert.doesNotMatch(text, /nothing has left your balance/i, `${where}: the #221 sentence is back`)
    assert.doesNotMatch(text, /nothing has (left|gone|moved)/i, `${where}: claims the money did not move`)
    assert.doesNotMatch(text, /your balance is unaffected|balance (is|was) untouched/i, `${where}: false reassurance`)
    // A refund has NOT happened — `markStuck` never issues one.
    assert.doesNotMatch(text, /returned to your balance|refunded|coming back/i, `${where}: promises a refund`)
    // A retry takes a SECOND reservation out of what the first one left.
    assert.doesNotMatch(text, /you can (try|request) (it )?again|please try again/i, `${where}: invites a retry`)

    // And it states the true fact, in the two words the balance itself uses.
    assert.match(text, /\bheld\b/i, `${where}: must say the amount is held`)
    assert.match(text, /\breserved\b/i, `${where}: must name the money as reserved, not available`)
    assert.match(text, /do not request it again/i, `${where}: must say not to retry`)
    // Requirement 3: what happens next, and the handle to quote.
    assert.match(text, /tracked|looking at it/i, `${where}: must say what happens next`)
    assert.ok(text.includes(WITHDRAWAL), `${where}: must carry the withdrawal id for support`)
  }
})

test('a stuck withdrawal tells the truth about the network, and only what broadcastAt proves', () => {
  // The two states are different facts and the payload can tell them apart, so the user gets the
  // one that is true rather than a sentence stretched over both.
  const unsent = stuckMail(null)
  const sent = stuckMail('2026-08-06T09:00:00.000Z')
  assert.equal(unsent.templateId, 'withdrawal.stuck')
  assert.equal(sent.templateId, 'withdrawal.stuck_sent')
  assert.notEqual(unsent.subject, sent.subject, 'two states, two messages')

  // Without evidence of a broadcast, the mail must not claim a transaction is out there.
  assert.match(unsent.body, /cannot yet confirm whether the payment reached the network/i)
  assert.doesNotMatch(unsent.body, /was sent to the network/i, 'asserts a broadcast it cannot know about')
  // With it, it may say so — and must still not promise the outcome.
  assert.match(sent.body, /was sent to the network/i)
  assert.match(sent.body, /may still confirm/i)
  assert.doesNotMatch(sent.body, /will (confirm|complete|arrive)\b/i, 'promises an outcome nobody knows')

  // An empty string is not a timestamp. `BigInt('') === 0n` is this codebase's recurring defect,
  // and the stringly form of it would silently promote every unsent withdrawal to "sent".
  assert.equal(stuckMail('').templateId, 'withdrawal.stuck')
})

test('a stuck withdrawal never renders smallest units as money — #199 on a live money path', () => {
  // The payload's `amount` is 150000000 for 1.5 LTC, and notify has no decimals for any asset:
  // no contracts-chain dependency, no divisor, no formatter. The old `withdrawal.failed` template
  // took `amount` straight off this payload, so the mail read "A withdrawal of 150000000 LTC".
  for (const broadcastAt of [null, '2026-08-06T09:00:00.000Z']) {
    const { subject, body } = stuckMail(broadcastAt)
    const text = `${subject}\n${body}`
    assert.doesNotMatch(text, /150000000/, 'a smallest-unit integer rendered as an amount of money')
    // Nothing that reads as a quantity of the asset at all, since none can be computed correctly.
    assert.doesNotMatch(text, /\d[\d,.]*\s*LTC\b/i, 'an amount of LTC notify cannot possibly know')
  }
})

test('the sentence #221 is about is gone from the service, not just unreferenced', () => {
  // `withdrawal.failed` had exactly ONE consumer — this stuck rule — so it was never the shared
  // template it looked like, and leaving it would leave the wording one `templateId:` away from
  // being live again on a money topic.
  assert.equal(isTemplateId('withdrawal.failed'), false, 'the deleted template is back')
  const source = readFileSync(new URL('./templates.ts', import.meta.url), 'utf8')
  const live = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  assert.doesNotMatch(live, /Nothing has left your balance/, 'the false sentence is renderable again')
})

/* ==================================================================================================
 * market.offer.made — the rule whose whole difficulty is WHICH person.
 *
 * Every other field on this envelope names the offerer: the actor is `user:<offerer>`,
 * `offererSubject` is them, and the key is the listing. The notification goes to the SELLER. So the
 * failure mode is not silence, it is a well-formed notification delivered to the wrong person about
 * somebody else's money — the same trap as `aetherholm.battle.resolved`, where the actor is the
 * raider and the news is the defender's.
 * ================================================================================================== */

const LISTING = '55555555-5555-4555-8555-555555555555'

/** The payload `market/src/bids.ts` builds, with the seller supplied. */
function offerMade(sellerSubject: unknown): Record<string, unknown> {
  return {
    listingId: LISTING,
    offerId: 'offer-1',
    offererSubject: `user:${BOB}`,
    ...(sellerSubject === undefined ? {} : { sellerSubject }),
    amount: '250',
    assetCode: 'USDC',
  }
}

/** The offerer is the ACTOR, which is the whole trap. */
function offerEvent(sellerSubject: unknown) {
  return unregisteredEvent('market.offer.made', LISTING, offerMade(sellerSubject), {
    actor: `user:${BOB}`,
    producer: 'market',
  })
}

test('an offer notifies the SELLER, never the offerer whose name is on every other field', () => {
  const set = RULES['market.offer.made']?.recipients(offerEvent(`user:${ALICE}`))
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  // The three ways this rule could have addressed the wrong person, each refused by name.
  assert.notEqual(set.recipients[0].userId, BOB, 'the offerer, from offererSubject or the actor')
  assert.notEqual(set.recipients[0].userId, `user:${ALICE}`, 'a subject is not a user id')
  assert.notEqual(set.recipients[0].userId, LISTING, 'the envelope key is the listing')
  assert.equal(set.recipients[0].params['amount'], '250')
  assert.equal(set.recipients[0].params['asset'], 'USDC')
  assert.equal(set.recipients[0].subjectUrn, `cf:market:listing:${LISTING}`)
})

/**
 * **Yesterday's payload.** `{ listingId, offerId, offererSubject, amount, assetCode }` — exactly
 * what market emitted before `sellerSubject` was added, and exactly the state that made this rule
 * refusable for the life of the service.
 *
 * If the rule ever falls back to `forUser`, or to the actor, or to the key, this is the test that
 * goes red — and every other assertion in this block would still pass, because today's payload
 * carries a seller and the fallbacks are never reached. It is `no_recipient` and not
 * `not_applicable`: the producer regressed, and an operator needs to see a producer to page.
 */
test("yesterday's offer payload, with no seller, is no_recipient rather than the offerer", () => {
  assert.deepEqual(RULES['market.offer.made']?.recipients(offerEvent(undefined)), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

/**
 * A listing owned by a service principal.
 *
 * `market/src/server.ts` takes the seller from `subjectOf(principal)`, which spells a service
 * `service:<name>`. Stripping `user:` blindly would produce a "user id" of `mint` — a notification
 * row filed against a user that does not exist, on a table nobody can read. `not_applicable` and
 * not `no_recipient`, because the producer said exactly who the seller is and the answer is that
 * they are not a person: collapsing the two would put a producer on a page for behaving correctly.
 */
test('a listing owned by a service is not_applicable, never a user id spelled from a service name', () => {
  for (const subject of ['service:mint', 'operator:root', 'system']) {
    assert.deepEqual(
      RULES['market.offer.made']?.recipients(offerEvent(subject)),
      { kind: 'none', reason: 'not_applicable' },
      `${subject} is a principal that is not a person`,
    )
  }
  // A bare uuid, or an empty `user:`, is a producer that has stopped spelling a SUBJECT — which is
  // a regression, not a service-owned listing. It must be `no_recipient`, because
  // `not_applicable` here would silently swallow every offer notification while the rule reported
  // itself as working. This is the distinction the first draft of this rule got wrong, and this
  // test is what found it.
  for (const subject of [ALICE, 'user:', 'mint', '']) {
    assert.deepEqual(
      RULES['market.offer.made']?.recipients(offerEvent(subject)),
      { kind: 'none', reason: 'no_recipient' },
      `${subject || '<empty>'} is not a subject; the producer is the thing to fix`,
    )
  }
})

test('two offers on one listing are two notifications, not one deduped into silence', () => {
  const first = RULES['market.offer.made']?.recipients(offerEvent(`user:${ALICE}`))
  const second = RULES['market.offer.made']?.recipients(
    unregisteredEvent(
      'market.offer.made',
      LISTING,
      { ...offerMade(`user:${ALICE}`), offerId: 'offer-2' },
      { actor: `user:${BOB}`, producer: 'market' },
    ),
  )
  assert.equal(first?.kind, 'recipients')
  assert.equal(second?.kind, 'recipients')
  if (first?.kind !== 'recipients' || second?.kind !== 'recipients') return
  // Keyed on the OFFER. Keying on the listing would collapse every offer after the first into the
  // one notification, which for a seller is the difference between an auction and a single bid.
  assert.equal(first.recipients[0].dedupeKey, 'market.offer_received:offer-1')
  assert.equal(second.recipients[0].dedupeKey, 'market.offer_received:offer-2')
  assert.notEqual(first.recipients[0].dedupeKey, second.recipients[0].dedupeKey)
})

/* ==================================================================================================
 * tessera — seven topics registered at once, and the same question asked of all seven.
 *
 * The question is the one that found `market.offer.made`: **does the envelope name only the person
 * who acted?** Three of the seven produced rules, and each of the three is here because a generic
 * recipient helper would have got it wrong or resolved nobody at all. The other four have no rule
 * and are asserted as such — two decisions and two deferrals, which `topics.test.ts` separates.
 * ================================================================================================== */

const PARCEL = '66666666-6666-4666-8666-666666666666'
const OBJECT = '77777777-7777-4777-8777-777777777777'

/** The payload `tessera/src/kiln.ts` builds on the ANCHORED emit. Note the actor. */
function anchoredEvent(authorSubject: unknown) {
  return unregisteredEvent(
    'tessera.object.anchored',
    OBJECT,
    {
      objectId: OBJECT,
      ...(authorSubject === undefined ? {} : { authorSubject }),
      checksum: 'sha256-abc',
      transactionHash: '0xdeadbeef',
      blockNumber: 4_242,
    },
    // `system`, which is the whole point of the test below.
    { actor: 'system', producer: 'tessera' },
  )
}

/**
 * The rule `forUser` could not have written, and the reason is structural rather than stylistic.
 *
 * `userIdOf` has three routes to a person and this envelope defeats all three: no `user_id` on the
 * payload, a registry `keyedBy` of `object_id` rather than `user_id`, and an actor of `system`
 * rather than `user:<id>`. So `forUser` returns `no_recipient` on every anchor, for ever, while
 * `hasRule` reports the topic as covered — the exact "reports itself as delivered" shape that the
 * fifteen deleted rules had. Reading `authorSubject` explicitly is not a preference here.
 */
test('an anchored object notifies its author, from a payload whose actor is system', () => {
  const set = RULES['tessera.object.anchored']?.recipients(anchoredEvent(`user:${ALICE}`))
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].params['transactionHash'], '0xdeadbeef')
  // A number on the payload, rendered as a string: `str` accepts numbers, and a blanked block
  // number would make the sentence unverifiable rather than merely terse.
  assert.equal(set.recipients[0].params['blockNumber'], '4242')
  assert.equal(set.recipients[0].subjectUrn, `cf:tessera:object:${OBJECT}`)
  assert.equal(set.recipients[0].dedupeKey, `tessera.object_anchored:${OBJECT}`)
})

test('an anchor with no author is no_recipient, never the system actor', () => {
  assert.deepEqual(RULES['tessera.object.anchored']?.recipients(anchoredEvent(undefined)), {
    kind: 'none',
    reason: 'no_recipient',
  })
  // And the `system` actor must not be read as a principal that is "not a person" — the producer
  // regressed, and `not_applicable` would hide that behind a metric an operator reads as healthy.
  assert.deepEqual(RULES['tessera.object.anchored']?.recipients(anchoredEvent(ALICE)), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('a fired object notifies its author and is keyed on the object, not the checksum', () => {
  const event = unregisteredEvent(
    'tessera.object.fired',
    OBJECT,
    {
      objectId: OBJECT,
      authorSubject: `user:${ALICE}`,
      checksum: 'sha256-abc',
      category: 'sculpture',
      footprint: 4,
      c2pa: true,
    },
    { actor: `user:${ALICE}`, producer: 'tessera' },
  )
  const set = RULES['tessera.object.fired']?.recipients(event)
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients[0].userId, ALICE)
  assert.equal(set.recipients[0].params['objectCategory'], 'sculpture')
  // Two people can fire byte-identical objects — `completeFiring` marks the second a duplicate —
  // so a checksum-keyed dedupe would silence one of them. The object id is per firing.
  assert.equal(set.recipients[0].dedupeKey, `tessera.object_fired:${OBJECT}`)
  assert.notEqual(set.recipients[0].dedupeKey, 'tessera.object_fired:sha256-abc')
})

/** `resolveContest` emits this: actor `system`, `fromSubject` the dispossessed owner. */
function transferEvent(reason: string, from: unknown) {
  return unregisteredEvent(
    'tessera.parcel.transferred',
    PARCEL,
    {
      parcelId: PARCEL,
      wardId: 'ward-1',
      ...(from === undefined ? {} : { fromSubject: from }),
      toSubject: `user:${BOB}`,
      reason,
      tier: 'plot',
    },
    { actor: reason === 'contest' ? 'system' : `user:${ALICE}`, producer: 'tessera' },
  )
}

/**
 * The transfer rule addresses the LOSER, and the winner is refused by name.
 *
 * Both subjects are on this payload, which makes it the easiest of the three to get backwards:
 * `toSubject` is the person the event is grammatically "about" and is the wrong one. The person
 * who needs telling held ground for four months and lost it to a clock they were not watching.
 */
test('a contested parcel notifies the owner who lost it, never the challenger who won it', () => {
  const set = RULES['tessera.parcel.transferred']?.recipients(transferEvent('contest', `user:${ALICE}`))
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  assert.notEqual(set.recipients[0].userId, BOB, 'the challenger, from toSubject')
  assert.notEqual(set.recipients[0].userId, PARCEL, 'the envelope key is the parcel')
  assert.equal(set.recipients[0].params['parcelId'], PARCEL)
  assert.equal(set.recipients[0].params['wardId'], 'ward-1')
  // Parcel AND user: one parcel can be lost, reclaimed and lost again, and each loss is news.
  assert.equal(set.recipients[0].dedupeKey, `tessera.parcel_lost:${PARCEL}:${ALICE}`)
})

test('a traded parcel is not_applicable — two people agreed to it and are both looking at it', () => {
  assert.deepEqual(RULES['tessera.parcel.transferred']?.recipients(transferEvent('trade', `user:${ALICE}`)), {
    kind: 'none',
    reason: 'not_applicable',
  })
  // An unrecognised reason is also not_applicable rather than a guess: the rule's whole premise is
  // "the reader did not act", and only `contest` proves that. `tessera/src/world.ts` types the
  // field `'trade' | 'contest'`, so a third value is a producer change this rule has not been
  // shown to be correct for.
  assert.deepEqual(RULES['tessera.parcel.transferred']?.recipients(transferEvent('', `user:${ALICE}`)), {
    kind: 'none',
    reason: 'not_applicable',
  })
  // But a CONTEST with no `fromSubject` is no_recipient — the producer dropped the field, which is
  // a fault, and must not be filed under the same "nothing to do" reason as a trade.
  assert.deepEqual(RULES['tessera.parcel.transferred']?.recipients(transferEvent('contest', undefined)), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO DEFERRALS THAT CLOSED, AND THE ONE THING THESE TESTS ARE FOR.
 *
 * Both of these topics were recorded `blockedBy: 'no-subject'` and refused a rule, twice, because
 * the envelope named the CHALLENGER and the BOOKER — the person who acted — and not the owner
 * losing ground or the owner being paid. `micro-tessera` 33ead39 added `ownerSubject` to both
 * payloads, off the `parcels` row the emitting transaction already held `for update`.
 *
 * So the failure these tests exist to catch is not "the rule is missing". It is **the rule tells
 * the wrong person**, which is the failure a presence check cannot see: on both topics the actor is
 * a perfectly good user id, so `forUser` would resolve somebody, produce a well-formed notification
 * and render it. Every case below therefore asserts a DIFFERENCE — Alice owns, Bob acts — never
 * merely that a recipient exists.
 *
 * And each is preceded by YESTERDAY'S payload, the shape the producer emitted before 33ead39, which
 * must answer `no_recipient` rather than falling back to the actor or to the envelope key. An
 * absent field is null to every reader, and a rule that guesses passes any test fed only today's
 * shape.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const CONTEST = '88888888-8888-4888-8888-888888888888'
const BOOKING = '99999999-9999-4999-8999-999999999999'
const SLOT = '2026-09-01T18:00:00.000Z'

/** `openContest` emits this: actor `user:<challenger>`, key the PARCEL. tessera/src/world.ts. */
function fallowedEvent(owner: unknown, challenger = `user:${BOB}`) {
  return registeredEvent(
    'tessera.parcel.fallowed',
    PARCEL,
    {
      parcelId: PARCEL,
      wardId: 'ward-1',
      contestId: CONTEST,
      ...(owner === undefined ? {} : { ownerSubject: owner }),
      challengerSubject: challenger,
    },
    { actor: `user:${BOB}` },
  )
}

/** `bookVenue` emits this: actor `user:<bookedBy>`, key the PARCEL. tessera/src/economy.ts. */
function bookedEvent(owner: unknown, bookingId = BOOKING, slot = SLOT) {
  return registeredEvent(
    'tessera.venue.booked',
    PARCEL,
    {
      bookingId,
      parcelId: PARCEL,
      wardId: 'ward-1',
      slot,
      ...(owner === undefined ? {} : { ownerSubject: owner }),
      bookedBy: `user:${BOB}`,
      priceWei: '5000000000000',
      reservationId: 'res-1',
    },
    { actor: `user:${BOB}` },
  )
}

test('a contest notifies the OWNER losing the ground, never the challenger who opened it', () => {
  const set = RULES['tessera.parcel.fallowed']?.recipients(fallowedEvent(`user:${ALICE}`))
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  // The three wrong answers, each of which is reachable by a plausible implementation: the actor
  // (`forUser`'s last resort), the payload's other subject, and the envelope key.
  assert.notEqual(set.recipients[0].userId, BOB, 'the challenger, from the actor or challengerSubject')
  assert.notEqual(set.recipients[0].userId, PARCEL, 'the envelope key is the parcel')
  assert.notEqual(set.recipients[0].userId, CONTEST)
  assert.equal(set.recipients[0].params['parcelId'], PARCEL)
  assert.equal(set.recipients[0].params['wardId'], 'ward-1')
  assert.equal(set.recipients[0].subjectUrn, `cf:tessera:parcel:${PARCEL}`)
  // The CONTEST: `contests_status_known` allows `withdrawn`, so one parcel can be contested twice
  // and each is news. Keyed on the parcel alone would silence the second.
  assert.equal(set.recipients[0].dedupeKey, `tessera.parcel_contested:${CONTEST}`)
})

test("yesterday's fallowed payload, with no owner, is no_recipient rather than the challenger", () => {
  // `{ parcelId, contestId, challengerSubject }` — exactly what `openContest` emitted before
  // tessera 33ead39. Both routes to a person on this envelope reach Bob, and both are wrong.
  assert.deepEqual(RULES['tessera.parcel.fallowed']?.recipients(fallowedEvent(undefined)), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('a parcel held by a service principal is not_applicable, never a user id spelled from it', () => {
  // A parcel's owner is whatever `ensureAccount` was handed, and `tessera/src/server.ts` takes it
  // from the request principal — which may be a service. `service:` is a recognised non-person, so
  // this is `not_applicable`; a bare uuid would be `no_recipient`, and slicing would file the
  // notification against a "user" called `tessera-bot`.
  assert.deepEqual(RULES['tessera.parcel.fallowed']?.recipients(fallowedEvent('service:tessera-bot')), {
    kind: 'none',
    reason: 'not_applicable',
  })
  assert.deepEqual(RULES['tessera.venue.booked']?.recipients(bookedEvent('service:tessera-bot')), {
    kind: 'none',
    reason: 'not_applicable',
  })
  // And a subject with no recognised prefix at all is a PRODUCER to fix, not a principal to skip.
  assert.deepEqual(RULES['tessera.venue.booked']?.recipients(bookedEvent(ALICE)), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('a venue booking notifies the OWNER being paid, never the booker who made it', () => {
  const set = RULES['tessera.venue.booked']?.recipients(bookedEvent(`user:${ALICE}`))
  assert.equal(set?.kind, 'recipients')
  if (set?.kind !== 'recipients') return
  assert.equal(set.recipients.length, 1)
  assert.equal(set.recipients[0].userId, ALICE)
  // The most expensive of the three wrong answers is Bob: `bookedBy` IS the actor, so a rule using
  // `forUser` resolves him and tells the booker they are owed money for their own booking.
  assert.notEqual(set.recipients[0].userId, BOB, 'the booker, from the actor or bookedBy')
  assert.notEqual(set.recipients[0].userId, PARCEL, 'the envelope key is the parcel')
  assert.notEqual(set.recipients[0].userId, BOOKING)
  assert.equal(set.recipients[0].params['parcelId'], PARCEL)
  assert.equal(set.recipients[0].params['slot'], '2026-09-01 18:00 UTC')
  // The amount is deliberately absent from the params: the divisor that turns `priceWei` into
  // Sparks lives in micro-tessera and is exported by nothing, so a figure here would be a second
  // copy of a denomination. Pinned, so restoring it is a decision rather than a reflex.
  assert.equal(set.recipients[0].params['priceWei'], undefined)
  assert.equal(set.recipients[0].subjectUrn, `cf:tessera:parcel:${PARCEL}`)
  assert.equal(set.recipients[0].dedupeKey, `tessera.venue_booked:${BOOKING}`)
})

test("yesterday's venue payload, with no owner, is no_recipient rather than the booker", () => {
  // `{ bookingId, parcelId, slot, bookedBy, priceWei, reservationId }` — what the VENUE_BOOKED emit
  // sent before tessera 33ead39, and the shape a replayed or relayed old event still has.
  assert.deepEqual(RULES['tessera.venue.booked']?.recipients(bookedEvent(undefined)), {
    kind: 'none',
    reason: 'no_recipient',
  })
})

test('two bookings on one Venue are two notifications, not one deduped into silence', () => {
  const first = RULES['tessera.venue.booked']?.recipients(bookedEvent(`user:${ALICE}`, BOOKING, SLOT))
  const second = RULES['tessera.venue.booked']?.recipients(
    bookedEvent(`user:${ALICE}`, '00000000-0000-4000-8000-000000000001', '2026-09-02T18:00:00.000Z'),
  )
  if (first?.kind !== 'recipients' || second?.kind !== 'recipients') {
    assert.fail('expected recipients')
    return
  }
  // Both are keyed by the same parcel — that is what the registry says `tessera.venue.booked` is
  // keyed by — so a parcel-keyed dedupe would collapse a fully booked calendar into one alert.
  assert.notEqual(first.recipients[0].dedupeKey, second.recipients[0].dedupeKey)
  // The degraded key, when a producer drops `bookingId`, is parcel-and-slot rather than the parcel
  // alone: that pair is what `tessera_one_open_booking` uses to identify an open booking, so two
  // slots still produce two keys even with the id gone.
  const noId = RULES['tessera.venue.booked']?.recipients(bookedEvent(`user:${ALICE}`, ''))
  const noIdOther = RULES['tessera.venue.booked']?.recipients(
    bookedEvent(`user:${ALICE}`, '', '2026-09-02T18:00:00.000Z'),
  )
  if (noId?.kind !== 'recipients' || noIdOther?.kind !== 'recipients') {
    assert.fail('expected recipients')
    return
  }
  assert.equal(noId.recipients[0].dedupeKey, `tessera.venue_booked:${PARCEL}:${SLOT}`)
  assert.notEqual(noId.recipients[0].dedupeKey, noIdOther.recipients[0].dedupeKey)
})

/**
 * The priority argument, pinned so that raising either one is an edit to this test.
 *
 * `exactly the events 04-domain-model §10.3 names are critical` already fails on a sixth critical
 * topic, but it fails with a diff of a topic list, which reads as bookkeeping. This says the
 * reason: a booking's fee is escrowed in a ledger reservation `bookings_open_holds_money` makes
 * non-optional, so nothing is lost if a preference silences it — which is exactly the test the
 * failed-withdrawal rule applied to reach the opposite answer for HELD funds, where no other topic
 * in the estate would ever tell the user. Every unnecessary critical is a preference page that
 * stops working, and these two are the cases for keeping that set at five.
 */
test('the two tessera owner notifications are high, and neither is critical', () => {
  for (const topic of ['tessera.parcel.fallowed', 'tessera.venue.booked']) {
    const rule = RULES[topic]
    assert.ok(rule, `${topic} has no rule`)
    if (!rule) continue
    assert.equal(rule.category, 'ownership')
    for (const outcome of outcomesOf(rule)) {
      assert.equal(outcome.priority, 'high', `${topic}: say why in the rule before changing this`)
      assert.notEqual(outcome.priority, 'critical', `${topic} would ignore every preference`)
    }
  }
  // And `high` is above the default, so a reader who has not touched their preferences gets both:
  // the news is that somebody else acted on their property, which they cannot have been watching.
  assert.ok(PRIORITY_RANK['high'] > PRIORITY_RANK['normal'])
})

/**
 * The words, rendered — because a template id is an identifier a refactor can move while the
 * sentence stays wrong, and because both of these say something the code has to keep true.
 */
test('the contested notification never offers a defence the world does not have', () => {
  const rule = RULES['tessera.parcel.fallowed']
  const set = rule?.recipients(fallowedEvent(`user:${ALICE}`))
  if (!rule || set?.kind !== 'recipients') {
    assert.fail('expected recipients')
    return
  }
  const rendered = renderTemplate(
    templateFor(rule.templateId)!,
    set.recipients[0].params,
    DEFAULT_LOCALE,
    'https://app.cloudsforge.test',
  )
  assert.deepEqual(rendered.missing, [], 'a gap where the parcel or the ward should be')
  const text = `${rendered.subject}\n${rendered.body}`
  assert.match(text, new RegExp(PARCEL), 'which parcel — a reader may hold dozens')
  // Banking moves `banked_until`, but `resolveContest` never re-reads the window — tessera's
  // `parcel.settle` handler says so: "a contest that exists is one the window already permitted".
  // Nothing writes `status = 'withdrawn'`. So the body may say banking protects OTHER land and must
  // not say it saves this parcel, which would be a defence offered to somebody who has none.
  assert.doesNotMatch(
    text,
    /bank (it|this parcel)|to keep it|to save it|withdraw the contest|dispute/i,
    'the reader was told to defend a contest that nothing in micro-tessera can withdraw',
  )
  // It must still say what is NOT lost, or "your land is being taken" is the whole of what a reader
  // who did nothing learns.
  assert.match(text, /still yours/)
})

test('the venue notification says the fee is held, and never states an amount it cannot denominate', () => {
  const rule = RULES['tessera.venue.booked']
  const set = rule?.recipients(bookedEvent(`user:${ALICE}`))
  if (!rule || set?.kind !== 'recipients') {
    assert.fail('expected recipients')
    return
  }
  const rendered = renderTemplate(
    templateFor(rule.templateId)!,
    set.recipients[0].params,
    DEFAULT_LOCALE,
    'https://app.cloudsforge.test',
  )
  assert.deepEqual(rendered.missing, [])
  const text = `${rendered.subject}\n${rendered.body}`
  assert.match(text, /2026-09-01 18:00 UTC/, 'the date somebody else put in their calendar')
  assert.match(text, /escrowed/)
  // The raw wei figure must never reach a sentence. It is a whole multiple of 10^12 and reads as
  // either a bug or a fortune; the divisor that would fix it is micro-tessera's and is exported by
  // no shared package. The parcel id is removed first because it is a uuid whose groups are long
  // digit runs in this fixture — a regex that catches its own identifiers proves nothing.
  assert.doesNotMatch(text, /5000000000000/, 'the payload priceWei was rendered at a person')
  assert.doesNotMatch(
    text.split(PARCEL).join('<parcel>'),
    /\d{10,}/,
    'a wei integer was rendered at a person',
  )
  // And it must not promise a payout: nothing in micro-tessera moves a booking to `settled` yet.
  assert.doesNotMatch(text, /paid to you|in your balance now|has been paid/i)
})

/**
 * The two tessera topics with no rule, and the assertion that they are DECIDED rather than missed.
 *
 * `unmappedRegistryTopics()` already fails on a registered topic that is neither mapped nor
 * recorded, so this adds the half that check cannot see: that each is in exactly one of the two
 * tables, never both. Naming them here is what makes a future rule for one of them a deliberate
 * edit.
 *
 * **There were four, and the other two were DEFERRALS rather than decisions.** That distinction was
 * written into this test because it is the one a reader collapses: `tessera.parcel.fallowed` and
 * `tessera.venue.booked` had no rule not because nobody needed telling but because the envelope did
 * not name the person who did. tessera 33ead39 added `ownerSubject` to both, so both are rules now
 * and both had to leave this list — a topic that is mapped may not also be recorded. The two below
 * are the ones that were always decisions, and neither has moved.
 */
test('the two tessera topics with no rule are each recorded, and never both mapped and recorded', () => {
  for (const topic of ['tessera.parcel.claimed', 'tessera.ward.opened']) {
    assert.equal(hasRule(topic), false, `${topic} is recorded as not notifying AND mapped`)
    assert.ok(Object.hasOwn(NON_NOTIFYING_TOPICS, topic), `${topic} has no rule and no reason`)
    assert.equal(isKnownTopic(topic), true, `${topic} must still be accepted at /ingest`)
  }
  // And the two that closed are mapped in exactly one table, from the other direction: a rule, and
  // no `NON_NOTIFYING_TOPICS` entry left behind saying the envelope names nobody.
  for (const topic of ['tessera.parcel.fallowed', 'tessera.venue.booked']) {
    assert.equal(hasRule(topic), true, `${topic} named its owner; the rule it was owed is missing`)
    assert.equal(
      Object.hasOwn(NON_NOTIFYING_TOPICS, topic),
      false,
      `${topic} is both mapped and recorded as not notifying — the coverage table can only mean one`,
    )
    assert.equal(isKnownTopic(topic), true, `${topic} must be accepted at /ingest`)
  }
  // And all seven are registered, so none of them is riding the quarantine.
  for (const topic of [
    'tessera.parcel.claimed',
    'tessera.parcel.fallowed',
    'tessera.parcel.transferred',
    'tessera.object.fired',
    'tessera.object.anchored',
    'tessera.ward.opened',
    'tessera.venue.booked',
  ]) {
    assert.equal(isRegisteredTopic(topic), true, `${topic} is not in the registry`)
  }
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   THE SEAM, DRIVEN FROM THE PRODUCER'S OWN SOURCE.

   Every test above types the payload keys by hand — `{ userId, handle, email, verifyUrl }` — which
   means this repository and micro-identity hold two copies of one contract and the suite compares
   each copy with itself. Rename `verifyUrl` in identity tomorrow and every test in this file still
   passes, while the mail goes out pointing at `/settings/account` because `verifyLinkOf` fell back.
   Nothing fails. Nobody is told. That is the exact shape of the defect this whole change exists to
   close, and it would have come straight back in the test suite written to prove it fixed.

   So the payload below is built from the key names PARSED OUT OF IDENTITY'S EMIT SITE, and the
   assertions are about what notify then produces. `hub-web/test/wallet-assets.test.ts` sets the
   precedent in this estate: read the sibling's source, let the producer decide, and fail here when
   the two disagree.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const ESTATE = new URL('../../', import.meta.url)
const EMIT_SITE = new URL('identity/src/emailVerification.ts', ESTATE)
const identityPresent = existsSync(EMIT_SITE)

/**
 * The payload keys identity really emits for this topic.
 *
 * Parsed from the `payload: { … }` block of the `identity.email.verification_requested` emit, and
 * it THROWS rather than returning an empty set if the shape it expects is gone. A parser that
 * silently matched nothing would make every assertion below vacuously true, which is the failure
 * mode this whole block exists to avoid — see `wallet-assets.test.ts`, which learned it the same way.
 */
function emittedPayloadKeys(source: string): readonly string[] {
  const emit = /topic:\s*'identity\.email\.verification_requested'[\s\S]*?payload:\s*\{([\s\S]*?)\n\s{6}\}/.exec(source)
  if (!emit?.[1]) throw new Error('identity’s verification emit is no longer a `payload: { … }` block')
  // Comments go first. Half the lines in that block are prose, and prose contains colons — the
  // first version of this matched three keys out of six because the commas it keyed off were
  // followed by explanations rather than by fields, and the `< 4` guard below is what caught it.
  const body = emit[1].replace(/\/\/[^\n]*/g, '')
  const keys = new Set<string>()
  // `key:` at the head of a line, and the spread form `...(x ? {} : { key })` that carries a field
  // present only sometimes — `verifyUrl` is exactly that, and missing it would be missing the one
  // field whose loss is silent.
  for (const m of body.matchAll(/^\s*([a-zA-Z_]\w*)\s*:/gm)) keys.add(m[1] as string)
  for (const m of body.matchAll(/\{\s*([a-zA-Z_]\w*)\s*\}/g)) keys.add(m[1] as string)
  if (keys.size < 4) throw new Error(`parsed only ${keys.size} payload keys; the parser has rotted`)
  return [...keys]
}

test(
  'the rule reads the payload micro-identity actually emits, not a copy of it typed here',
  {
    // A REAL skip, reported as skipped. CI checks out this repository alone, and a test that
    // `return`ed instead would report as passed against work it had not done.
    skip: identityPresent
      ? false
      : 'micro-identity is not checked out beside this repository, so its emit site cannot be read',
  },
  () => {
    const keys = emittedPayloadKeys(readFileSync(EMIT_SITE, 'utf8'))

    // Build the payload from THOSE keys. Every value is placeholder text; the link is obviously
    // not a credential and is `https:` so it survives the scheme guard.
    const link = 'https://hub.cloudsforge.test/account/verify#token=not-a-real-token'
    const values: Readonly<Record<string, unknown>> = {
      userId: ALICE,
      handle: 'alice',
      email: 'alice@example.test',
      expiresAt: new Date(Date.UTC(2026, 7, 6)).toISOString(),
      linkable: true,
      verifyUrl: link,
    }
    // A key identity emits that this test does not know how to fill is a contract change nobody
    // has looked at. Named, rather than skipped past with a default.
    const unknown = keys.filter((key) => !(key in values))
    assert.deepEqual(unknown, [], `identity emits ${unknown.join(', ')}, which this seam does not model`)

    const payload = Object.fromEntries(keys.map((key) => [key, values[key]]))
    const event = unregisteredEvent('identity.email.verification_requested', ALICE, payload, {
      actor: `user:${ALICE}`,
    })
    const rule = RULES['identity.email.verification_requested']
    assert.ok(rule, 'the topic identity emits has no rule here')
    if (!rule) return

    // ── The three things that are silently wrong when a field is renamed.
    assert.equal(
      rule.learns?.read(event),
      values['email'],
      'the address did not come off identity’s payload — every mail would route to nobody',
    )
    assert.equal(
      rule.learns?.subject(event),
      ALICE,
      'the address owner did not come off identity’s payload',
    )
    const set = rule.recipients(event)
    assert.equal(set.kind, 'recipients')
    if (set.kind !== 'recipients') return
    assert.equal(
      set.recipients[0]?.params['verifyUrl'],
      link,
      'the link did not come off identity’s payload, so the mail would carry the fall-back page ' +
        'instead — which renders, and reads as a working email, and verifies nothing',
    )
    assert.equal(set.recipients[0]?.params['handle'], values['handle'], 'the greeting lost its name')
  },
)
