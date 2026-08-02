/**
 * Templates: the words, their parameters, and the localisation seam.
 *
 * Three properties are being bought here, and each one is a defect the estate has today.
 *
 *   1. **A template declares its parameters.** `catalogue.test.ts` asserts that every rule
 *      supplies every parameter its template requires. Today the estate's one outbound email
 *      interpolates whatever the caller passed and renders "Hello undefined" if it was wrong.
 *   2. **A missing parameter degrades, it does not throw.** Rendering returns the text with the
 *      placeholder blanked and lists what was missing. A notification with a gap in it is
 *      recoverable; a critical notification that threw on the way out of the door is a breach of
 *      04-domain-model §10.3.
 *   3. **Locale is a key, not a rewrite.** Every template is a map from locale to text with
 *      `en-GB` required. Adding a language is adding keys, and no call site changes.
 *
 * **Parameters are never logged.** A template parameter is arbitrary domain data — an address, an
 * amount, a device, a transaction hash — and the estate has already been burned once by putting a
 * live credential in a log line. Log the template id and the parameter *names*; never the values.
 */

import type { Category, Locale } from './model.ts'
import { DEFAULT_LOCALE } from './model.ts'

export interface TemplateText {
  readonly subject: string
  readonly body: string
}

export interface Template {
  readonly id: string
  readonly category: Category
  /** Names that must be present in `params`. Checked by the catalogue test, not at runtime. */
  readonly params: readonly string[]
  /**
   * Where the notification points, relative to `NOTIFY_PUBLIC_URL`. Substituted from the same
   * parameters. Relative because the origin is configuration: a link built from a request's Host
   * header is how identity was made to send genuine mail pointing at a host the attacker chose.
   */
  readonly path: string
  readonly text: Readonly<Record<Locale, TemplateText>>
}

/** British English throughout — "recognise", "authorised", "-ise" not "-ize". */
const en = (subject: string, body: string): Readonly<Record<Locale, TemplateText>> =>
  Object.freeze({ 'en-GB': Object.freeze({ subject, body }) })

/**
 * Every template. Frozen, and the only place a user-visible sentence is written.
 *
 * The security wording is deliberately actionable: a notification that says "a new device signed
 * in" and nothing else has told the user a fact they cannot act on. Each one names what happened,
 * when, and the single thing to do if it was not them.
 */
export const TEMPLATES = Object.freeze({
  /* ------------------------------------------------------------------ security, critical */

  'security.new_device': Object.freeze({
    id: 'security.new_device',
    category: 'security',
    params: ['device', 'ipPrefix', 'at'],
    path: '/settings/security/devices',
    text: en(
      'A new device signed in to your CloudsForge account',
      'A new device signed in to your account at {{at}}.\n\nDevice: {{device}}\nApproximate location: {{ipPrefix}}\n\nIf this was not you, sign out everywhere and change your password now.',
    ),
  }),
  'security.password_changed': Object.freeze({
    id: 'security.password_changed',
    category: 'security',
    params: ['at'],
    path: '/settings/security',
    text: en(
      'Your password was changed',
      'Your account password was changed at {{at}}.\n\nIf this was not you, your account may be compromised. Reset your password and contact support immediately.',
    ),
  }),
  'security.mfa_changed': Object.freeze({
    id: 'security.mfa_changed',
    category: 'security',
    params: ['change', 'at', 'remainingFactors'],
    path: '/settings/security',
    text: en(
      'Your two-factor authentication was changed',
      'Two-factor authentication on your account was {{change}} at {{at}}.\n\nActive factors remaining: {{remainingFactors}}.\n\nIf this was not you, restore a second factor now — an account with none is protected by its password alone.',
    ),
  }),
  'security.key_export_requested': Object.freeze({
    id: 'security.key_export_requested',
    category: 'security',
    params: ['walletLabel', 'at', 'availableAt'],
    path: '/settings/security/exports',
    text: en(
      'A private key export was requested',
      'An export of the private key for {{walletLabel}} was requested at {{at}}.\n\nA 24-hour cooling-off period applies: the key becomes available at {{availableAt}}. Until then this request can be cancelled.\n\nIf this was not you, cancel it now and change your password.',
    ),
  }),
  'security.key_exported': Object.freeze({
    id: 'security.key_exported',
    category: 'security',
    params: ['walletLabel', 'at'],
    path: '/settings/security/exports',
    text: en(
      'A private key left the platform',
      'The private key for {{walletLabel}} was exported at {{at}}. That wallet is self-custodied from now on: CloudsForge can no longer protect, recover or freeze it.\n\nIf this was not you, treat every asset in that wallet as compromised and move it immediately.',
    ),
  }),
  'security.risk_limit_reached': Object.freeze({
    id: 'security.risk_limit_reached',
    category: 'security',
    params: ['limit', 'action', 'at'],
    path: '/settings/security',
    text: en(
      'A security limit was reached on your account',
      'The {{limit}} limit was reached at {{at}} while attempting {{action}}. The action was held for review.\n\nIf you did not attempt it, change your password and review your devices.',
    ),
  }),

  /* ------------------------------------------------------------------ account and wallet */

  'account.registered': Object.freeze({
    id: 'account.registered',
    category: 'account',
    params: ['handle'],
    path: '/',
    text: en('Welcome to CloudsForge', 'Your account @{{handle}} is ready.'),
  }),
  'wallet.created': Object.freeze({
    id: 'wallet.created',
    category: 'wallet',
    params: ['walletLabel', 'chain'],
    path: '/wallet',
    text: en(
      'A new wallet was created',
      'A {{chain}} wallet, {{walletLabel}}, was added to your account.',
    ),
  }),

  /* ------------------------------------------------------------------ money */

  'deposit.detected': Object.freeze({
    id: 'deposit.detected',
    category: 'deposit',
    params: ['amount', 'asset', 'confirmations', 'required'],
    path: '/wallet/activity',
    text: en(
      'A deposit is on its way',
      'We can see {{amount}} {{asset}} arriving. It has {{confirmations}} of the {{required}} confirmations it needs before it is credited.',
    ),
  }),
  'deposit.confirmed': Object.freeze({
    id: 'deposit.confirmed',
    category: 'deposit',
    params: ['amount', 'asset'],
    path: '/wallet/activity',
    text: en('Your deposit has been credited', '{{amount}} {{asset}} is now available in your wallet.'),
  }),
  'withdrawal.requested': Object.freeze({
    id: 'withdrawal.requested',
    category: 'withdrawal',
    params: ['amount', 'asset', 'destination', 'at'],
    path: '/wallet/activity',
    text: en(
      'A withdrawal was requested from your account',
      'A withdrawal of {{amount}} {{asset}} to {{destination}} was requested at {{at}}.\n\nIf this was not you, cancel it and change your password immediately — money is leaving.',
    ),
  }),
  'withdrawal.completed': Object.freeze({
    id: 'withdrawal.completed',
    category: 'withdrawal',
    params: ['amount', 'asset', 'destination', 'txHash'],
    path: '/wallet/activity',
    text: en(
      'Your withdrawal has been sent',
      '{{amount}} {{asset}} was sent to {{destination}}.\n\nTransaction: {{txHash}}',
    ),
  }),
  'withdrawal.failed': Object.freeze({
    id: 'withdrawal.failed',
    category: 'withdrawal',
    params: ['amount', 'asset', 'reason'],
    path: '/wallet/activity',
    text: en(
      'A transaction could not be completed',
      'A withdrawal of {{amount}} {{asset}} did not go through: {{reason}}.\n\nNothing has left your balance. You can try again, and support can tell you why if the reason is not clear.',
    ),
  }),
  'transfer.posted': Object.freeze({
    id: 'transfer.posted',
    category: 'transfer',
    params: ['amount', 'asset', 'description'],
    path: '/wallet/activity',
    /**
     * The subject carries the amount, and that is not cosmetic.
     *
     * A digest is an index of subjects (`describe` in `pipeline.ts`), so a subject with no
     * parameters produces a batch reading "Your balance changed" three times — which tells the
     * reader nothing and is worse than not sending it. Any template likely to appear in a digest
     * must have a subject that distinguishes one instance from another. A test caught this one.
     */
    text: en('Your balance changed: {{amount}} {{asset}}', '{{amount}} {{asset}} — {{description}}.'),
  }),

  /* ------------------------------------------------------------------ products */

  'trading.bot_event': Object.freeze({
    id: 'trading.bot_event',
    category: 'trading',
    params: ['botName', 'event', 'detail'],
    path: '/trading/bots',
    text: en('Your trading bot {{botName}} {{event}}', '{{botName}} {{event}}.\n\n{{detail}}'),
  }),
  'market.sale': Object.freeze({
    id: 'market.sale',
    category: 'market',
    params: ['itemName', 'amount', 'asset'],
    path: '/market/sales',
    text: en('Your listing sold', '{{itemName}} sold for {{amount}} {{asset}}.'),
  }),
  'market.offer': Object.freeze({
    id: 'market.offer',
    category: 'market',
    params: ['itemName', 'amount', 'asset'],
    path: '/market/offers',
    text: en(
      'You have an offer',
      'Someone offered {{amount}} {{asset}} for {{itemName}}. Offers expire, so have a look when you can.',
    ),
  }),
  'market.auction': Object.freeze({
    id: 'market.auction',
    category: 'market',
    params: ['itemName', 'status', 'amount', 'asset'],
    path: '/market/auctions',
    text: en(
      'Auction update: {{itemName}}',
      'The auction for {{itemName}} is now {{status}}. Current price: {{amount}} {{asset}}.',
    ),
  }),
  'token.deployed': Object.freeze({
    id: 'token.deployed',
    category: 'token',
    params: ['tokenName', 'address', 'chain'],
    path: '/mint/tokens',
    text: en(
      'Your token is live',
      '{{tokenName}} is deployed on {{chain}} at {{address}}.',
    ),
  }),
  'reward.granted': Object.freeze({
    id: 'reward.granted',
    category: 'reward',
    params: ['rewardName', 'titleName'],
    path: '/play/rewards',
    text: en('You earned a reward', 'You earned {{rewardName}} in {{titleName}}.'),
  }),
  'community.proposal': Object.freeze({
    id: 'community.proposal',
    category: 'community',
    params: ['communityName', 'proposalTitle', 'status'],
    path: '/communities/proposals',
    text: en(
      'A proposal in {{communityName}} is {{status}}',
      '"{{proposalTitle}}" in {{communityName}} is {{status}}.',
    ),
  }),
  'governance.vote': Object.freeze({
    id: 'governance.vote',
    category: 'governance',
    params: ['communityName', 'proposalTitle', 'choice', 'weight'],
    path: '/communities/proposals',
    text: en(
      'Your vote was recorded',
      'Your vote of {{choice}} on "{{proposalTitle}}" in {{communityName}} was recorded with a weight of {{weight}}.',
    ),
  }),
  'api.key_event': Object.freeze({
    id: 'api.key_event',
    category: 'api',
    params: ['keyLabel', 'event', 'at'],
    path: '/developers/keys',
    text: en(
      'An API key on your account was {{event}}',
      'The API key {{keyLabel}} was {{event}} at {{at}}.\n\nIf this was not you, revoke it now — an API key acts as you.',
    ),
  }),
  'billing.entitlement_granted': Object.freeze({
    id: 'billing.entitlement_granted',
    category: 'billing',
    params: ['productName'],
    path: '/billing',
    text: en('{{productName}} is ready', 'Your purchase of {{productName}} is active.'),
  }),
  'billing.entitlement_revoked': Object.freeze({
    id: 'billing.entitlement_revoked',
    category: 'billing',
    params: ['productName', 'reason'],
    path: '/billing',
    text: en(
      'Your access to {{productName}} has ended',
      'Access to {{productName}} has ended: {{reason}}.',
    ),
  }),

  /* ------------------------------------------------------------------ aetherholm */

  'ownership.battle_report': Object.freeze({
    id: 'ownership.battle_report',
    category: 'ownership',
    params: ['cityName', 'outcome', 'at'],
    path: '/aetherholm',
    text: en(
      'Your city {{cityName}} came under attack',
      'Your city {{cityName}} came under attack at {{at}}.\n\nOutcome: {{outcome}}.\n\nThe full battle report — losses, loot and the wind of the approach — is waiting in Aetherholm.',
    ),
  }),
  'reward.heraldry': Object.freeze({
    id: 'reward.heraldry',
    category: 'reward',
    params: ['seasonName'],
    path: '/aetherholm',
    text: en(
      'You held an Aether Spire as {{seasonName}} sealed',
      '{{seasonName}} has sealed into the chronicle with your banner on an Aether Spire.\n\nHeraldry is yours: it will appear on your Worlds profile, visible in every title.',
    ),
  }),

  /* ------------------------------------------------------------------ platform */

  'system.incident': Object.freeze({
    id: 'system.incident',
    category: 'system',
    params: ['title', 'status', 'affected'],
    path: '/status',
    text: en(
      'Service update: {{title}}',
      '{{title}} — {{status}}.\n\nAffected: {{affected}}.',
    ),
  }),
  'system.broadcast': Object.freeze({
    id: 'system.broadcast',
    category: 'system',
    params: ['title', 'message'],
    path: '/status',
    text: en('{{title}}', '{{message}}'),
  }),
  'digest.summary': Object.freeze({
    id: 'digest.summary',
    category: 'system',
    params: ['count', 'period', 'items'],
    path: '/notifications',
    text: en(
      'Your {{period}} summary: {{count}} updates',
      'Here is what happened in the last {{period}}:\n\n{{items}}',
    ),
  }),
} as const satisfies Readonly<Record<string, Template>>)

export type TemplateId = keyof typeof TEMPLATES

export const TEMPLATE_IDS: readonly TemplateId[] = Object.freeze(
  Object.keys(TEMPLATES) as TemplateId[],
)

export function isTemplateId(value: string): value is TemplateId {
  return Object.hasOwn(TEMPLATES, value)
}

export function templateFor(id: TemplateId): Template {
  return TEMPLATES[id]
}

export interface Rendered {
  readonly subject: string
  readonly body: string
  /** Absolute, built from `NOTIFY_PUBLIC_URL`. Safe to put in an email. */
  readonly link: string
  /** Parameters the template asked for and did not get. Empty in a correct build. */
  readonly missing: readonly string[]
}

/** `{{name}}` — no expressions, no filters, no conditionals. A template language is a footgun. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/**
 * Substitute, in a single pass.
 *
 * Single-pass matters: a parameter whose *value* contains `{{something}}` is never rescanned, so
 * a hostile display name cannot reach another parameter's value. That is the whole of the
 * injection story for a plain-text renderer.
 */
function substitute(text: string, params: Record<string, unknown>, missing: Set<string>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name]
    if (value === undefined || value === null) {
      missing.add(name)
      return ''
    }
    return String(value)
  })
}

/**
 * Render a template for a locale.
 *
 * An unknown locale falls back to `en-GB` rather than failing — see `resolveLocale`. Withholding
 * a notification because the platform does not speak the user's language would breach §10.3 for
 * anything critical.
 */
export function renderTemplate(
  template: Template,
  params: Record<string, unknown>,
  locale: Locale,
  baseUrl: string,
): Rendered {
  const text = template.text[locale] ?? template.text[DEFAULT_LOCALE]
  const missing = new Set<string>()
  const subject = substitute(text.subject, params, missing)
  const body = substitute(text.body, params, missing)
  const path = substitute(template.path, params, missing)
  // `new URL` rather than string concatenation: it normalises a trailing slash on the base and a
  // leading one on the path, which is the join two services in this estate already get wrong.
  const link = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
  return { subject, body, link, missing: [...missing] }
}
