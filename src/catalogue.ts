/**
 * The event → notification mapping. AD-08's first sentence, made into a table.
 *
 * One rule per topic. A rule says which category and priority a notification takes, which
 * template renders it, who receives it, and — the part that carries the most weight — what its
 * `dedupe_key` is.
 *
 * ## Why the dedupe key is the interesting column
 *
 * There are two distinct duplicates to stop, and they need different mechanisms:
 *
 *   1. **The same event delivered twice.** Delivery is at-least-once (AD-10), so this is normal
 *      operation, not a fault. The `inbox` unique on `(topic, event_id)` stops it, in the same
 *      transaction as the notification is written.
 *   2. **One fact described by two different events.** A new device produces both
 *      `identity.session.created` and `identity.device.added`. Both are legitimate, both have
 *      different event ids, and the inbox cannot tell they are the same news. A user who gets two
 *      "new device" alerts for one sign-in learns to ignore them, which defeats the alert.
 *
 * So the two rules for that fact return the **same** `dedupe_key`, keyed on the device rather
 * than on the event, and the unique index on `(user_id, dedupe_key)` collapses them into one
 * notification. That is why the key is built from domain identifiers and never from `event.id`.
 *
 * ## Priorities are not opinions
 *
 * `critical` is exactly 04-domain-model §10.3's list — new device, password change, MFA change,
 * key export, withdrawal — and nothing else. It is tempting to promote more (an API key is a
 * credential; a large sale is exciting) and it must be resisted: every critical notification
 * ignores the user's preferences, and a `critical` set that grows is a preference page that
 * gradually stops working.
 *
 * ## One topic, two facts: `variant`
 *
 * Nearly every topic carries one fact, so a rule fixes its priority and its template once. One
 * does not. `settlement.outbound.failed` says a withdrawal ended without reaching the chain, and
 * its `refundable` field decides whether the money is **coming back** or is **held** — two
 * different sentences to the person whose money it is, and, because one of them is the only thing
 * in the estate that will ever tell them their funds are stuck, two different priorities.
 *
 * `variant` is how a rule says that, and its shape is the argument. The rule's own `priority` and
 * `templateId` are the fact that applies **when nothing is proven**; the variant carries a `when`
 * that must return true before its priority and template are used instead. So the safe reading is
 * what an absent, malformed or unknown field produces, by construction rather than by a default
 * somebody remembered to write the right way round. Both halves are enumerable — `outcomesOf` —
 * so the coverage tests that walk every priority and every template still see all of them.
 *
 * ## Coverage
 *
 * `catalogue.test.ts` asserts that every topic in the frozen registry is either mapped here or
 * listed in `NON_NOTIFYING_TOPICS` with a reason. A topic added to the registry that nobody
 * thought about therefore fails this service's build rather than silently notifying nobody.
 */

import { TOPICS, type TopicName } from '@cloudsforge/contracts-events'
import type { Category, Priority } from './model.ts'
import type { TemplateId } from './templates.ts'
import type { InboundEvent } from './events.ts'

export interface Recipient {
  readonly userId: string
  readonly params: Record<string, unknown>
  /**
   * Stable across a redelivery of this event **and** across any other event describing the same
   * fact. Built from domain identifiers; never from `event.id`, which is different on every
   * event and would therefore dedupe nothing.
   */
  readonly dedupeKey: string
  /** `cf:<service>:<type>:<id>` — 04-domain-model §0. What the notification is *about*. */
  readonly subjectUrn: string | null
}

/**
 * Who a rule decided to notify.
 *
 * "Nobody" is a supported answer, and there are two different reasons for it that an operator
 * must be able to tell apart:
 *
 *   - `not_applicable` — the rule looked at the event and decided it is not news. A sign-in from
 *     a device the user has used a hundred times. This is the system working.
 *   - `no_recipient` — the rule wanted to notify somebody and could not work out who, because the
 *     payload did not say. This is a producer to go and fix.
 *
 * Collapsing them into an empty array loses exactly the distinction that decides whether anyone
 * needs to do anything, which is why this is a union rather than a list that might be empty.
 */
export type RecipientSet =
  | { readonly kind: 'recipients'; readonly recipients: readonly [Recipient, ...Recipient[]] }
  | { readonly kind: 'none'; readonly reason: 'not_applicable' | 'no_recipient' }

/**
 * The other fact a topic carries, and the test an event must PASS to be read as that fact.
 *
 * Deliberately not "a function from event to priority". A function cannot be enumerated, so the
 * §10.3 coverage test could no longer list every critical notification and the template-coverage
 * test could no longer prove every template is reachable — both would have degraded into "trust
 * the closure", which is how the fifteen unreachable rules survived. Data with one predicate keeps
 * every outcome visible to a test while still letting the payload choose between them.
 *
 * The asymmetry is the point: the rule's own priority and template are what an event gets when
 * `when` does not fire, so the DEFAULT is whatever the rule declares and the variant has to be
 * earned. See the `settlement.outbound.failed` rule for the case this exists for.
 */
export interface Variant {
  readonly when: (event: InboundEvent) => boolean
  readonly priority: Priority
  readonly templateId: TemplateId
  /** Why this fact is different news from the rule's own, and why it is a different priority. */
  readonly why: string
}

export interface Rule {
  readonly category: Category
  readonly priority: Priority
  readonly templateId: TemplateId
  /** Why this event is worth interrupting someone for. Read it before changing a priority. */
  readonly why: string
  readonly recipients: (event: InboundEvent) => RecipientSet
  /** Present only where one topic carries two materially different facts. See `Variant`. */
  readonly variant?: Variant
}

/** What a rule decided this particular event is: how loud, and in which words. */
export interface Outcome {
  readonly priority: Priority
  readonly templateId: TemplateId
}

/**
 * Resolve a rule against one event.
 *
 * `=== true` rather than a truthiness test on the predicate's result: the predicate is typed
 * `boolean`, and this is the second guard for the same reason its subject has one — a variant that
 * is reached by accident is a notification that says the wrong thing.
 */
export function outcomeOf(rule: Rule, event: InboundEvent): Outcome {
  if (rule.variant !== undefined && rule.variant.when(event) === true) {
    return { priority: rule.variant.priority, templateId: rule.variant.templateId }
  }
  return { priority: rule.priority, templateId: rule.templateId }
}

/** Every outcome a rule can produce. The coverage tests walk this, never `rule.priority` alone. */
export function outcomesOf(rule: Rule): readonly [Outcome, ...Outcome[]] {
  const base: Outcome = { priority: rule.priority, templateId: rule.templateId }
  if (rule.variant === undefined) return [base]
  return [base, { priority: rule.variant.priority, templateId: rule.variant.templateId }]
}

/* ------------------------------------------------------------------ payload readers */

/**
 * Read the first present string from a payload, tolerating both spellings.
 *
 * Event payloads are snake_case by the registry's own convention (`keyedBy: 'user_id'`), but
 * several producers are not written yet and JavaScript services reach for camelCase. Accepting
 * both costs one function and removes an entire class of "the notification was silently empty".
 */
function str(payload: Record<string, unknown>, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  }
  return fallback
}

function flag(payload: Record<string, unknown>, names: readonly string[]): boolean {
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return false
}

/**
 * Whether a failed withdrawal's money is coming back.
 *
 * **`=== true`, and deliberately not `flag()`.** `flag` accepts `'true'` as a string and reads
 * several spellings, which is the right tolerance for a `new_device` marker and the wrong one
 * here: this predicate has to agree, byte for byte, with the consumer that actually moves the
 * money. `wallet/src/server.ts:875` writes `refundable: payload['refundable'] === true` and says
 * why — refunding a payment that really landed pays the user twice, and that error cannot be
 * undone. `activity/src/classify.ts:192` mirrors the same `=== true` so a feed entry can never
 * read "on its way back" beside a balance wallet is holding.
 *
 * So an absent field, a string, a number and a null all mean HELD, which is the safe direction and
 * the whole reason this is a predicate with one spelling rather than a tolerant reader. Telling
 * somebody their money is coming back when it is held is the expensive error; it is also the one a
 * careless default produces, so the default is arranged to be unreachable rather than correct.
 */
function refunded(payload: Record<string, unknown>): boolean {
  return payload['refundable'] === true
}

/**
 * The withdrawal a settlement outbound event is about.
 *
 * The key is a safe fallback here and only here among the withdrawal topics: the registry keys
 * `settlement.outbound.*` by `withdrawal_id`, so the key IS this id. It is emphatically not a
 * user, which is why `userIdOf` refuses to fall back to it for this topic.
 */
function withdrawalIdOf(event: InboundEvent): string {
  return str(event.payload, ['withdrawal_id', 'withdrawalId'], event.key)
}

/**
 * The user this event is about.
 *
 * Falls back to the envelope `key` when — and only when — the registry says that topic is keyed
 * by `user_id`. Using the key blindly would attribute a `wallet.deposit.confirmed` (keyed by
 * `wallet_id`) to a user whose id happens to look like a wallet's, which is the worst possible
 * failure for this service: telling the wrong person about someone else's money.
 */
function userIdOf(event: InboundEvent): string | null {
  const fromPayload = str(event.payload, ['user_id', 'userId'], '')
  if (fromPayload) return fromPayload
  const spec = TOPICS[event.topic as TopicName]
  if (spec && spec.keyedBy === 'user_id' && event.key) return event.key
  // An `actor` of `user:<id>` is the last resort: the actor caused the event, which for these
  // topics is nearly always the same person, but "nearly" is why it is last.
  if (event.actor.startsWith('user:')) return event.actor.slice('user:'.length) || null
  return null
}

/**
 * identity's revocation reasons, in words a person can act on.
 *
 * The producer's vocabulary, not a guess: `identity/src/server.ts:960`, `:1032`, `:1095`, `:1104`
 * and `identity/src/sessions.ts:366`. An unrecognised reason falls back to a sentence that is
 * still true, because a new reason arriving from a newer identity must not blank the notification
 * — and the fallback is deliberately vague rather than wrong.
 */
const REVOCATION_REASONS: Readonly<Record<string, string>> = Object.freeze({
  password_changed: 'your password was changed',
  password_reset: 'your password was reset',
  signed_out_everywhere: 'you signed out everywhere',
  signed_out: 'you signed out',
})

/** `2026-07-30 04:12 UTC`. Deterministic on purpose: `Intl` output varies by ICU build. */
export function formatInstant(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * Build a rule whose recipient is the single user the event is about.
 *
 * Nearly every rule has this shape, and writing it once means a new rule cannot forget the
 * `userIdOf` fallback logic or the "no user, no notification" branch.
 */
function forUser(
  dedupe: (event: InboundEvent) => string,
  params: (event: InboundEvent) => Record<string, unknown>,
  subject: (event: InboundEvent) => string | null = () => null,
  applies: (event: InboundEvent) => boolean = () => true,
): Rule['recipients'] {
  return (event) => {
    if (!applies(event)) return { kind: 'none', reason: 'not_applicable' }
    const userId = userIdOf(event)
    if (!userId) return { kind: 'none', reason: 'no_recipient' }
    return {
      kind: 'recipients',
      recipients: [
        { userId, params: params(event), dedupeKey: dedupe(event), subjectUrn: subject(event) },
      ],
    }
  }
}

/* ------------------------------------------------------------------ the table */

export const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  /* --------------------------------------------------------- security · critical
   *
   * Exactly 04-domain-model §10.3's list. Every one of these ignores preferences.
   */

  'identity.session.created': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.new_device',
    why: 'A sign-in from an unrecognised device is the first observable symptom of a stolen password.',
    recipients: forUser(
      // Keyed on the device, not the session: the same device signing in twice in a minute is one
      // piece of news, and `identity.device.added` below produces this same key for the same fact.
      (event) => `security.new_device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
      (event) => ({
        device: str(event.payload, ['device_label', 'deviceLabel', 'user_agent', 'userAgent'], 'an unrecognised device'),
        ipPrefix: str(event.payload, ['ip_prefix', 'ipPrefix'], 'unknown'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:identity:device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
      // A sign-in from a device the user has used before is not news. Only the new ones are, and
      // sending all of them is how a security alert becomes background noise.
      (event) => flag(event.payload, ['new_device', 'newDevice', 'first_seen', 'firstSeen']),
    ),
  }),

  'identity.device.added': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.new_device',
    why: 'The same fact as a new-device sign-in, from the device register rather than the session.',
    recipients: forUser(
      (event) => `security.new_device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
      (event) => ({
        device: str(event.payload, ['device_label', 'deviceLabel', 'user_agent', 'userAgent'], 'an unrecognised device'),
        ipPrefix: str(event.payload, ['ip_prefix', 'ipPrefix'], 'unknown'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:identity:device:${str(event.payload, ['device_id', 'deviceId'], event.key)}`,
    ),
  }),

  /**
   * A password change, an admin revocation, and the burn that follows a stolen refresh token.
   *
   * This replaces a rule on `identity.password.changed` — a topic **no producer has ever
   * emitted**. identity does not announce a password change as its own fact; it revokes every
   * session and says why, at `identity/src/server.ts:960` (`password_changed`), `:1032`
   * (`password_reset`), `:1095` (`signed_out_everywhere`) and `:1104` (`signed_out`). So the §10.3
   * password-change notification was written against a name that does not exist, and this is the
   * event that actually carries the fact.
   *
   * An ordinary sign-out is deliberately NOT news: the user just did it, in this application, and
   * confirming it is how a security channel is trained into background noise. Everything else is —
   * a revocation the user did not perform is the visible half of an account takeover.
   *
   * NOTE for whoever wires the producer: `emitSessionRevoked` (identity/src/sessions.ts:390) has
   * no caller. `revokeSession` and `revokeAllSessions` update the rows without emitting, so this
   * rule is correct and silent until identity calls it from those two functions.
   */
  'identity.session.revoked': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.session_revoked',
    why: 'A session ended by somebody other than the user is an account takeover in progress, and the password-change case is 04-domain-model §10.3 word for word.',
    recipients: forUser(
      // Keyed on the session: one revocation, one notification, however often it is redelivered.
      // "Sign out everywhere" revokes many sessions and produces one notification per session,
      // which is correct — each is a device losing access — and the dedupe key says so.
      (event) => `security.session_revoked:${str(event.payload, ['session_id', 'sessionId'], event.key)}`,
      (event) => ({
        reason: REVOCATION_REASONS[str(event.payload, ['reason'], '')] ?? 'it was revoked',
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:identity:session:${str(event.payload, ['session_id', 'sessionId'], event.key)}`,
      // The one reason that is not news. Every other value — including one this build has never
      // seen — notifies, because an unrecognised reason is exactly when the user should look.
      (event) => str(event.payload, ['reason'], '') !== 'signed_out',
    ),
  }),

  /*
   * `remainingActive` leads the field list on both rules below, and that is the producer's
   * spelling rather than a third guess.
   *
   * identity used to emit neither of these topics — it emitted `identity.mfa.changed`, which no
   * registry declared and no consumer here classified, so both of these rules were unreachable
   * for the whole life of the service. Now that it emits `identity.mfa.removed` and
   * `identity.mfa.added` the payload has to be read with the names it actually carries, and
   * identity calls this count `remainingActive` — the same word its `FactorRemoved` result and its
   * `hasActiveFactor` query use. The older spellings stay in the list because a fallback that
   * has never been wrong costs nothing, and because `str` needs a last resort anyway.
   */

  'identity.mfa.removed': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.mfa_changed',
    why: 'Removing the last second factor leaves the account on its password alone, and today nothing tells the owner.',
    recipients: forUser(
      (event) => `security.mfa_changed:${str(event.payload, ['factor_id', 'factorId'], event.id)}`,
      (event) => ({
        change: 'removed',
        at: formatInstant(event.occurredAt),
        remainingFactors: str(
          event.payload,
          ['remaining_active', 'remainingActive', 'remaining_factors', 'remainingFactors'],
          // `wasLast` is the producer's flag for "this account now has no second factor". It is
          // the honest zero, and it was previously spelled `change: 'last_factor_removed'` on a
          // topic nothing subscribed to, so this fallback had never once fired either.
          flag(event.payload, ['was_last', 'wasLast']) ? '0' : 'unknown',
        ),
      }),
    ),
  }),

  'identity.mfa.added': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.mfa_changed',
    why: 'A second factor added by an attacker is how they keep an account after the password is reset.',
    recipients: forUser(
      (event) => `security.mfa_changed:${str(event.payload, ['factor_id', 'factorId'], event.id)}`,
      (event) => ({
        change: 'added',
        at: formatInstant(event.occurredAt),
        remainingFactors: str(
          event.payload,
          ['remaining_active', 'remainingActive', 'remaining_factors', 'remainingFactors'],
          'unknown',
        ),
      }),
    ),
  }),

  'custody.export.requested': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.key_export_requested',
    why: 'The registry says it outright: notify must reach every channel before the 24-hour cooling-off ends. This notification is the cooling-off period doing its job.',
    recipients: forUser(
      (event) => `security.key_export_requested:${str(event.payload, ['export_id', 'exportId', 'wallet_id', 'walletId'], event.id)}`,
      (event) => ({
        walletLabel: str(event.payload, ['wallet_label', 'walletLabel', 'wallet_id', 'walletId'], 'a wallet'),
        at: formatInstant(event.occurredAt),
        availableAt: formatInstant(
          str(event.payload, ['available_at', 'availableAt'], new Date(Date.parse(event.occurredAt) + 86_400_000).toISOString()),
        ),
      }),
      (event) => `cf:custody:export:${str(event.payload, ['export_id', 'exportId'], event.id)}`,
    ),
  }),

  'custody.key.exported': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.key_exported',
    why: 'A private key left the platform accompanied by a single log line. §10.3 names this as the notification a user may not opt out of.',
    recipients: forUser(
      (event) => `security.key_exported:${str(event.payload, ['key_id', 'keyId', 'wallet_id', 'walletId'], event.id)}`,
      (event) => ({
        walletLabel: str(event.payload, ['wallet_label', 'walletLabel', 'wallet_id', 'walletId'], 'a wallet'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:custody:key:${str(event.payload, ['key_id', 'keyId'], event.id)}`,
    ),
  }),

  'wallet.withdrawal.requested': Object.freeze({
    category: 'withdrawal',
    priority: 'critical',
    templateId: 'withdrawal.requested',
    why: 'Money leaving is on §10.3’s critical list. The window between request and broadcast is the only window in which a user can stop a theft.',
    recipients: forUser(
      (event) => `withdrawal.requested:${str(event.payload, ['withdrawal_id', 'withdrawalId'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'an amount'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        destination: str(event.payload, ['destination', 'to_address', 'toAddress'], 'an external address'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:wallet:withdrawal:${str(event.payload, ['withdrawal_id', 'withdrawalId'], event.id)}`,
    ),
  }),

  /* --------------------------------------------------------- security · high */


  /* --------------------------------------------------------- account and wallet */

  'identity.user.registered': Object.freeze({
    category: 'account',
    priority: 'normal',
    templateId: 'account.registered',
    why: 'The first thing the platform ever says to someone.',
    recipients: forUser(
      (event) => `account.registered:${event.key}`,
      (event) => ({ handle: str(event.payload, ['handle'], 'there') }),
      (event) => `cf:identity:user:${event.key}`,
    ),
  }),

  'wallet.wallet.created': Object.freeze({
    category: 'wallet',
    priority: 'normal',
    templateId: 'wallet.created',
    why: 'A wallet the user did not create is a symptom worth surfacing, and a wallet they did create is a confirmation they expect.',
    recipients: forUser(
      (event) => `wallet.created:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
      (event) => ({
        walletLabel: str(event.payload, ['label', 'wallet_label', 'walletLabel'], 'a new wallet'),
        chain: str(event.payload, ['chain', 'network'], 'a supported chain'),
      }),
      (event) => `cf:wallet:wallet:${str(event.payload, ['wallet_id', 'walletId'], event.key)}`,
    ),
  }),

  /* --------------------------------------------------------- money */


  'wallet.deposit.confirmed': Object.freeze({
    category: 'deposit',
    priority: 'high',
    templateId: 'deposit.confirmed',
    why: 'The money is spendable. This is the moment the user is waiting for and the one they currently poll for.',
    recipients: forUser(
      (event) => `deposit.confirmed:${str(event.payload, ['deposit_id', 'depositId', 'tx_hash', 'txHash'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'A deposit'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
      }),
      (event) => `cf:wallet:deposit:${str(event.payload, ['deposit_id', 'depositId', 'tx_hash', 'txHash'], event.id)}`,
    ),
  }),

  'settlement.withdrawal.completed': Object.freeze({
    category: 'withdrawal',
    priority: 'high',
    templateId: 'withdrawal.completed',
    why: 'Confirms the money arrived and gives the user the transaction hash before they ask support for it.',
    recipients: forUser(
      (event) => `withdrawal.completed:${event.key}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'Your withdrawal'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        destination: str(event.payload, ['destination', 'to_address', 'toAddress'], 'the destination address'),
        txHash: str(event.payload, ['tx_hash', 'txHash'], 'pending'),
      }),
      (event) => `cf:settlement:withdrawal:${event.key}`,
    ),
  }),

  'settlement.withdrawal.stuck': Object.freeze({
    category: 'withdrawal',
    priority: 'high',
    templateId: 'withdrawal.failed',
    why: 'An outbound transaction past its deadline. Silence here is a user who believes their money has vanished.',
    recipients: forUser(
      (event) => `withdrawal.failed:${str(event.payload, ['withdrawal_id', 'withdrawalId'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'a withdrawal'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        reason: str(event.payload, ['reason'], 'it has not confirmed within the expected time and is being retried'),
      }),
      (event) => `cf:settlement:withdrawal:${str(event.payload, ['withdrawal_id', 'withdrawalId'], event.id)}`,
    ),
  }),

  /**
   * A withdrawal that ended without reaching the chain — **and where the money went.**
   *
   * ## Why this rule was refused, and what changed
   *
   * `NON_NOTIFYING_TOPICS` carried this topic with the note that its envelope "names nobody notify
   * could address", and `UNPRODUCED_NOTIFICATIONS` carried the matching record. Both were right:
   * the payload was `{ withdrawalId, reason, refundable }`, `failedEvents` sets no actor (so this
   * service's relay stamps `service:settlement`), and the registry keys the topic by
   * `withdrawal_id` — which is a uuid, so a key fallback would have handed back a withdrawal id as
   * a user id. Well-formed, queryable and wrong. A rule then would have answered `no_recipient`
   * for ever, and a rule that resolves nobody is worse than a written-down gap, because the
   * coverage test counts it.
   *
   * `settlement/src/withdrawals.ts:537` now sends `userId` — the same value `stuckEvents` already
   * sent off the same row — so `forUser` resolves a recipient here exactly as it does on
   * `settlement.withdrawal.stuck`. Note what settlement did **not** do: it did not mint
   * `settlement.withdrawal.failed`. Its reasoning is on `failedEvents` and it is right — `completed`
   * has a twin because the two carry different payloads for different readers, whereas a `.failed`
   * twin would be one fact under two official names keyed identically, which is the
   * `settlement.outbound.stuck` proposal micro-contracts already refused. What was missing was the
   * recipient, not the topic.
   *
   * ## Two facts, and `refundable` decides which
   *
   * "Your withdrawal failed and the money is coming back" and "your withdrawal failed and your
   * money is held" are different news, and micro-activity classified them as two entries
   * (`withdrawal.failed_refunded` / `withdrawal.failed_held`, activity/src/classify.ts:502) for
   * exactly this reason. So this rule has a `variant` rather than one hedged sentence, and the
   * templates keep activity's names so the feed entry and the notification a user reads on the
   * same screen cannot say opposite things.
   *
   * ## The held case is `critical`, and the refunded case is not
   *
   * §10.3's critical list names **withdrawal**, so neither of these is a promotion beyond it; the
   * question is only which of the two a user may be allowed to mute. The held case may not be, on
   * one fact: **nothing else in the estate will ever tell them.** Trace it. wallet's non-refundable
   * branch (`wallet/src/withdrawals.ts:592`) moves the row to `stuck` and emits nothing at all —
   * the only `wallet.withdrawal.stuck` emit is the deadline sweep at `:684`, and that topic is in
   * no registry anyway. `settlement.withdrawal.stuck` does not fire, because a failure is not a
   * late transaction. `ledger.entry.posted` does not fire either: nothing is posted, and notify's
   * rule for it requires a `user_id` the ledger payload has never carried. The user's balance shows
   * an amount reserved against a payment that will never be made, the destination shows nothing
   * arrived, and the only account of it is this notification. A `min_priority` of `critical` on the
   * withdrawal category, or that category switched off, would turn "your money is stuck" into
   * silence — which is the exact substitution §10.3's invariant exists to forbid.
   *
   * The refunded case is `high`, beside `completed` and `stuck`. The money is back and spendable,
   * so the balance itself is a second, independent account of the fact; the user's next action is
   * "try again", not "find out where my money is"; and every unnecessary `critical` is a
   * preference page that quietly stops working (see this file's header). `high` is prompt and
   * muteable, which is what recoverable news should be.
   *
   * ## The dedupe key names the disposition, not just the withdrawal
   *
   * Two reasons. `settlement.withdrawal.stuck` already keys `withdrawal.failed:<id>`, and a
   * withdrawal that went late and then failed must produce both — the second is the outcome of the
   * first, and collapsing them would mean the user hears "it is late" and never hears how it
   * ended. And if a held failure were ever corrected to a refunded one, the correction is the most
   * important message in the sequence and must not dedupe into the thing it corrects. Literal
   * redelivery is handled where it belongs, by the inbox unique on `(topic, event_id)`.
   */
  'settlement.outbound.failed': Object.freeze({
    category: 'withdrawal',
    // The default, and the reading an absent `refundable` gets. See `refunded`.
    priority: 'critical',
    templateId: 'withdrawal.failed_held',
    why: 'A withdrawal ended with the money neither at its destination nor back in the balance, and no other event in the estate says so — wallet moves the row to stuck and emits nothing. Silence here is a user whose funds have vanished from their own view.',
    variant: Object.freeze({
      when: (event) => refunded(event.payload),
      priority: 'high',
      templateId: 'withdrawal.failed_refunded',
      why: 'The money is coming back, so the balance is a second account of the fact and the action is "try again". Prompt, and muteable — a critical set that grows past what a user must never be able to silence is a preference page that stops working.',
    } satisfies Variant),
    recipients: forUser(
      (event) =>
        `${refunded(event.payload) ? 'withdrawal.failed_refunded' : 'withdrawal.failed_held'}:${withdrawalIdOf(event)}`,
      (event) => ({
        withdrawalId: withdrawalIdOf(event),
        reason: str(event.payload, ['reason'], 'it could not be sent'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:settlement:withdrawal:${withdrawalIdOf(event)}`,
    ),
  }),

  'ledger.entry.posted': Object.freeze({
    category: 'transfer',
    priority: 'low',
    templateId: 'transfer.posted',
    why: 'The complete record of balance movement. Low priority and digestible by default — a user who wants every posting can ask for it, and one who does not must not be buried.',
    recipients: forUser(
      (event) => `transfer.posted:${str(event.payload, ['entry_id', 'entryId'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], ''),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        description: str(event.payload, ['description', 'kind'], 'a balance movement'),
      }),
      (event) => `cf:ledger:entry:${str(event.payload, ['entry_id', 'entryId'], event.id)}`,
      // A posting with no user attribution is an internal or treasury movement.
      (event) => Boolean(str(event.payload, ['user_id', 'userId'], '')),
    ),
  }),

  /* --------------------------------------------------------- products
   *
   * The three rules below are keyed to topics the shared registry does not name YET, and that is a
   * declared state rather than an accident: each is quarantined in `topics.ts` with the exact
   * `TopicSpec` that registers it and the emit site that proves the producer sends it, and
   * `topics.test.ts` fails the moment contracts adopts one and the quarantine entry is not deleted.
   * `events.ts` accepts a well-formed envelope on an unregistered topic precisely when a rule
   * exists, which is what makes them live today rather than one contracts release from now.
   *
   * Each replaces a RECORD that said the notification was impossible. It was not: the producer had
   * been emitting all along under the name notify itself had written down. See the header of
   * `topics.ts` for why a record could say that and no check inside this repository could see it.
   */

  'trade.bot.paused': Object.freeze({
    category: 'trading',
    priority: 'high',
    templateId: 'trading.bot_paused',
    why: 'A bot stopping is the state its owner most needs to hear about, and pausing does not close the position — trade/src/bots.ts:610 leaves it open and marked to market from the last tick, so silence here is a user who believes they are flat.',
    recipients: forUser(
      // Keyed on the BOT, not the event: a bot paused and resumed and paused again in a minute is
      // one piece of news, and `event.id` would dedupe nothing.
      (event) => `trading.bot_paused:${str(event.payload, ['bot_id', 'botId'], event.key)}`,
      (event) => ({
        botLabel: str(event.payload, ['bot_name', 'botName', 'name', 'bot_id', 'botId'], 'Your trading bot'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:trade:bot:${str(event.payload, ['bot_id', 'botId'], event.key)}`,
    ),
  }),

  /*
   * The two API-key rules address the ENVELOPE ACTOR, and that is the whole of why they work.
   *
   * The payload names the key and the project, never a user — `emitKeyIssued` and `emitKeyRevoked`
   * in `devplatform/src/apikeys.ts` send `{ keyId, projectId, environment, display, … }` and no
   * owner — and notify holds no project-membership table it could look one up in. `actorOf` makes
   * the actor `user:<id>` for a caller holding a session, and in the case these rules exist for — a
   * stolen session — that id IS the victim's, because the attacker is acting as them. So the
   * notification lands in the real owner's inbox: the `identity.session.created` model.
   *
   * ── THIS COMMENT PREDICTED TWO PRODUCER DEFECTS. BOTH WERE REAL, AND BOTH ARE NOW FIXED. ────
   *
   * It used to name two actor spellings devplatform emitted, `key:<display>` for an API-key caller
   * and `system:identity` on the organisation-erasure path, and call them "a producer to fix". They
   * were worse than this comment guessed: neither is a legal `Actor` at all. `ActorKind` is
   * `user | service | operator | system`, `system` is the one kind that takes NO subject, so
   * `parseActor` refuses both — every envelope on either path was one the estate rejects outright.
   * devplatform has since corrected them to `service:<display>` and `service:identity`.
   *
   * Two lessons are worth more than the citations were, and both are asserted rather than asserted
   * about — see `topics.test.ts`, `the two illegal actor spellings can never come back`:
   *
   *   1. **The prediction is now a property of the CONTRACT, not of another repository's line
   *      numbers.** The version of this note that cited `server.ts:669` and `:1527` was stale within
   *      the hour those defects were fixed, which is how a `path:line` claim always ends. What
   *      cannot go stale is `parseActor` refusing `key:` and `system:<anything>`, and that is
   *      checkable in this repository's CI, which checks out `micro-contracts` and not
   *      `micro-devplatform`.
   *   2. **The defects were invisible because a CONSUMER excused them.** `activity` quarantined
   *      unregistered topics without validating their envelopes, so an illegal actor on an
   *      unregistered topic was stored rather than refused. Registration removed that shelter.
   *      A quarantine that forgives more than the one fact it is for hides producer bugs until a
   *      release somewhere else exposes them all at once.
   *
   * ── WHAT IS STILL TRUE, AND THE GAP THAT DID NOT CLOSE ──────────────────────────────────────
   *
   * `forUser` still answers `no_recipient` for a `service:` actor, and that is CORRECT and must
   * stay: a key minting a key is no person's news, and guessing would tell the wrong person that
   * their credentials changed. What changed is why — it is now the right answer to a legal
   * envelope, not the visible symptom of a broken one.
   *
   * The consequence is a live gap rather than a resolved one. The erasure path revokes EVERY live
   * key an organisation holds, as `service:identity`, and nobody is told: no user is on that
   * envelope, and neither this service nor `activity` may read a database to find one. `activity`
   * files it as `api.key_revoked_by_platform`, internal — an operator's record and nobody's
   * notification. The repair is one field from devplatform (`api_keys.created_by` is on the row
   * `revokeOrgKeys` already updates), and it is filed for micro-devplatform, not worked around here.
   */

  'devplatform.key.issued': Object.freeze({
    category: 'api',
    priority: 'high',
    templateId: 'api.key_issued',
    why: 'An API key acts as the user, without a password and without a second factor, so a key created by somebody else is the first thing a compromise looks like — and nothing tells the account holder today.',
    recipients: forUser(
      (event) => `api.key_issued:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
      (event) => ({
        // The display (`cfk_live_…`), which is safe in a log and is what a revocation quotes. The
        // key itself never leaves devplatform and must never appear here.
        keyDisplay: str(event.payload, ['display', 'key_display', 'keyDisplay'], 'a new key'),
        project: str(event.payload, ['project_id', 'projectId'], 'your project'),
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:devplatform:api_key:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
    ),
  }),

  'devplatform.key.revoked': Object.freeze({
    category: 'api',
    priority: 'high',
    templateId: 'api.key_revoked',
    why: 'A revocation the owner did not make is somebody else inside their project, and a revocation they DID make silently breaks every integration using it — both halves are worth an interruption.',
    recipients: forUser(
      (event) => `api.key_revoked:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
      (event) => ({
        keyDisplay: str(event.payload, ['display', 'key_display', 'keyDisplay'], 'a key'),
        project: str(event.payload, ['project_id', 'projectId'], 'your project'),
        at: formatInstant(event.occurredAt),
        reason: str(event.payload, ['reason'], 'no reason was recorded'),
      }),
      (event) => `cf:devplatform:api_key:${str(event.payload, ['key_id', 'keyId'], event.key)}`,
    ),
  }),

  /**
   * Somebody offered on your listing — **and the recipient is the person who did not act.**
   *
   * ## The refusal that was right, and the one field that ended it
   *
   * This rule was refused for the life of the service and the refusal is recorded in `topics.ts`:
   * `market/src/bids.ts` emitted `{ listingId, offerId, offererSubject, amount, assetCode }` with
   * the OFFERER as the envelope actor, so every route this service has to a person — payload
   * `user_id`, the key, the `user:` actor — resolved the offerer. A rule then would have told the
   * offerer that their own offer arrived: noise, a false claim of AD-08 coverage, and a
   * notification about someone else's money sent to the wrong person.
   *
   * `market/src/bids.ts:477` now sends `sellerSubject`, read off the listing row the same
   * transaction already holds `for update`, so it is the seller **at the moment the offer was
   * made** rather than whoever owns the listing when a consumer gets round to reading it. Market's
   * own commit names this rule as the thing that closes its record.
   *
   * ## `forUser` is deliberately not used here
   *
   * `userIdOf` falls back to `actor` when it is `user:<id>`, and on this envelope that actor IS the
   * offerer. So the generic helper would resolve the wrong person on every event — the same trap as
   * `aetherholm.battle.resolved`, where the actor is the raider and the notification is the
   * defender's. The seller is read explicitly or there is no recipient.
   *
   * ## A subject is not a user id
   *
   * `sellerSubject` is `user:<uuid>` **or** `service:<name>`: a listing may be owned by a service
   * principal (`market/src/server.ts:713` takes the seller from `subjectOf(principal)`). Stripping
   * the prefix blindly would address a notification to a service name — a row keyed on a user id
   * that is not one. A non-`user:` seller is `not_applicable`: the rule looked at it and decided a
   * service principal is not a person to interrupt, which is a different fact from "the producer
   * did not say who", and the two must not collapse into one metric.
   */
  'market.offer.made': Object.freeze({
    category: 'market',
    priority: 'normal',
    templateId: 'market.offer_received',
    why: 'A seller with an offer nobody told them about is a sale that does not happen. The offer holds the buyer\'s money in escrow while it waits, so silence costs both sides.',
    recipients: (event: InboundEvent): RecipientSet => {
      const seller = str(event.payload, ['seller_subject', 'sellerSubject'], '')
      if (!seller) return { kind: 'none', reason: 'no_recipient' }
      // Never `slice` without checking the prefix: `service:mint` would become a "user id" of
      // `mint`, and the row would be filed against a user that does not exist.
      if (!seller.startsWith('user:')) {
        // A RECOGNISED non-user principal is `not_applicable` — the producer said exactly who the
        // seller is and the answer is that they are not a person. Anything else is a producer that
        // has stopped spelling a subject (a bare uuid, most likely) and is `no_recipient`, because
        // the two must not collapse: `not_applicable` on a malformed subject would silently swallow
        // every offer notification while reporting the rule as working, which is precisely the
        // "reports itself as delivered" failure this catalogue exists to make impossible.
        const known =
          seller.startsWith('service:') || seller.startsWith('operator:') || seller === 'system'
        return { kind: 'none', reason: known ? 'not_applicable' : 'no_recipient' }
      }
      const userId = seller.slice('user:'.length)
      if (!userId) return { kind: 'none', reason: 'no_recipient' }
      const offerId = str(event.payload, ['offer_id', 'offerId'], event.id)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId,
            params: {
              amount: str(event.payload, ['amount'], 'An offer'),
              asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
              // The listing, because a seller with several needs to know which one.
              listingId: str(event.payload, ['listing_id', 'listingId'], event.key),
            },
            // Keyed on the OFFER, not the listing: a second offer on the same listing is a second
            // piece of news, and keying on the listing would silence every offer after the first.
            dedupeKey: `market.offer_received:${offerId}`,
            subjectUrn: `cf:market:listing:${str(event.payload, ['listing_id', 'listingId'], event.key)}`,
          },
        ],
      }
    },
  }),

  'market.listing.sold': Object.freeze({
    category: 'market',
    priority: 'high',
    templateId: 'market.sale',
    why: 'A sale is money in. The seller should not find out by checking.',
    recipients: forUser(
      (event) => `market.sale:${event.key}`,
      (event) => ({
        itemName: str(event.payload, ['item_name', 'itemName', 'title'], 'Your listing'),
        amount: str(event.payload, ['amount', 'price'], ''),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
      }),
      (event) => `cf:market:listing:${event.key}`,
    ),
  }),



  'mint.deploy.confirmed': Object.freeze({
    category: 'token',
    priority: 'high',
    templateId: 'token.deployed',
    why: 'This is the event that retires ForgeMint’s four-second client poll. The client can stop asking because it is told.',
    recipients: forUser(
      (event) => `token.deployed:${event.key}`,
      (event) => ({
        tokenName: str(event.payload, ['token_name', 'tokenName', 'name', 'symbol'], 'Your token'),
        address: str(event.payload, ['address', 'contract_address', 'contractAddress'], 'the deployed address'),
        chain: str(event.payload, ['chain', 'network'], 'the network'),
      }),
      (event) => `cf:mint:token:${event.key}`,
    ),
  }),

  'worlds.provision.failed': Object.freeze({
    category: 'billing',
    priority: 'high',
    templateId: 'provision.failed',
    why: 'Money was paid and the thing it bought was not delivered. That is the one game event a person must not discover by revisiting a screen.',
    // NOT forUser: the payload names the buyer as `subject` (worlds/src/provisioning.ts:608) and
    // the actor is `service:worlds`, so userIdOf would find nobody and the rule would silently
    // notify no one — the same shape as the raider/defender trap in aetherholm.battle.resolved.
    recipients: (event: InboundEvent): RecipientSet => {
      const subject = str(event.payload, ['subject'], '')
      if (!subject) return { kind: 'none', reason: 'no_recipient' }
      const entitlementId = str(event.payload, ['entitlement_id', 'entitlementId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: subject,
            params: { entitlementId },
            dedupeKey: `provision.failed:${entitlementId}`,
            subjectUrn: `cf:worlds:entitlement:${entitlementId}`,
          },
        ],
      }
    },
  }),
  'emberkin.reward.granted': Object.freeze({
    category: 'reward',
    priority: 'normal',
    templateId: 'reward.granted',
    why: 'Same reasoning as worlds.reward.granted: Shards were earned, and a reward nobody was told about does not bring the player back.',
    recipients: forUser(
      (event) => `emberkin.reward:${str(event.payload, ['journalEntryId', 'journal_entry_id'], event.key)}`,
      (event) => ({
        rewardName: `${str(event.payload, ['amount'], 'a reward of')} Shards`,
        titleName: 'Emberkin',
      }),
      () => 'cf:emberkin:reward',
    ),
  }),
  'worlds.reward.granted': Object.freeze({
    category: 'reward',
    priority: 'normal',
    templateId: 'reward.granted',
    why: 'A reward nobody was told about is a reward that does not bring the player back.',
    recipients: forUser(
      (event) => `reward.granted:${str(event.payload, ['reward_id', 'rewardId'], event.id)}`,
      (event) => ({
        rewardName: str(event.payload, ['reward_name', 'rewardName', 'name'], 'a reward'),
        titleName: str(event.payload, ['title_name', 'titleName', 'title'], 'a game'),
      }),
      (event) => `cf:worlds:reward:${str(event.payload, ['reward_id', 'rewardId'], event.id)}`,
    ),
  }),

  'community.proposal.opened': Object.freeze({
    category: 'community',
    priority: 'normal',
    templateId: 'community.proposal',
    why: 'A proposal a member never saw is a vote they could not cast.',
    recipients: (event: InboundEvent) => membersOf(event, 'open'),
  }),

  'community.proposal.executed': Object.freeze({
    category: 'community',
    priority: 'normal',
    templateId: 'community.proposal',
    why: 'A passed proposal cleared its timelock and spent the treasury. Members are entitled to know.',
    recipients: (event: InboundEvent) => membersOf(event, 'executed'),
  }),

  'community.vote.cast': Object.freeze({
    category: 'governance',
    priority: 'normal',
    templateId: 'governance.vote',
    why: 'A receipt. "Was my vote counted, and at what weight" must be answerable without support.',
    recipients: forUser(
      (event) => `governance.vote:${str(event.payload, ['proposal_id', 'proposalId'], event.key)}:${str(event.payload, ['user_id', 'userId'], event.id)}`,
      (event) => ({
        communityName: str(event.payload, ['community_name', 'communityName'], 'your community'),
        proposalTitle: str(event.payload, ['proposal_title', 'proposalTitle', 'title'], 'a proposal'),
        choice: str(event.payload, ['choice', 'vote'], 'recorded'),
        weight: str(event.payload, ['weight'], 'your holding at the snapshot block'),
      }),
      (event) => `cf:community:proposal:${str(event.payload, ['proposal_id', 'proposalId'], event.key)}`,
    ),
  }),



  'billing.entitlement.granted': Object.freeze({
    category: 'billing',
    priority: 'normal',
    templateId: 'billing.entitlement_granted',
    why: 'Someone bought something. The estate’s named defect is the private world that is paid for and never built; this is the user-facing half of noticing.',
    recipients: forUser(
      (event) => `billing.entitlement_granted:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
      (event) => ({ productName: str(event.payload, ['product_name', 'productName', 'product'], 'Your purchase') }),
      (event) => `cf:billing:entitlement:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
    ),
  }),

  'billing.entitlement.revoked': Object.freeze({
    category: 'billing',
    priority: 'high',
    templateId: 'billing.entitlement_revoked',
    why: 'Access ending without warning looks like a fault. Saying why turns a support ticket into a renewal.',
    recipients: forUser(
      (event) => `billing.entitlement_revoked:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
      (event) => ({
        productName: str(event.payload, ['product_name', 'productName', 'product'], 'a product'),
        reason: str(event.payload, ['reason'], 'the subscription ended'),
      }),
      (event) => `cf:billing:entitlement:${str(event.payload, ['entitlement_id', 'entitlementId'], event.id)}`,
    ),
  }),

  /* --------------------------------------------------------- aetherholm */

  'aetherholm.battle.resolved': Object.freeze({
    category: 'ownership',
    priority: 'high',
    templateId: 'ownership.battle_report',
    why: '"Your city was raided" is exactly what this channel exists for: it happened while the player was away, it cost them something, and the one action — look at the report, rebuild, retaliate — is theirs to take.',
    // NOT forUser: its userIdOf falls back to the envelope ACTOR, and this event's actor is the
    // ATTACKER (aetherholm/src/fleets.ts, `user:` actor on the emit). The payload names both
    // sides; the recipient is the DEFENDER, read explicitly or not at all.
    recipients: (event: InboundEvent): RecipientSet => {
      const defender = str(event.payload, ['defender_user_id', 'defenderUserId'], '')
      if (!defender) return { kind: 'none', reason: 'no_recipient' }
      const battleId = str(event.payload, ['battle_id', 'battleId'], event.key)
      return {
        kind: 'recipients',
        recipients: [
          {
            userId: defender,
            params: {
              cityName: str(event.payload, ['city_name', 'cityName'], 'your city'),
              outcome: str(event.payload, ['outcome'], 'resolved'),
              at: formatInstant(event.occurredAt),
            },
            // One battle, one notification — however many times the event is redelivered.
            dedupeKey: `aetherholm.battle:${battleId}`,
            subjectUrn: `cf:aetherholm:battle:${battleId}`,
          },
        ],
      }
    },
  }),

  'aetherholm.spire.captured': Object.freeze({
    category: 'reward',
    priority: 'normal',
    templateId: 'reward.heraldry',
    why: 'A 120-day campaign ended with this player on the objective, and the heraldry outlives the world it was won in. Once per season is the opposite of noise.',
    // The producer carries every member of the holding alliance on the payload (the community
    // events precedent, membersOf above): notify holds no membership table and must not guess.
    recipients: (event: InboundEvent): RecipientSet => {
      const raw = event.payload['user_ids'] ?? event.payload['userIds']
      const ids = Array.isArray(raw)
        ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      const seasonId = str(event.payload, ['season_id', 'seasonId'], event.id)
      const islandId = str(event.payload, ['island_id', 'islandId'], event.key)
      const params = { seasonName: str(event.payload, ['season_name', 'seasonName'], 'the season') }
      const recipients = ids.map((userId) => ({
        userId,
        params,
        dedupeKey: `aetherholm.spire:${seasonId}:${islandId}`,
        subjectUrn: `cf:aetherholm:island:${islandId}`,
      }))
      const [first, ...rest] = recipients
      if (!first) return { kind: 'none', reason: 'no_recipient' }
      return { kind: 'recipients', recipients: [first, ...rest] }
    },
  }),

  /* --------------------------------------------------------- platform */

} satisfies Readonly<Record<string, Rule>>)

/**
 * Community events name a community, not a user, and this service does not hold memberships.
 *
 * Rather than have notify grow a shadow copy of the membership table — which would be wrong the
 * moment somebody joins — the producer is expected to carry the affected user ids on the payload.
 * When it does not, the event produces nothing and is recorded as `no_recipient`, which is
 * visible and fixable, instead of being delivered to a guess.
 */
function membersOf(event: InboundEvent, status: string): RecipientSet {
  const raw = event.payload['user_ids'] ?? event.payload['userIds'] ?? event.payload['members']
  const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  const proposalId = str(event.payload, ['proposal_id', 'proposalId'], event.id)
  const params = {
    communityName: str(event.payload, ['community_name', 'communityName'], 'your community'),
    proposalTitle: str(event.payload, ['proposal_title', 'proposalTitle', 'title'], 'a proposal'),
    status,
  }
  const recipients = ids.map((userId) => ({
    userId,
    params,
    dedupeKey: `community.proposal:${proposalId}:${status}`,
    subjectUrn: `cf:community:proposal:${proposalId}`,
  }))
  const [first, ...rest] = recipients
  if (!first) return { kind: 'none', reason: 'no_recipient' }
  return { kind: 'recipients', recipients: [first, ...rest] }
}

export function ruleFor(topic: string): Rule | undefined {
  return Object.hasOwn(RULES, topic) ? RULES[topic] : undefined
}

export function hasRule(topic: string): boolean {
  return Object.hasOwn(RULES, topic)
}

export const MAPPED_TOPICS: readonly string[] = Object.freeze(Object.keys(RULES))

/**
 * Registered topics that deliberately produce no notification, and why.
 *
 * Kept as data rather than as an omission so that `catalogue.test.ts` can assert full coverage of
 * the registry. An unlisted, unmapped topic fails the build — which is the only way a topic added
 * to the shared registry gets *considered* by this service rather than silently ignored.
 */
export const NON_NOTIFYING_TOPICS: Readonly<Record<string, string>> = Object.freeze({
  'identity.user.deleted':
    'Erasure, not news. Handled by the pipeline as a deletion of everything this service holds for the user — see ERASURE_TOPICS. Sending a notification to an account being erased would be both useless and a data-retention problem.',
  // ── aetherholm, the first game in the registry ─────────────────────────────────────────────
  // Phase 2 changed the answer for two topics: battle.resolved and spire.captured now have
  // RULES above — the first game events worth an interruption. The phase-1 five below keep
  // their reasons, each a decision rather than a deferral, and season.sealed joins them.
  'worlds.title.registered':
    'An operator act on the platform with no player subject. The operator who ran it is looking at the result; a notification would inform the person who just did the thing.',
  'worlds.provision.completed':
    'Same reasoning as aetherholm.skerry.provisioned: the outcome surfaces on the worlds provisions screen the buyer is already on. The FAILURE notifies (see the rule), because a failure is the case the buyer is not watching for.',
  'emberkin.achievement.unlocked':
    'The player unlocked it in-game and the game celebrates it in-game. An out-of-band ping for an in-band moment trains people to ignore this channel; the feed keeps the record.',
  'emberkin.battle.resolved':
    'The player fought the battle themselves, watching. Confirming a thing the person just did is noise; the feed keeps the record.',
  'emberkin.cosmetic.equipped':
    'The player equipped it, in the wardrobe screen, on purpose. Nothing here is news to its only possible recipient.',
  'emberkin.save.started':
    'Starting a campaign is the beginning of a session, not an event to interrupt it with.',
  'emberkin.season.started':
    'A world event with no individual subject, like aetherholm.season.opened: announcing a season is marketing, and /admin/broadcasts is the honest channel for it.',
  'aetherholm.season.opened':
    'A world event with no individual subject. Announcing a season is product marketing, not a notification; a broadcast through /admin/broadcasts is the honest channel if one is wanted.',
  'aetherholm.city.founded':
    'The user themselves just did it, in the client, and is looking at the city they founded. Confirming a thing the person watched happen is noise that trains them to ignore this channel.',
  'aetherholm.building.completed':
    'Phase-1 queues are minutes long and the player is usually present; a per-completion ping would be the worst noise source in the estate. A digest-eligible completion notification is a later, deliberate decision once real queue lengths exist.',
  'aetherholm.research.completed':
    'Same reasoning as building.completed: present-player noise now, a possible digest entry later, decided with data rather than by default.',
  'aetherholm.skerry.provisioned':
    'The provision is requested from worlds and its outcome surfaces in the worlds provisions screen the buyer is already on. If provisioning ever becomes slow enough to leave, a completion notification becomes worth its interruption and gets a rule.',
  'aetherholm.season.sealed':
    'A world event whose personal half already notifies: every victor hears through spire.captured, with the members carried on that payload. Telling every player their world ended is an announcement, not a notification — the broadcast channel is the honest one, and worlds consumes this event for heraldry entitlements, not people.',
  'ledger.reconciliation.completed':
    'Custody total against indexer-observed total. It concerns operators and freezes withdrawals; no individual user is its subject.',
  // ── settlement's handover topics ───────────────────────────────────────────────────────────
  // `settlement.outbound.failed` USED TO BE HERE, recorded as "a notification the estate still
  // owes somebody" because its envelope named nobody. It is a rule now: settlement put `userId` on
  // the payload (withdrawals.ts:537) and the recipient — the only thing that was missing — resolves.
  // The two that remain are settlement talking to wallet or to reconciliation, not to a person.
  'settlement.outbound.confirmed':
    "wallet's own narrow name for the same movement settlement.withdrawal.completed announces (settlement/src/withdrawals.ts:437 and :449 emit both from one function). It exists to release the reservation at wallet/src/server.ts:846 and carries a withdrawal id, a hash and a timestamp. A rule here as well would tell one user their withdrawal arrived twice. Note that this is NOT the shape of the failure twin, which had no user-facing counterpart at all and is now mapped: a second rule here would duplicate a notification, whereas the failure had none.",
  'settlement.sweep.completed':
    "A deposit address emptied into the pinned treasury. No user balance changes — wallet credited the deposit when it confirmed, long before the sweep — so there is nothing here a person could act on or would recognise. It exists for reconciliation, which is the one movement no other topic reports, and it is keyed by the sweep source rather than by anybody.",
})

/**
 * Topics that mean "delete everything you hold about this user".
 *
 * Notify holds notification bodies, email addresses, phone numbers and push tokens, so it is one
 * of the services that most needs to honour this.
 *
 * **This comment used to end "identity.user.deleted currently has no subscriber anywhere in the
 * estate, which is precisely why there is no GDPR erasure path", and that has stopped being
 * true.** Three services consume it today: this one (`pipeline.ts`, `eraseUser`),
 * `activity/src/ingest.ts:186`, which erases rather than writing "your account was deleted" into
 * the feed of a user who no longer exists, and `trade/src/server.ts:747`, whose `SUBSCRIBED_TOPICS`
 * holds this and nothing else. The erasure path exists; what nobody has checked is whether every
 * service holding a `user_id` is on it, and that is a question only a checkout holding all of them
 * can answer — `micro-org`'s `tools/estate-topics.mjs`, the same place the cross-repository half of
 * `topics.ts`'s staleness question went.
 */
export const ERASURE_TOPICS: ReadonlySet<string> = new Set(['identity.user.deleted'])

/** Every topic this service will accept over `/ingest`. */
export function isKnownTopic(topic: string): boolean {
  return hasRule(topic) || ERASURE_TOPICS.has(topic) || Object.hasOwn(NON_NOTIFYING_TOPICS, topic)
}

/** Registry topics with no rule and no recorded reason. Empty in a correct build. */
export function unmappedRegistryTopics(): readonly TopicName[] {
  return (Object.keys(TOPICS) as TopicName[]).filter((topic) => !isKnownTopic(topic))
}
