/**
 * The email adapter: generic SMTP, and nothing else.
 *
 * The estate's convention, stated in its own `.env.example` and reproduced exactly: *"There is no
 * provider code and no SDK: this is plain SMTP, so Brevo, Resend, SendGrid, Mailtrap, a Gmail app
 * password and your own postfix are all the same four settings. Changing provider is an edit here
 * and a restart."* Four settings — host, port, user, pass — plus the From address the provider
 * has authorised.
 *
 * ## Unconfigured is a supported mode
 *
 * `SMTP_HOST` unset does not fail, does not throw, and does not lose the notification. It returns
 * `no_transport`, the delivery is recorded as `undeliverable_no_transport`, and the row is
 * retained. That is how the estate already runs — a password-reset request with no SMTP is
 * recorded and an operator issues the link by hand — and it is the behaviour that lets this
 * service be deployed before anybody has bought a mail provider.
 *
 * It is emphatically **not** the same as losing the notification. The notification row exists, it
 * is readable in-app, it appears in `GET /admin/deliveries`, and `notify_failed_total{channel=
 * "email",reason="no_transport"}` counts it. An operator can see exactly how much mail this
 * deployment is not sending.
 *
 * ## Why nodemailer is imported lazily
 *
 * A deployment with no SMTP must not need the module at all. The dynamic import happens on the
 * first send with a configured transport, so an unconfigured service never loads it — and a
 * broken install of it cannot stop this service from booting and delivering in-app.
 */

import type { SmtpConfig } from './env.ts'
import { failure, type ChannelAdapter, type OutboundMessage, type SendOutcome } from './channels.ts'

/** The slice of nodemailer this adapter uses. Narrow, so the lazy import stays typed. */
interface Transport {
  sendMail(message: {
    from: string
    to: string
    subject: string
    text: string
    replyTo?: string
    headers?: Record<string, string>
  }): Promise<{ messageId?: string }>
}

export interface EmailOptions {
  readonly smtp: SmtpConfig
  /**
   * Test seam. Every test in this repository passes one; none has ever opened a socket to a mail
   * server, and the unconfigured-transport test passes no transport at all — which is the point.
   */
  readonly transport?: () => Promise<Transport>
}

/**
 * Is there a way to send mail at all?
 *
 * Both halves are required. A host with no From address gets the connection accepted and the
 * message rejected, which is a delivery that fails at the provider rather than here — much harder
 * to diagnose than the honest `no_transport` this returns.
 */
export function smtpConfigured(smtp: SmtpConfig): boolean {
  return smtp.host !== null && smtp.from !== null
}

export function emailAdapter(options: EmailOptions): ChannelAdapter {
  const { smtp } = options
  // Built once and reused: a transport per message opens a TCP connection per message, which is
  // how a provider's rate limiter starts refusing an otherwise healthy deployment.
  let transport: Promise<Transport> | null = null

  const open = (): Promise<Transport> => {
    if (transport) return transport
    transport = options.transport ? options.transport() : openSmtp(smtp)
    return transport
  }

  return {
    channel: 'email',
    async send(message: OutboundMessage): Promise<SendOutcome> {
      if (!smtpConfigured(smtp) && !options.transport) {
        return failure('no_transport', false, 'SMTP_HOST or SMTP_FROM is not set; no mail is sent')
      }
      if (!message.address) {
        return failure('no_address', false, 'no email address on file for this user')
      }

      try {
        const sender = await open()
        const result = await sender.sendMail({
          from: smtp.from ?? 'CloudsForge <no-reply@invalid>',
          to: message.address,
          subject: message.subject,
          // Plain text only. An HTML body is an injection surface for every template parameter,
          // and every parameter here is domain data from an event this service did not write.
          text: `${message.body}\n\n${message.link}\n`,
          ...(smtp.replyTo ? { replyTo: smtp.replyTo } : {}),
          headers: {
            // Lets a receiving server collapse a retried delivery instead of showing it twice.
            'X-Entity-Ref-ID': message.deliveryId,
            'X-CloudsForge-Category': message.category,
          },
        })
        return { ok: true, ...(result.messageId ? { providerRef: result.messageId } : {}) }
      } catch (err) {
        // A transport failure is discarded so the next attempt reconnects. Holding a dead pooled
        // connection is how one network blip turns into every subsequent send failing.
        transport = null
        return classify(err)
      }
    },
  }
}

/**
 * SMTP failures split cleanly on the first digit of the reply code.
 *
 * 4xx is a transient negative reply — greylisting, a full mailbox, a rate limit — and is exactly
 * what retries exist for. 5xx is permanent: the address does not exist, or the provider will not
 * send as that From. Retrying a 5xx six times annoys the provider and delivers nothing.
 *
 * The message is truncated and never includes the configuration, because a nodemailer error can
 * carry the connection options — and those hold `SMTP_PASS`.
 */
function classify(err: unknown): SendOutcome {
  const code = (err as { responseCode?: number } | null)?.responseCode
  const message = err instanceof Error ? err.message : String(err)
  const safe = message.slice(0, 300)
  // THE QUOTA TEST COMES FIRST, AND IT HAS TO (#201).
  //
  // The digit rule below is right in general and wrong for the one reply this estate's provider
  // actually sends most often. Mailtrap answers an exhausted daily allowance with
  //
  //     535 5.7.8 Your account has reached its daily sending limit ... retry in 19m21s
  //
  // — a 5xx AUTH code, with the enhanced code for "credentials invalid", for a condition that is
  // temporary and that states its own retry-after in the text. Classified on the digit it is
  // permanent, so the delivery goes to `undeliverable` and is never attempted again.
  //
  // That silently discarded 707 messages across the two estates on 2026-08-05, including
  // identity's email-verification links: a user who registered inside the window never got one,
  // could not verify, and therefore could not sign in. The plan's limit is DAILY, so this is not
  // an edge case — it recurs every time volume crosses it.
  //
  // Matched on the message rather than the code, because the code is the part that lies. A
  // genuine 5.7.8 credential failure carries none of these phrases and still fails fast.
  if (/sending limit|rate limit|too many|quota|try again later|retry in/i.test(message)) {
    return failure('upstream_error', true, `SMTP ${code ?? 'rate-limited'}`)
  }
  if (typeof code === 'number') {
    if (code >= 500) return failure('rejected', false, `SMTP ${code}`)
    if (code >= 400) return failure('upstream_error', true, `SMTP ${code}`)
  }
  const name = (err as { code?: string } | null)?.code
  if (name === 'ETIMEDOUT' || name === 'ESOCKET' || name === 'ECONNECTION') {
    return failure('timeout', true, `SMTP ${name}`)
  }
  return failure('upstream_error', true, safe)
}

/**
 * Open a real transport. Called only when SMTP is configured, and never from a test.
 *
 * 465 is implicit TLS and needs `secure: true`; 587 is STARTTLS and needs `secure: false`. The
 * two are not interchangeable, and 465 with `secure` unset hangs until the connect timeout —
 * which the estate's `.env.example` already warns about, having been bitten by it.
 */
async function openSmtp(smtp: SmtpConfig): Promise<Transport> {
  const nodemailer = await import('nodemailer')
  const transport = nodemailer.createTransport({
    host: smtp.host ?? '',
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user && smtp.pass ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
  })
  return transport as unknown as Transport
}
