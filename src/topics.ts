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
 *
 * ## The third check was itself unable to fail, and five records rotted behind it
 *
 * The record structure in (3) came with a staleness check, `staleGaps()`, that asked whether the
 * SHARED REGISTRY named the topic a producer emits. It never fired, and it never could have: every
 * record it was watching described a topic that a live producer emits and no registry names, which
 * is precisely the condition the check treated as "still true". Five entries therefore sat here
 * saying a notification was impossible while `trade`, `market`, `devplatform` and `settlement` had
 * been emitting the exact topics this file itself had written down.
 *
 * The check is now `contradictedGaps()`, which asks only what this checkout can answer, and the
 * cross-repository half is delegated by name to `micro-org`'s `tools/estate-topics.mjs` — the only
 * checkout that holds every producer and every consumer at once. That function's own comment
 * carries the full argument, including why the old one was not fixable in place.
 *
 * Three of the five became the rules in `AWAITING_REGISTRATION` below. Two did not, and the reason
 * is written into each record: `settlement.outbound.failed` and `market.offer.made` are real events
 * whose envelopes name nobody this service could notify. That distinction is what `blockedBy` now
 * carries, and it is why "the producer emits it" was never on its own enough to write a rule.
 */

import {
  isRegisteredTopic,
  isValidTopicName,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { MAPPED_TOPICS, hasRule, unmappedRegistryTopics } from './catalogue.ts'

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
 * The situation this exists for is real: notify is the first consumer of every new topic, and a
 * rule that lands one deploy before the registration is a legitimate state. What is not legitimate
 * is that state being invisible.
 *
 * An entry must carry the spec that would register it and the emit site that proves the producer
 * exists, so adopting it into contracts is a copy rather than a fresh design — and the test below
 * fails the moment contracts adopts one and the entry is not deleted, so this cannot rot into a
 * permanent allow-list the way the fifteen did.
 *
 * **The three below are the mechanism working rather than a gap.** Each was a record in
 * `UNPRODUCED_NOTIFICATIONS` saying the notification could not be produced, while the producer had
 * been emitting the topic all along under the name this file itself had written down. Each spec is
 * copied VERBATIM from the producing service's own quarantine — `trade/src/topics.ts:117`,
 * `devplatform/src/topics.ts:100` and `:112` — so `micro-contracts` adopting them is a paste, and
 * so the two repositories cannot propose two different contracts for one topic.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({
  'trade.bot.paused': {
    reason:
      'The other half of started. Without it a consumer that saw a bot start believes it is still trading for ever — and pause does NOT flatten the position (trade/src/bots.ts:610), so the owner is still exposed to a market their bot has stopped watching. AD-08 asks for a trading-bot notification and this is the one trade emits.',
    emittedAt: 'trade/src/bots.ts:614',
    spec: {
      producer: 'trade',
      payloadType: 'BotPaused',
      version: '1.0',
      keyedBy: 'bot_id',
      description: 'A bot stopped trading.',
    },
  },
  'devplatform.key.issued': {
    reason:
      "The other half of revoked, and a key issued by somebody other than its owner is the first thing a compromise looks like. An API key acts as the user, with no password and no second factor behind it, and nothing can tell the account holder today.",
    emittedAt: 'devplatform/src/apikeys.ts:274',
    spec: {
      producer: 'devplatform',
      payloadType: 'ApiKeyIssued',
      version: '1.0',
      keyedBy: 'key_id',
      description: 'An API key was issued for a project, with its scopes and prefix.',
    },
  },
  'devplatform.key.revoked': {
    reason:
      '11-data-and-contract-strategy.md:363 names THIS TOPIC as the mechanism by which a revoked API key stops working at every 30-second gateway cache in the estate. Unregistered, no consumer can classify it, so the documented propagation path does not exist and revocation is immediate only inside devplatform.',
    emittedAt: 'devplatform/src/apikeys.ts:359',
    spec: {
      producer: 'devplatform',
      payloadType: 'ApiKeyRevoked',
      version: '1.0',
      keyedBy: 'key_id',
      description: 'An API key was revoked. Every cache holding a verification result for it must drop it.',
    },
  },
})

/**
 * An AD-08 notification this service cannot produce, and the ONE reason why.
 *
 * Each of these had a rule, and each rule was unreachable. The requirement is real and stays
 * visible here; what is deleted is the claim that notify covers it.
 *
 * ## `blockedBy` is new, and it is what makes the record checkable
 *
 * The shape used to be "requirement, the topic the deleted rule guessed at, what the producer emits
 * instead, evidence" — and it could not distinguish the three completely different situations it
 * was holding at once. `settlement.outbound.failed` and `devplatform.key.issued` had identical
 * record shapes, and one of them was a live notification waiting for a rule while the other is a
 * handover between two services that names nobody a notification could go to. Nothing could tell
 * them apart, so nothing could say which records were stale, so **four of them sat here for weeks
 * describing notifications that were one rule away**.
 *
 * Naming the reason closes that, because each reason implies something this checkout can verify:
 *
 *   - `no-event` — nothing on the bus carries the fact. `emits` must be null.
 *   - `no-subject` — the fact is on the bus and its envelope names nobody notify could address:
 *     no `user_id` in the payload and no `user:` actor. `emits` names the topic, and notify must
 *     hold no rule for it, because a rule would contradict this record.
 *   - `other-channel` — the fact reaches users without the bus, so a rule would DOUBLE-send.
 *     `owner` is null: there is nothing for anyone to change.
 *
 * `emits` is read out of the producer's source, not inferred from the name, and is kept as a bare
 * quoted topic literal on purpose: `micro-org`'s `tools/estate-topics.mjs` reads this constant BY
 * NAME (`RECORD_STRUCTURES`, direction 4) from a checkout that holds every producer, and a literal
 * is what it can match. That is the half of the staleness question this repository cannot answer —
 * see `contradictedGaps` below.
 */
export interface UnproducedNotification {
  /** The AD-08 kind of notification, in the words AD-08 uses. */
  readonly requirement: string
  /** The topic the deleted rule guessed at. Kept so the deletion is greppable. */
  readonly guessedTopic: string
  /**
   * The topic the producer really emits for this area, or null when it emits nothing at all.
   *
   * One topic, spelled exactly, so a machine outside this repository can match it against that
   * producer's emit sites. A list would be prose; put the rest in `evidence`.
   */
  readonly emits: string | null
  /** Why no rule can be written today. Exactly one reason, from a closed set. */
  readonly blockedBy: 'no-event' | 'no-subject' | 'other-channel'
  /**
   * The repository whose one change closes it — `micro-<repo>`.
   *
   * Null only for `other-channel`, where the requirement is already met and there is nothing to
   * change. Everything else names an owner, because a gap nobody owns is a gap nobody closes: the
   * estate gap file in micro-org learned the same thing and requires the same field.
   */
  readonly owner: string | null
  /** Where that was verified. A path and a line, or a statement about the absence. */
  readonly evidence: string
}

export const UNPRODUCED_NOTIFICATIONS: readonly UnproducedNotification[] = Object.freeze([
  Object.freeze({
    requirement: 'risk limit reached',
    guessedTopic: 'policy.limit.reached',
    emits: null,
    blockedBy: 'no-event',
    owner: 'micro-policy',
    evidence:
      'policy has no outbox at all — no outbox.ts, no `insert into outbox` anywhere in policy/src. A decision is a row in policy_decision (04-domain-model §10.4), read by admin-api over HTTP. Nothing about a limit reaches the bus, so a user is still told "it just did not work" by silence.',
  }),
  Object.freeze({
    requirement: 'deposit detected, before confirmation',
    guessedTopic: 'wallet.deposit.detected',
    emits: null,
    blockedBy: 'no-event',
    owner: 'micro-wallet',
    evidence:
      'wallet emits at credit time and not before: DEPOSIT_CREDITED at wallet/src/deposits.ts:657, keyed by wallet_id. The seen-but-not-yet-credited state — the one that generates the support ticket — is visible in wallet\'s own read model (deposits.ts:734) and is announced to nobody.',
  }),
  Object.freeze({
    requirement: 'withdrawal transaction failed outright',
    guessedTopic: 'settlement.transaction.failed',
    emits: 'settlement.outbound.failed',
    blockedBy: 'no-subject',
    owner: 'micro-settlement',
    evidence:
      "settlement/src/withdrawals.ts:482 emits it with `payload: { withdrawalId, reason, refundable }`, keyed by the withdrawal id, and `failedEvents` sets no actor — so an envelope on it names nobody this service could notify, and a rule keyed to it would answer no_recipient for ever. It is WALLET'S name and wallet's contract (settlement/src/outbox.ts:49-55: \"spelled in wallet/src/settlement.ts before this repository existed\"), narrow on purpose, carrying `refundable` so wallet knows whether to return the reservation. The user-facing twin does not exist: settlement.withdrawal.completed (:451) and settlement.withdrawal.stuck (:532) both carry userId and both are broad, and there is no settlement.withdrawal.failed. The repair is settlement emitting one, exactly as it added the stuck twin — not notify keying a rule to a handover between two other services.",
  }),
  Object.freeze({
    requirement: 'marketplace offer received',
    guessedTopic: 'market.offer.received',
    emits: 'market.offer.made',
    blockedBy: 'no-subject',
    owner: 'micro-market',
    evidence:
      "market/src/bids.ts:432 emits it with `payload: { listingId, offerId, offererSubject, amount, assetCode }`, keyed by the listing, actor the OFFERER. The recipient this requirement names is the SELLER, and the payload does not carry them — `listing.sellerSubject` is in scope three lines above the emit (bids.ts:399 reads it to refuse shill bidding) and is not put on the event. So the only subject notify could resolve is the person who made the offer, and telling them they made an offer is both noise and a false claim of coverage. One field on market's payload closes it.",
  }),
  Object.freeze({
    requirement: 'auction ended',
    guessedTopic: 'market.auction.ended',
    emits: null,
    blockedBy: 'no-event',
    owner: 'micro-market',
    evidence:
      'No market.auction.* topic exists. closeAuction (market/src/orders.ts:587) settles through the ordinary sale path and emits SOLD_TOPIC (orders.ts:427) — registered, and already notified on here — so the WINNER hears it as a sale. Nothing at all announces the close to a losing bidder, which is the half AD-08 asked for.',
  }),
  Object.freeze({
    requirement: 'service incident',
    guessedTopic: 'admin_api.incident.opened',
    emits: 'admin.broadcast.published',
    blockedBy: 'other-channel',
    owner: null,
    evidence:
      'admin-api/src/broadcasts.ts:144 — an incident reaches users as an operator broadcast, which POST /admin/broadcasts already fans out through this service (pipeline.ts:548). A rule on the topic as well would send the same incident twice. The deleted rule claimed pipeline.ts recognised its category and routed it there; it does not — pipeline.ts:233 looks up the rule and pipeline.ts:240 records `none` and stops — so the rule was a no-op guarding a path that never used it.',
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
 * A record this service's OWN catalogue contradicts.
 *
 * ## What was here before, and why it could not fail
 *
 * `staleGaps()` asked whether `@cloudsforge/contracts-events` NAMES the topic a producer emits, and
 * called the record stale when it did. That is the wrong oracle, and the wrongness is not subtle
 * once stated: **the registry is not the producer.** A topic can be registered and emitted by
 * nobody — `custody.key.exported` was, for the whole life of that service — and a topic can be
 * emitted by a live producer for months while no registry names it, which is the case all five of
 * the records deleted from this file were in. So the check answered a question nobody had asked,
 * and every one of its subjects was invisible to it by construction. It was the self-emptying
 * quarantine's twin in shape and not in effect: a record that empties only when somebody remembers
 * is not self-emptying, and this one emptied only when a THIRD repository moved.
 *
 * It could not have been fixed in place, either, and that is the honest part. The question it was
 * standing in for is "does a producer emit this today?", and **no check inside micro-notify can
 * answer it**: this checkout holds the consumer half of the bus and nothing else. Making the check
 * look harder would have made it look more convincing without making it able to fail.
 *
 * ## So the question was split, and each half is asked where it can be answered
 *
 * The cross-repository half now lives in the only checkout that has both halves in it:
 * `micro-org`'s `tools/estate-topics.mjs` clones all 56 repositories, derives every emit site in
 * the estate, reads THIS constant by name (`RECORD_STRUCTURES`, direction 4) and fails when a
 * record here names a topic a producer emits. That is how the five were found. Its findings ratchet
 * through `tools/estate-topic-gaps.json`, which fails when a recorded finding is repaired and not
 * deleted — the self-emptying property, moved to where it can hold.
 *
 * What is left here is the half this repository can prove, and it is a real one: **a record must
 * not contradict notify's own rule table.** If a rule exists for the topic a record says cannot be
 * notified on, one of the two is wrong, and the record is the one that has to go. That is what
 * makes writing the rule delete the record rather than leaving both — the exact failure mode the
 * five had, seen from the side this checkout can see.
 *
 * `isRegisteredTopic` is still imported and still used, by `unregisteredRuleTopics` and
 * `adoptedProposals`, which ask about the registry things the registry actually knows.
 */
export function contradictedGaps(): readonly string[] {
  return UNPRODUCED_NOTIFICATIONS.filter((gap) => gap.emits !== null && hasRule(gap.emits))
    .map((gap) => gap.guessedTopic)
    .sort()
}

/**
 * A record whose stated reason does not match its own fields.
 *
 * Cheap, and it is what stops `blockedBy` becoming decoration. Each reason implies something about
 * the rest of the record (see `UnproducedNotification`), and a record that claims one reason while
 * carrying the shape of another is a record nobody can act on.
 */
export function inconsistentGaps(): readonly string[] {
  return UNPRODUCED_NOTIFICATIONS.filter((gap) => {
    switch (gap.blockedBy) {
      // Nothing on the bus carries the fact, so there is no topic to name.
      case 'no-event':
        return gap.emits !== null || gap.owner === null
      // The fact is on the bus; the record must say which topic, and who fixes the payload.
      case 'no-subject':
        return gap.emits === null || gap.owner === null
      // Already delivered another way. Naming an owner would ask somebody to change nothing.
      case 'other-channel':
        return gap.emits === null || gap.owner !== null
    }
  })
    .map((gap) => gap.guessedTopic)
    .sort()
}
