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

export interface Rule {
  readonly category: Category
  readonly priority: Priority
  readonly templateId: TemplateId
  /** Why this event is worth interrupting someone for. Read it before changing a priority. */
  readonly why: string
  readonly recipients: (event: InboundEvent) => RecipientSet
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

  'identity.password.changed': Object.freeze({
    category: 'security',
    priority: 'critical',
    templateId: 'security.password_changed',
    why: 'A password change the user did not make is an account takeover already in progress.',
    recipients: forUser(
      (event) => `security.password_changed:${event.id}`,
      (event) => ({ at: formatInstant(event.occurredAt) }),
    ),
  }),

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
        remainingFactors: str(event.payload, ['remaining_factors', 'remainingFactors'], flag(event.payload, ['was_last', 'wasLast']) ? '0' : 'unknown'),
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
        remainingFactors: str(event.payload, ['remaining_factors', 'remainingFactors'], 'unknown'),
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

  'policy.limit.reached': Object.freeze({
    category: 'security',
    priority: 'high',
    templateId: 'security.risk_limit_reached',
    why: 'A limit that fires without telling the user produces a support ticket that says "it just did not work".',
    recipients: forUser(
      (event) => `security.risk_limit_reached:${str(event.payload, ['limit', 'limit_name', 'limitName'], 'limit')}:${str(event.payload, ['window', 'period'], event.occurredAt.slice(0, 13))}`,
      (event) => ({
        limit: str(event.payload, ['limit', 'limit_name', 'limitName'], 'risk'),
        action: str(event.payload, ['action'], 'an action'),
        at: formatInstant(event.occurredAt),
      }),
    ),
  }),

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

  'wallet.deposit.detected': Object.freeze({
    category: 'deposit',
    priority: 'normal',
    templateId: 'deposit.detected',
    why: 'Users currently learn a deposit is coming by refreshing. Seen-but-not-yet-credited is the state that generates the support ticket.',
    recipients: forUser(
      (event) => `deposit.detected:${str(event.payload, ['tx_hash', 'txHash', 'deposit_id', 'depositId'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'a deposit'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        confirmations: str(event.payload, ['confirmations'], '0'),
        required: str(event.payload, ['required_confirmations', 'requiredConfirmations'], 'the required number of'),
      }),
      (event) => `cf:wallet:deposit:${str(event.payload, ['deposit_id', 'depositId', 'tx_hash', 'txHash'], event.id)}`,
    ),
  }),

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

  'settlement.transaction.failed': Object.freeze({
    category: 'withdrawal',
    priority: 'high',
    templateId: 'withdrawal.failed',
    why: 'A transaction that failed outright, as opposed to one that is merely late.',
    recipients: forUser(
      (event) => `withdrawal.failed:${str(event.payload, ['withdrawal_id', 'withdrawalId', 'transaction_id', 'transactionId'], event.id)}`,
      (event) => ({
        amount: str(event.payload, ['amount'], 'a transaction'),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
        reason: str(event.payload, ['reason', 'error'], 'the network rejected it'),
      }),
      (event) => `cf:settlement:transaction:${str(event.payload, ['transaction_id', 'transactionId'], event.id)}`,
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

  /* --------------------------------------------------------- products */

  'trade.bot.triggered': Object.freeze({
    category: 'trading',
    priority: 'high',
    templateId: 'trading.bot_event',
    why: 'A bot acting on money without telling its owner is the single most common cause of "I did not authorise that trade".',
    recipients: forUser(
      (event) => `trading.bot_event:${str(event.payload, ['bot_id', 'botId'], event.key)}:${str(event.payload, ['event', 'trigger'], event.id)}`,
      (event) => ({
        botName: str(event.payload, ['bot_name', 'botName'], 'your bot'),
        event: str(event.payload, ['event', 'trigger'], 'triggered'),
        detail: str(event.payload, ['detail', 'reason'], 'Open the bot to see the full order history.'),
      }),
      (event) => `cf:trade:bot:${str(event.payload, ['bot_id', 'botId'], event.key)}`,
    ),
  }),

  'trade.bot.stopped': Object.freeze({
    category: 'trading',
    priority: 'high',
    templateId: 'trading.bot_event',
    why: 'A bot that stopped is a bot no longer managing a position the user believes is managed.',
    recipients: forUser(
      (event) => `trading.bot_event:${str(event.payload, ['bot_id', 'botId'], event.key)}:stopped`,
      (event) => ({
        botName: str(event.payload, ['bot_name', 'botName'], 'your bot'),
        event: 'stopped',
        detail: str(event.payload, ['reason', 'detail'], 'It is no longer managing its position.'),
      }),
      (event) => `cf:trade:bot:${str(event.payload, ['bot_id', 'botId'], event.key)}`,
    ),
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

  'market.offer.received': Object.freeze({
    category: 'market',
    priority: 'normal',
    templateId: 'market.offer',
    why: 'Offers expire. An offer the seller never saw is a sale that did not happen.',
    recipients: forUser(
      (event) => `market.offer:${str(event.payload, ['offer_id', 'offerId'], event.id)}`,
      (event) => ({
        itemName: str(event.payload, ['item_name', 'itemName', 'title'], 'your listing'),
        amount: str(event.payload, ['amount', 'price'], ''),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
      }),
      (event) => `cf:market:offer:${str(event.payload, ['offer_id', 'offerId'], event.id)}`,
    ),
  }),

  'market.auction.ended': Object.freeze({
    category: 'market',
    priority: 'normal',
    templateId: 'market.auction',
    why: 'An auction status change is time-bound information: outbid, ending soon, ended.',
    recipients: forUser(
      (event) => `market.auction:${str(event.payload, ['auction_id', 'auctionId'], event.key)}:${str(event.payload, ['status'], 'ended')}`,
      (event) => ({
        itemName: str(event.payload, ['item_name', 'itemName', 'title'], 'an item'),
        status: str(event.payload, ['status'], 'ended'),
        amount: str(event.payload, ['amount', 'price', 'highest_bid', 'highestBid'], ''),
        asset: str(event.payload, ['asset_code', 'assetCode', 'asset'], ''),
      }),
      (event) => `cf:market:auction:${str(event.payload, ['auction_id', 'auctionId'], event.key)}`,
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

  'devplatform.apikey.created': Object.freeze({
    category: 'api',
    priority: 'high',
    templateId: 'api.key_event',
    why: 'An API key acts as the user. One created by somebody else is a persistent credential nobody sees in a session list.',
    recipients: forUser(
      (event) => `api.key_event:${str(event.payload, ['key_id', 'keyId'], event.id)}:created`,
      (event) => ({
        keyLabel: str(event.payload, ['label', 'key_label', 'keyLabel'], 'an unnamed key'),
        event: 'created',
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:devplatform:apikey:${str(event.payload, ['key_id', 'keyId'], event.id)}`,
    ),
  }),

  'devplatform.apikey.revoked': Object.freeze({
    category: 'api',
    priority: 'high',
    templateId: 'api.key_event',
    why: 'A revocation the owner did not make means someone is locking them out of their own integration.',
    recipients: forUser(
      (event) => `api.key_event:${str(event.payload, ['key_id', 'keyId'], event.id)}:revoked`,
      (event) => ({
        keyLabel: str(event.payload, ['label', 'key_label', 'keyLabel'], 'an unnamed key'),
        event: 'revoked',
        at: formatInstant(event.occurredAt),
      }),
      (event) => `cf:devplatform:apikey:${str(event.payload, ['key_id', 'keyId'], event.id)}`,
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

  'admin_api.incident.opened': Object.freeze({
    category: 'system',
    priority: 'high',
    templateId: 'system.incident',
    why: 'An incident that reaches users before they reach support. The status page is the other half; this is the push.',
    // An incident concerns everybody, so it takes the broadcast fan-out path rather than naming a
    // user here — the same machinery an operator uses at POST /admin/broadcasts, which is one
    // fan-out rather than two. `pipeline.ts` recognises this rule's category and routes it there.
    recipients: (): RecipientSet => ({ kind: 'none', reason: 'not_applicable' }),
  }),
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
})

/**
 * Topics that mean "delete everything you hold about this user".
 *
 * `identity.user.deleted` currently has no subscriber anywhere in the estate, which is precisely
 * why there is no GDPR erasure path. Notify holds notification bodies, email addresses, phone
 * numbers and push tokens, so it is one of the services that most needs to honour it.
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
