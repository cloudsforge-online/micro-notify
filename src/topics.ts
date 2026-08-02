/**
 * What notify has rules for, and the two-sided agreement with the shared registry.
 *
 * ## The defect this file exists to close
 *
 * `catalogue.test.ts` has always checked one direction: every topic in
 * `@cloudsforge/contracts-events` is either mapped or listed in `NON_NOTIFYING_TOPICS` with a
 * reason, so a topic added to the registry cannot be silently ignored here.
 *
 * **Nothing checked the other direction at all.** A rule could name any string, and fifteen of
 * them named topics no registry held. `events.ts` was written to tolerate exactly that, and its
 * reasoning was sound when it was written: notify is the fan-in of the entire bus and will always
 * be the first consumer of a new topic, so a well-formed envelope on an unregistered topic is
 * accepted **when this service already holds a rule for it**.
 *
 * The premise aged and nobody noticed. Its words were "the services that will produce them are not
 * written" — and by the time this file was added, eleven of the fifteen had a producer that was
 * very much written and emitting a **different name**:
 *
 *   - `identity.password.changed` — identity never announces a password change; it revokes every
 *     session with `reason: 'password_changed'` (identity/src/server.ts:960).
 *   - `wallet.deposit.detected` — wallet emits nothing when a deposit is seen, only when it is
 *     credited (wallet/src/deposits.ts:657).
 *   - `settlement.transaction.failed` — settlement emits `settlement.outbound.failed`
 *     (settlement/src/withdrawals.ts:482).
 *   - `trade.bot.triggered` / `trade.bot.stopped` — trade emits `created`, `started` and `paused`
 *     (trade/src/bots.ts:203, :592, :614).
 *   - `market.offer.received` — market emits `market.offer.made` (market/src/bids.ts:432).
 *   - `devplatform.apikey.created` / `.revoked` — devplatform emits `devplatform.key.issued` and
 *     `devplatform.key.revoked` (devplatform/src/apikeys.ts:274, :359).
 *
 * A rule for a topic nobody emits is not a feature waiting for its producer. It is a feature that
 * reports itself as delivered: the coverage test counted it, `AD-08 requires a rule for X` passed,
 * and no notification could ever be produced by it. That is worse than the omission it hides.
 *
 * ## What is checked now, in both directions
 *
 *   1. **Every rule names a registered topic** — or a quarantined proposal below, which must carry
 *      the exact `TopicSpec` needed to register it and which empties itself once contracts adopts
 *      it. This is the direction that was missing.
 *   2. **Every registered topic has a rule or a written reason** — `unmappedRegistryTopics()` in
 *      `catalogue.ts`, asserted here as well so both halves are read in one place.
 *   3. **Every AD-08 notification with no producer is recorded, with the evidence** — see
 *      `UNPRODUCED_NOTIFICATIONS`. Deleting the rule and saying nothing would lose the requirement;
 *      keeping the rule claimed a coverage that did not exist. The record is the third option, and
 *      it names what the producer actually emits so the repair is one grep rather than an audit.
 *
 * Modelled on `identity/src/topics.ts`, deliberately: identity does this for the producer side —
 * emitted literals reconciled against the registry both ways, with a self-emptying quarantine for
 * what it cannot register itself. This is the consumer half of the same idea, and a second pattern
 * would mean two things to learn and two places to look.
 */

import {
  isRegisteredTopic,
  isValidTopicName,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { MAPPED_TOPICS, unmappedRegistryTopics } from './catalogue.ts'

export interface ProposedTopic {
  /** Why notify holds a rule for a topic the estate has not named. Read by a human. */
  readonly reason: string
  /** The emit site that proves a producer really sends it. `<repo>/src/<file>.ts:<line>`. */
  readonly emittedAt: string
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Rules for topics the registry does not yet name.
 *
 * **Empty, and that is the point** — every rule this service holds now names a registered topic.
 * The mechanism stays because the situation it exists for is real: notify is the first consumer of
 * every new topic, and a rule that lands one deploy before the registration is a legitimate state.
 * What is no longer legitimate is that state being invisible.
 *
 * An entry must carry the spec that would register it and the emit site that proves the producer
 * exists, so adopting it into contracts is a copy rather than a fresh design — and the test below
 * fails the moment contracts adopts one and the entry is not deleted, so this cannot rot into a
 * permanent allow-list the way the fifteen did.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({})

/**
 * An AD-08 notification whose event does not exist on the bus.
 *
 * Each of these had a rule, and each rule was unreachable. The requirement is real and stays
 * visible here; what is deleted is the claim that notify covers it. `emits` is what the producing
 * service actually puts on the bus today — read out of its source, not inferred from the name —
 * because that is the fact that decides the repair: register the emitted topic and write the rule
 * against it, or accept that the producer does not announce the fact at all.
 */
export interface UnproducedNotification {
  /** The AD-08 kind of notification, in the words AD-08 uses. */
  readonly requirement: string
  /** The topic the deleted rule guessed at. Kept so the deletion is greppable. */
  readonly guessedTopic: string
  /** What the producer emits instead, or null when it emits nothing for this fact. */
  readonly emits: string | null
  /** Where that was verified. A path and a line, or a statement about the absence. */
  readonly evidence: string
}

export const UNPRODUCED_NOTIFICATIONS: readonly UnproducedNotification[] = Object.freeze([
  Object.freeze({
    requirement: 'risk limit reached',
    guessedTopic: 'policy.limit.reached',
    emits: null,
    evidence:
      'policy has no outbox at all — no outbox.ts, no `insert into outbox` anywhere in policy/src. A decision is a row in policy_decision (04-domain-model §10.4), read by admin-api over HTTP. Nothing about a limit reaches the bus, so a user is still told "it just did not work" by silence.',
  }),
  Object.freeze({
    requirement: 'deposit detected, before confirmation',
    guessedTopic: 'wallet.deposit.detected',
    emits: null,
    evidence:
      'wallet emits at credit time and not before: DEPOSIT_CREDITED at wallet/src/deposits.ts:657, keyed by wallet_id. The seen-but-not-yet-credited state — the one that generates the support ticket — is visible in wallet\'s own read model (deposits.ts:734) and is announced to nobody.',
  }),
  Object.freeze({
    requirement: 'withdrawal transaction failed outright',
    guessedTopic: 'settlement.transaction.failed',
    emits: 'settlement.outbound.failed',
    evidence:
      'settlement/src/withdrawals.ts:482, alongside settlement.outbound.confirmed (:440) and settlement.outbound.stuck (:500). None of the three is registered; the registry names settlement.withdrawal.stuck, which settlement does not emit. The failure notification needs settlement.outbound.failed registered, not a rule on a name nobody sends.',
  }),
  Object.freeze({
    requirement: 'trading-bot event',
    guessedTopic: 'trade.bot.triggered',
    emits: 'trade.bot.created, trade.bot.started, trade.bot.paused',
    evidence:
      'trade/src/bots.ts:203, :592 and :614. There is no "triggered" fact: a fill is trade.fill.settled (fills.ts:227). "A bot acting on money without telling its owner" is therefore still true, and closing it means registering the topics trade already emits.',
  }),
  Object.freeze({
    requirement: 'trading bot stopped',
    guessedTopic: 'trade.bot.stopped',
    emits: 'trade.bot.paused',
    evidence:
      'trade/src/bots.ts:614. `stopped` is a BotStatus (bots.ts:94) and a terminal one — bots.ts:561 refuses to restart a stopped bot — but reaching it emits nothing at all, so the state a user most needs to hear about is the one the bus is silent on.',
  }),
  Object.freeze({
    requirement: 'marketplace offer received',
    guessedTopic: 'market.offer.received',
    emits: 'market.offer.made',
    evidence:
      'market/src/bids.ts:432 (OFFER_MADE_TOPIC, bids.ts:50). The producer names the act and the rule named the experience; only one of the two is on the bus. Registering market.offer.made and keying the rule to it restores the notification.',
  }),
  Object.freeze({
    requirement: 'auction ended',
    guessedTopic: 'market.auction.ended',
    emits: null,
    evidence:
      'No market.auction.* topic exists. closeAuction (market/src/orders.ts:587) settles through the ordinary sale path and emits SOLD_TOPIC (orders.ts:427) — registered, and already notified on here — so the WINNER hears it as a sale. Nothing at all announces the close to a losing bidder, which is the half AD-08 asked for.',
  }),
  Object.freeze({
    requirement: 'API key created',
    guessedTopic: 'devplatform.apikey.created',
    emits: 'devplatform.key.issued',
    evidence:
      'devplatform/src/apikeys.ts:274 (TOPICS.keyIssued, outbox.ts:53). "An API key acts as the user" is unchanged and so is the argument for notifying; the aggregate is spelled `key`, not `apikey`.',
  }),
  Object.freeze({
    requirement: 'API key revoked',
    guessedTopic: 'devplatform.apikey.revoked',
    emits: 'devplatform.key.revoked',
    evidence:
      'devplatform/src/apikeys.ts:359 (TOPICS.keyRevoked, outbox.ts:54). Same aggregate spelling as the issue path: `key`, not `apikey`. "A revocation the owner did not make" is a live risk and an unregistered event.',
  }),
  Object.freeze({
    requirement: 'service incident',
    guessedTopic: 'admin_api.incident.opened',
    emits: 'admin.broadcast.published',
    evidence:
      'admin-api/src/broadcasts.ts:144 — an incident reaches users as an operator broadcast, which POST /admin/broadcasts already fans out through this service (pipeline.ts:548). The deleted rule claimed pipeline.ts recognised its category and routed it there; it does not — pipeline.ts:233 looks up the rule and pipeline.ts:240 records `none` and stops — so the rule was a no-op guarding a path that never used it.',
  }),
])

/** Rule topics in neither the registry nor the quarantine — a notification that cannot fire. */
export function unregisteredRuleTopics(): readonly string[] {
  return MAPPED_TOPICS.filter(
    (topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic),
  ).sort()
}

/** Registry topics with no rule and no written reason. The direction that already existed. */
export function unmappedTopics(): readonly TopicName[] {
  return unmappedRegistryTopics()
}

/** Proposals the registry has since adopted. Non-empty means delete the entry. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/** A proposal must describe a topic that could actually be registered, and prove its producer. */
export function malformedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION)
    .filter((topic) => {
      const proposed = AWAITING_REGISTRATION[topic]
      if (!proposed) return true
      return (
        !isValidTopicName(topic) ||
        !topic.startsWith(`${proposed.spec.producer.replace(/-/g, '_')}.`) ||
        proposed.spec.keyedBy === '' ||
        !/^[a-z-]+\/src\/[\w.-]+\.ts:\d+$/.test(proposed.emittedAt) ||
        proposed.reason.length < 80
      )
    })
    .sort()
}

/**
 * A recorded gap whose topic the registry now names — the record is stale.
 *
 * Same self-emptying property as the quarantine. Once someone registers the topic a producer
 * really emits, this file fails until the entry is replaced by a rule, so the record cannot become
 * the permanent excuse that the fifteen unreachable rules were.
 */
export function staleGaps(): readonly string[] {
  return UNPRODUCED_NOTIFICATIONS.filter(
    (gap) => gap.emits !== null && gap.emits.split(', ').some(isRegisteredTopic),
  )
    .map((gap) => gap.guessedTopic)
    .sort()
}
