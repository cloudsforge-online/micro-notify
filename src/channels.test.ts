/**
 * The channel adapters.
 *
 * Nothing here opens a socket. The email adapter is constructed with no transport and with a
 * recording one; the webhook adapter is given a receiver that is a function; the gateway adapter
 * is given a `post` that answers from a variable. That is the constraint — never send a real
 * email, push or SMS in a test — made structural rather than remembered.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELIVERY_TOLERANCE_MS, SIGNATURE_HEADER, verifyDelivery } from '@cloudsforge/contracts-events'
import { gatewayAdapter, inAppAdapter, recordingAdapter, registryOf, type OutboundMessage } from './channels.ts'
import { emailAdapter, smtpConfigured } from './email.ts'
import { DELIVERY_ID_HEADER, webhookAdapter } from './webhook.ts'
import type { SmtpConfig } from './env.ts'
import { ALICE } from './testsupport.ts'

const UNCONFIGURED: SmtpConfig = {
  host: null,
  port: 587,
  secure: false,
  user: null,
  pass: null,
  from: null,
  replyTo: null,
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    deliveryId: '33333333-3333-4333-8333-333333333333',
    notificationId: '44444444-4444-4444-8444-444444444444',
    userId: ALICE,
    channel: 'email',
    category: 'security',
    priority: 'critical',
    templateId: 'security.key_exported',
    address: 'alice@example.test',
    secret: null,
    subject: 'A private key left the platform',
    body: 'The private key for a wallet was exported.',
    link: 'https://app.cloudsforge.test/settings/security/exports',
    params: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/* ------------------------------------------------------------------ in-app */

test('in-app always succeeds — it is the floor the critical guarantee stands on', async () => {
  const outcome = await inAppAdapter().send(message({ channel: 'in_app', address: null }))
  assert.deepEqual(outcome, { ok: true, providerRef: message().notificationId })
})

/* ------------------------------------------------------------------ email */

test('an unconfigured SMTP transport is undeliverable_no_transport, not an error', async () => {
  const adapter = emailAdapter({ smtp: UNCONFIGURED })
  const outcome = await adapter.send(message())

  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'no_transport')
  // Not retryable, because no number of retries conjures a mail server. This is what lands the
  // delivery in `undeliverable` rather than burning six attempts and dead-lettering.
  assert.equal(outcome.retryable, false)
  assert.match(outcome.detail, /SMTP_HOST/)
})

test('SMTP with a host but no From address is still no transport', () => {
  // The connection would be accepted and the message rejected at the provider, which is a much
  // harder failure to diagnose than the honest answer here.
  assert.equal(smtpConfigured({ ...UNCONFIGURED, host: 'smtp.example.test' }), false)
  assert.equal(smtpConfigured({ ...UNCONFIGURED, host: 'smtp.example.test', from: 'a@b.test' }), true)
})

test('email with no address on file is no_address, and is not retried', async () => {
  const sent: unknown[] = []
  const adapter = emailAdapter({
    smtp: UNCONFIGURED,
    transport: async () => ({
      async sendMail(m) {
        sent.push(m)
        return { messageId: 'never' }
      },
    }),
  })
  const outcome = await adapter.send(message({ address: null }))
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'no_address')
  assert.equal(outcome.retryable, false)
  assert.equal(sent.length, 0, 'nothing was handed to a transport')
})

test('a configured transport is handed a plain-text message and the link', async () => {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const adapter = emailAdapter({
    smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'CloudsForge <no-reply@example.test>' },
    transport: async () => ({
      async sendMail(m) {
        sent.push({ to: m.to, subject: m.subject, text: m.text })
        return { messageId: '<abc@example.test>' }
      },
    }),
  })
  const outcome = await adapter.send(message())
  assert.deepEqual(outcome, { ok: true, providerRef: '<abc@example.test>' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.to, 'alice@example.test')
  assert.match(sent[0]?.text ?? '', /app\.cloudsforge\.test/)
  // No HTML anywhere. Every template parameter is domain data from an event this service did not
  // write, and an HTML body would make each one an injection surface.
  assert.doesNotMatch(sent[0]?.text ?? '', /<[a-z]/i)
})

test('a 4xx SMTP reply retries and a 5xx does not', async () => {
  const build = (responseCode: number) =>
    emailAdapter({
      smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'a@b.test' },
      transport: async () => ({
        async sendMail() {
          throw Object.assign(new Error('refused'), { responseCode })
        },
      }),
    })

  const transient = await build(451).send(message())
  assert.equal(transient.ok, false)
  if (!transient.ok) assert.equal(transient.retryable, true)

  const permanent = await build(550).send(message())
  assert.equal(permanent.ok, false)
  if (!permanent.ok) assert.equal(permanent.retryable, false)
})

test('a rate limit dressed as a 5xx auth failure is RETRYABLE (#201)', async () => {
  const build = (responseCode: number, text: string) =>
    emailAdapter({
      smtp: { ...UNCONFIGURED, host: 'smtp.example.test', from: 'a@b.test' },
      transport: async () => ({
        async sendMail() {
          throw Object.assign(new Error(text), { responseCode })
        },
      }),
    })

  // The exact reply this estate's provider sends when the daily allowance is gone: a 5xx AUTH
  // code, carrying the enhanced code for "credentials invalid", for a condition that is temporary
  // and that names its own retry-after. On the digit alone it reads permanent, which sent 707
  // messages to `undeliverable` on 2026-08-05 — including the verification links new users need
  // to sign in at all.
  const quota = await build(
    535,
    '535 5.7.8 Your account has reached its daily sending limit. Please upgrade your plan or retry in 19m21s.',
  ).send(message())
  assert.equal(quota.ok, false)
  if (!quota.ok) {
    assert.equal(quota.retryable, true, 'a quota rejection must be retried, not discarded')
    // Reported as an upstream problem rather than a rejection, so the dashboards do not read it
    // as "the address does not exist".
    assert.equal(quota.reason, 'upstream_error')
  }

  // AND THE CONTROL, or the carve-out would just be "retry every 5xx": a genuine credential
  // failure carries none of those phrases and must still fail fast rather than burn six attempts.
  const badCreds = await build(535, '535 5.7.8 Authentication credentials invalid').send(message())
  assert.equal(badCreds.ok, false)
  if (!badCreds.ok) {
    assert.equal(badCreds.retryable, false)
    assert.equal(badCreds.reason, 'rejected')
  }
})

/* ------------------------------------------------------------------ gateways */

test('a push or SMS channel with no gateway is no_transport, exactly like email', async () => {
  for (const channel of ['web_push', 'mobile_push', 'sms'] as const) {
    const outcome = await gatewayAdapter({ channel, url: null, token: null }).send(
      message({ channel, address: 'somewhere' }),
    )
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'no_transport', channel)
    assert.equal(outcome.retryable, false, channel)
  }
})

test('a gateway 5xx retries, a 4xx does not, and the idempotency key is the delivery id', async () => {
  const seen: Array<Record<string, unknown>> = []
  const build = (status: number) =>
    gatewayAdapter({
      channel: 'sms',
      url: 'https://sms.example.test/send',
      token: 'gateway-token',
      post: async (_url, init) => {
        seen.push(JSON.parse(init.body) as Record<string, unknown>)
        return { status, body: '' }
      },
    })

  const ok = await build(200).send(message({ channel: 'sms', address: '+441234567890' }))
  assert.equal(ok.ok, true)
  assert.equal(seen[0]?.['idempotencyKey'], message().deliveryId)

  const transient = await build(503).send(message({ channel: 'sms', address: '+441234567890' }))
  assert.equal(transient.ok, false)
  if (!transient.ok) assert.equal(transient.retryable, true)

  const permanent = await build(422).send(message({ channel: 'sms', address: '+441234567890' }))
  assert.equal(permanent.ok, false)
  if (!permanent.ok) assert.equal(permanent.retryable, false)
})

/* ------------------------------------------------------------------ webhooks */

test('a webhook delivery carries a signature the receiver can verify', async () => {
  const secret = 'a-developer-webhook-secret-value'
  let verified: ReturnType<typeof verifyDelivery> | null = null
  let receivedBody = ''

  const adapter = webhookAdapter({
    // The "receiver" — a third-party application. It verifies with the shared package's own
    // `verifyDelivery` rather than recomputing an HMAC, because a test that reimplements the
    // signature proves the test can sign, not that a subscriber can verify.
    post: async (_url, request) => {
      receivedBody = request.body
      const presented = request.headers[SIGNATURE_HEADER]
      verified = verifyDelivery(request.body, presented ?? '', secret)
      return { status: 200 }
    },
  })

  const outcome = await adapter.send(
    message({ channel: 'webhook', address: 'https://developer.example.test/hooks/cf', secret }),
  )

  assert.equal(outcome.ok, true)
  assert.deepEqual(verified, { ok: true, keyIndex: 0 })
  // Signed over exactly the bytes sent — the receiver parses the same string it verified.
  const payload = JSON.parse(receivedBody) as Record<string, unknown>
  assert.equal(payload['id'], message().deliveryId)
  assert.equal(payload['userId'], ALICE)
  assert.equal(payload['category'], 'security')
})

test('a tampered webhook body fails verification', async () => {
  const secret = 'a-developer-webhook-secret-value'
  let verified: ReturnType<typeof verifyDelivery> | null = null

  await webhookAdapter({
    post: async (_url, request) => {
      // One byte changed in transit.
      const tampered = request.body.replace('"category":"security"', '"category":"market"')
      verified = verifyDelivery(tampered, request.headers[SIGNATURE_HEADER] ?? '', secret)
      return { status: 200 }
    },
  }).send(message({ channel: 'webhook', address: 'https://developer.example.test/h', secret }))

  assert.deepEqual(verified, { ok: false, reason: 'mismatch' })
})

test('a stale webhook signature is refused by the receiver', async () => {
  const secret = 'a-developer-webhook-secret-value'
  let verified: ReturnType<typeof verifyDelivery> | null = null
  const signedAt = Date.now() - DELIVERY_TOLERANCE_MS - 60_000

  await webhookAdapter({
    now: () => signedAt,
    post: async (_url, request) => {
      verified = verifyDelivery(request.body, request.headers[SIGNATURE_HEADER] ?? '', secret)
      return { status: 200 }
    },
  }).send(message({ channel: 'webhook', address: 'https://developer.example.test/h', secret }))

  // The timestamp is inside the signed message, so a captured request cannot be replayed by
  // moving it — it can only be replayed inside the window, which is what the window is for.
  assert.deepEqual(verified, { ok: false, reason: 'stale' })
})

test('a webhook endpoint with no secret is refused rather than sent unsigned', async () => {
  let called = false
  const outcome = await webhookAdapter({
    post: async () => {
      called = true
      return { status: 200 }
    },
  }).send(message({ channel: 'webhook', address: 'https://developer.example.test/h', secret: null }))

  assert.equal(called, false, 'an unsigned delivery must never leave')
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.reason, 'invalid_payload')
  assert.equal(outcome.retryable, false)
})

test('a plaintext webhook endpoint is refused, and loopback is allowed for the sandbox', async () => {
  const secret = 'a-developer-webhook-secret-value'
  const adapter = webhookAdapter({ post: async () => ({ status: 200 }) })

  const plaintext = await adapter.send(
    message({ channel: 'webhook', address: 'http://developer.example.test/h', secret }),
  )
  assert.equal(plaintext.ok, false)
  if (!plaintext.ok) assert.equal(plaintext.reason, 'invalid_payload')

  const loopback = await adapter.send(
    message({ channel: 'webhook', address: 'http://127.0.0.1:9999/h', secret }),
  )
  assert.equal(loopback.ok, true)
})

test('410 Gone stops retrying; 429 and 5xx keep retrying', async () => {
  const secret = 'a-developer-webhook-secret-value'
  const build = (status: number) => webhookAdapter({ post: async () => ({ status }) })
  const send = (status: number) =>
    build(status).send(message({ channel: 'webhook', address: 'https://d.example.test/h', secret }))

  const gone = await send(410)
  assert.equal(gone.ok, false)
  if (!gone.ok) assert.equal(gone.retryable, false)

  for (const status of [429, 500, 502]) {
    const outcome = await send(status)
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.retryable, true, String(status))
  }
})

test('the delivery id header is stable, so a receiver can dedupe a retry', async () => {
  const secret = 'a-developer-webhook-secret-value'
  const headers: Array<Record<string, string>> = []
  const adapter = webhookAdapter({
    post: async (_url, request) => {
      headers.push(request.headers)
      return { status: 200 }
    },
  })
  const outbound = message({ channel: 'webhook', address: 'https://d.example.test/h', secret })
  await adapter.send(outbound)
  await adapter.send(outbound)
  assert.equal(headers[0]?.[DELIVERY_ID_HEADER], outbound.deliveryId)
  assert.equal(headers[1]?.[DELIVERY_ID_HEADER], outbound.deliveryId)
})

/* ------------------------------------------------------------------ registry and fake */

test('two adapters for one channel is refused at construction', () => {
  assert.throws(() => registryOf([inAppAdapter(), inAppAdapter()]), /two adapters/)
})

test('the recording adapter records rather than sends, and can be made to fail', async () => {
  const adapter = recordingAdapter('email')
  adapter.failNext(2, { ok: false, reason: 'upstream_error', retryable: true, detail: 'boom' })

  assert.equal((await adapter.send(message())).ok, false)
  assert.equal((await adapter.send(message())).ok, false)
  assert.equal((await adapter.send(message())).ok, true)
  assert.equal(adapter.sent.length, 1)
  assert.equal(adapter.sent[0]?.message.subject, 'A private key left the platform')
})
