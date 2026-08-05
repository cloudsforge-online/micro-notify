/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the service template: the parts that matter — request ids, RED
 * metrics, the child logger, the error shape, the auth-fault mapping — are framework-independent,
 * and a template that imports a framework decides for twenty-two services that have not been
 * written yet.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because the identity service is having a bad minute.
 *
 * ## `/ingest` is authenticated twice, deliberately
 *
 * A service token **and** an HMAC over the raw body. Neither alone is enough:
 *
 *   - The token proves a caller is entitled to submit events, but a token leaks — it is in an
 *     environment variable in twenty deployments — and a leaked token would let its holder mint a
 *     "your key was exported" notice, or worse, an `identity.user.deleted` that erases somebody.
 *   - The signature proves the body was produced by something holding the ingest secret, and
 *     carries a timestamp inside the signed message so a captured request expires.
 *
 * The signature is verified over the **raw bytes**, before parsing. Verifying a re-serialised
 * object would compare a MAC over bytes nobody sent.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { isKnownTopic } from './catalogue.ts'
import { SIGNATURE_HEADER, readInboundEvent, verifyDelivery } from './events.ts'
import { INGESTED_TOTAL } from './metrics.ts'
import {
  CATEGORIES,
  DELIVERY_STATES,
  isCategory,
  isChannel,
  isDigest,
  isPriority,
  type Channel,
  type DeliveryState,
} from './model.ts'
import { ingestEvent, type PipelineDeps } from './pipeline.ts'
import type { Preference } from './routing.ts'
import type { NotifyStore } from './store.ts'
import { isTemplateId, templateFor } from './templates.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly store: NotifyStore
  readonly pipeline: PipelineDeps
  /** Candidates for the `/ingest` signature. A list so a rotation does not need a flag day. */
  readonly ingestSecrets: readonly string[]
  /** Enqueue a broadcast fan-out. Injected so a route never reaches the job queue directly. */
  readonly enqueueBroadcast: (broadcastId: string) => Promise<void>
  readonly enqueueDispatch: () => Promise<void>
  /**
   * Refresh sampled gauges immediately before `/metrics` renders.
   *
   * Queue depth is a value that must be read, not counted, and reading it on a timer would be the
   * one `setInterval` in this repository — the shape rule 8 exists to keep out. A scrape is
   * already periodic, so the scrape is when to sample.
   */
  readonly beforeScrape?: () => Promise<void>
  /** Test seam for the signature's freshness window. */
  readonly now?: () => number
}

/**
 * The scope a service token must carry to read on a user's behalf.
 *
 * There is deliberately no INGEST_SCOPE any more. The §3.3p repair made /ingest MAC-only — a
 * relay is a background job with no bearer and no way to mint one — so `notify:ingest` was a
 * scope no gate demanded and no token could ever usefully hold. A dead scope constant is worse
 * than none: it reads as a capability, and registering it would have made identity able to mint
 * a credential that opens nothing.
 */
export const READ_SCOPE = 'notify:read'

/**
 * An inbound request id is trusted only if it is safe to put in a log line and echo in a header.
 * Anything else is replaced rather than rejected — an unvalidated value here is a
 * header-injection and a log-forgery primitive at once.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

const MAX_BODY_BYTES = 256 * 1024
const MAX_PAGE = 100
const DEFAULT_PAGE = 25

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  /** Set by the router for a route whose path carries an id. */
  readonly param: string | null
}

interface Route {
  readonly method: string
  /** `/notifications/:id/read` — at most one `:id` segment. */
  readonly path: string
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote. This is
    // the workflow Lantern already depends on and it must keep working.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const matched = match(routes, req.method ?? 'GET', url.pathname)
    // Unmatched paths collapse to one label, and a matched one is labelled by its PATTERN rather
    // than by the concrete path. Using the raw path would let any caller mint unbounded time
    // series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.route.path : 'unmatched'

    const log = deps.logger.child({ requestId, method: req.method ?? 'GET', route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method: req.method ?? 'GET',
        route: routeLabel,
        status: String(status),
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method: req.method ?? 'GET',
        route: routeLabel,
      })
    }

    void handle(matched, { req, url, requestId, log, param: matched?.param ?? null }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

interface Matched {
  readonly route: Route
  readonly param: string | null
}

/**
 * Match a path against the route table.
 *
 * One `:id` segment is supported and no more. A general path-parameter router is a dependency and
 * a source of surprises; two shapes of route is what this service actually has.
 */
function match(routes: readonly Route[], method: string, pathname: string): Matched | undefined {
  const parts = pathname.split('/').filter((part) => part.length > 0)
  for (const route of routes) {
    if (route.method !== method) continue
    const pattern = route.path.split('/').filter((part) => part.length > 0)
    if (pattern.length !== parts.length) continue
    let param: string | null = null
    let ok = true
    for (let i = 0; i < pattern.length; i += 1) {
      const expected = pattern[i]
      const actual = parts[i]
      if (expected === ':id') {
        if (!actual) {
          ok = false
          break
        }
        param = decodeURIComponent(actual)
        continue
      }
      if (expected !== actual) {
        ok = false
        break
      }
    }
    if (ok) return { route, param }
  }
  return undefined
}

async function handle(
  matched: Matched | undefined,
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<Reply> {
  if (!matched) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await matched.route.handle(ctx, deps)
  } catch (err) {
    // `statusFor` is the whole point: it is the one place that decides what an auth failure means,
    // so five services cannot disagree about it again.
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof BadRequestError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/livez',
      /**
       * Static, deliberately. Liveness answers one question — should this process be killed and
       * restarted — and a liveness probe that consults a dependency restarts a healthy process
       * every time the database blinks, turning a brief outage into a rolling restart of the
       * whole estate. Readiness is where dependencies belong.
       */
      handle: async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() }),
    },
    {
      method: 'GET',
      path: '/readyz',
      handle: async (_ctx, deps) => {
        const report = await deps.lifecycle.readyz()
        return { status: report.ready ? 200 : 503, body: report }
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      handle: async (ctx, deps) => {
        try {
          await deps.beforeScrape?.()
        } catch (err) {
          // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would
          // lose every other metric too, and blind the dashboard at the moment it is needed.
          ctx.log.warn('gauge refresh failed; serving the previous values', { err })
        }
        return {
          status: 200,
          text: deps.metrics.render(),
          contentType: 'text/plain; version=0.0.4; charset=utf-8',
        }
      },
    },

    /* ------------------------------------------------------------- the user's own */

    {
      method: 'GET',
      path: '/notifications',
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
        const requested = ctx.url.searchParams.get('userId') ?? undefined
        // Three authorities, one line. An operator with the admin role may read anyone; a service
        // reads whoever its call names; a user reads only itself, and `subjectUserId` throws
        // ForbiddenError — mapped to 403 above — if it asks for another.
        const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)

        const done = deps.lifecycle.track()
        try {
          const page = await deps.store.listNotifications(userId, {
            limit: pageSize(ctx),
            cursor: ctx.url.searchParams.get('cursor'),
            unreadOnly: ctx.url.searchParams.get('unread') === 'true',
          })
          return { status: 200, body: page }
        } finally {
          done()
        }
      },
    },
    {
      method: 'POST',
      path: '/notifications/:id/read',
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        const userId = subjectUserId(principal)
        if (!ctx.param) throw new BadRequestError('a notification id is required')
        const done = deps.lifecycle.track()
        try {
          const notification = await deps.store.markRead(userId, ctx.param)
          // 404 rather than 403 for someone else's notification. The scoping is in the WHERE
          // clause, so this route cannot distinguish "does not exist" from "not yours" — and
          // telling a caller which of the two it is confirms that an id exists.
          if (!notification) {
            return errorReply(404, 'not_found', 'no such notification', ctx.requestId)
          }
          return { status: 200, body: { notification } }
        } finally {
          done()
        }
      },
    },
    {
      method: 'GET',
      path: '/preferences',
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        const requested = ctx.url.searchParams.get('userId') ?? undefined
        const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
        const preferences = await deps.store.listPreferences(userId)
        return {
          status: 200,
          body: {
            preferences,
            categories: CATEGORIES,
            /**
             * Stated in the response, not just on the page. A client that renders preferences
             * has to be able to say which categories it cannot switch off, and FEA-41 requires
             * the unsubscribe path to say so too. Deriving it in the client would be a second
             * copy of §10.3 that can disagree with this one.
             */
            alwaysDelivered: {
              priority: 'critical',
              note:
                'Critical security notifications — a new device, a password or two-factor change, ' +
                'a key export, a withdrawal — are always delivered on at least one channel and ' +
                'cannot be switched off.',
            },
          },
        }
      },
    },
    {
      method: 'PUT',
      path: '/preferences',
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        const body = await readJson(ctx.req)
        const userId = subjectUserId(
          principal,
          typeof body['userId'] === 'string' ? (body['userId'] as string) : undefined,
        )
        const preferences = parsePreferences(body['preferences'])
        const done = deps.lifecycle.track()
        try {
          const saved = await deps.store.upsertPreferences(userId, preferences)
          ctx.log.info('preferences updated', { userId, count: preferences.length })
          return { status: 200, body: { preferences: saved } }
        } finally {
          done()
        }
      },
    },

    /* ------------------------------------------------------------- ingest */

    {
      method: 'POST',
      path: '/ingest',
      handle: async (ctx, deps) => {
        // THE SIGNATURE IS THE AUTHENTICATION — the same repair as micro-activity's inbox, for
        // the same structural reason. This handler used to authenticate a bearer and demand
        // `notify:ingest`, and no producer could ever present one: every outbox relay in the
        // estate sends the HMAC signature and NO Authorization header (see identity's
        // `outbox.ts` deliver()) — a relay is a background job with no bearer and no way to mint
        // one. So every event bound for a person's notifications died 401 at this line, always.
        // The MAC over the raw bytes is a shared-secret proof over exactly what was sent, which
        // a bearer is not; a signed-in person still cannot reach this route, because a person
        // does not hold the outbox signing secret. `trade` and `worlds` shaped their inboxes
        // this way from the start.

        // Raw bytes, because the signature is over exactly what was sent.
        const raw = await readRaw(ctx.req)
        const presented = headerOf(ctx.req, SIGNATURE_HEADER)
        if (!presented) throw new BadRequestError(`the ${SIGNATURE_HEADER} header is required`)

        const verification = verifyDelivery(raw, presented, deps.ingestSecrets, {
          ...(deps.now ? { now: deps.now() } : {}),
        })
        if (!verification.ok) {
          // 401, not 400. A bad signature is a failure to authenticate the *body*, and answering
          // 400 would tell a prober that the signature is checked but the payload is not.
          ctx.log.warn('ingest signature rejected', { reason: verification.reason })
          return errorReply(401, 'bad_signature', 'the delivery signature is not valid', ctx.requestId)
        }
        if (verification.keyIndex > 0) {
          // The producer is still using a rotated-out secret. Not an error yet; a countdown.
          ctx.log.warn('ingest signed with a superseded secret', { keyIndex: verification.keyIndex })
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new BadRequestError('request body is not valid JSON')
        }

        const read = readInboundEvent(parsed, isKnownTopic)
        if (!read.ok) {
          deps.metrics.increment(INGESTED_TOTAL, { outcome: read.kind })
          ctx.log.warn('event rejected', { kind: read.kind, errors: read.errors })
          // 202 for an unreadable version, 400 for a malformed body. A producer sending a major
          // version this build cannot read is not making a bad request — the deploy ran in the
          // wrong order — and answering 400 would make it retry for ever.
          return read.kind === 'unreadable_version'
            ? { status: 202, body: { accepted: false, reason: 'unreadable_version', errors: read.errors } }
            : errorReply(400, 'bad_event', read.errors.join('; '), ctx.requestId)
        }
        if (read.registryLag) {
          ctx.log.warn('event on a topic missing from this build of contracts-events', {
            topic: read.event.topic,
          })
        }

        const done = deps.lifecycle.track()
        try {
          const outcome = await ingestEvent(deps.pipeline, read.event)
          deps.metrics.increment(INGESTED_TOTAL, { outcome: outcome.kind })
          // Pull the dispatcher forward so a critical notification is not waiting on a poll.
          if (outcome.kind === 'processed' && outcome.created.length > 0) {
            await deps.enqueueDispatch()
          }
          // Always 202. The event is durably recorded; whether it produced a notification is a
          // domain answer, not an HTTP one, and a producer must not retry because a rule decided
          // an event was not notifiable.
          return { status: 202, body: { accepted: true, outcome } }
        } finally {
          done()
        }
      },
    },

    /* ------------------------------------------------------------- operator */

    {
      method: 'POST',
      path: '/admin/broadcasts',
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        requireAdmin(principal)
        const body = await readJson(ctx.req)

        const templateId = typeof body['templateId'] === 'string' ? body['templateId'] : 'system.broadcast'
        if (!isTemplateId(templateId)) throw new BadRequestError(`unknown template: ${templateId}`)
        if ((templateFor(templateId).secretParams ?? []).length > 0) {
          // A template that carries a single-use credential renders whatever `params` it is handed,
          // and this route takes `params` from the request body untouched. The scheme guard that
          // refuses a `javascript:` link lives in the catalogue rule, on the `/ingest` path where
          // the value comes from a signed producer event — nothing here goes near it. So this would
          // let an operator, or a stolen admin token, mail every reachable user a link of their
          // choosing under a subject line that says CloudsForge minted it: the most convincing
          // phishing message the estate is capable of sending, sent by the estate.
          //
          // Refused by the property rather than by the id, so the next credential-carrying template
          // is covered without anybody remembering this line.
          throw new BadRequestError(
            `${templateId} carries a single-use credential and cannot be broadcast; it is addressed to one person by the event that mints it`,
          )
        }
        const category = typeof body['category'] === 'string' ? body['category'] : 'system'
        if (!isCategory(category)) throw new BadRequestError(`unknown category: ${category}`)
        const priority = typeof body['priority'] === 'string' ? body['priority'] : 'normal'
        if (!isPriority(priority)) throw new BadRequestError(`unknown priority: ${priority}`)
        if (priority === 'critical') {
          // An operator broadcast that ignores every preference is a megaphone. The §10.3
          // exception exists for facts about a user's own account, not for announcements.
          throw new BadRequestError('a broadcast may not be critical; that priority is reserved for account security')
        }
        const params = isRecord(body['params']) ? body['params'] : {}
        const userIds = Array.isArray(body['userIds'])
          ? body['userIds'].filter((id): id is string => typeof id === 'string')
          : []
        const audience = userIds.length > 0 ? 'listed' : 'all'
        const dedupeKey =
          typeof body['dedupeKey'] === 'string' && body['dedupeKey'].length > 0
            ? body['dedupeKey']
            : `broadcast:${ctx.requestId}`

        const done = deps.lifecycle.track()
        try {
          const broadcast = await deps.store.insertBroadcast({
            category,
            priority,
            templateId,
            params,
            audience,
            userIds,
            dedupeKey,
            createdBy: principal.kind === 'user' ? `operator:${principal.userId}` : `service:${principal.service}`,
          })
          // Fanned out by a leased job, not in the request. A broadcast to every user is minutes
          // of work, and a route that does it inline is a route that times out and is retried.
          await deps.enqueueBroadcast(broadcast.id)
          ctx.log.info('broadcast queued', { broadcastId: broadcast.id, audience, priority })
          return { status: 202, body: { broadcast } }
        } finally {
          done()
        }
      },
    },
    {
      method: 'GET',
      path: '/admin/deliveries',
      /**
       * The dead-letter view — one view over every channel, developer webhooks included.
       *
       * Defaults to the terminal states, because "what did we fail to deliver" is the question
       * being asked. `?state=pending` widens it to "what is stuck".
       */
      handle: async (ctx, deps) => {
        const principal = await authenticate(ctx, deps)
        requireAdmin(principal)

        const requestedStates = ctx.url.searchParams.getAll('state')
        const states: DeliveryState[] = requestedStates.length
          ? requestedStates.filter((state): state is DeliveryState =>
              (DELIVERY_STATES as readonly string[]).includes(state),
            )
          : ['dead', 'undeliverable']
        if (states.length === 0) throw new BadRequestError('state must be one of ' + DELIVERY_STATES.join(', '))

        const channelParam = ctx.url.searchParams.get('channel')
        if (channelParam !== null && !isChannel(channelParam)) {
          throw new BadRequestError(`unknown channel: ${channelParam}`)
        }
        const channel: Channel | null = channelParam

        const page = await deps.store.listDeliveries({
          states,
          channel,
          limit: pageSize(ctx),
          cursor: ctx.url.searchParams.get('cursor'),
        })
        return { status: 200, body: page }
      },
    },
  ]
}

/* ------------------------------------------------------------------ helpers */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

function pageSize(ctx: RequestContext): number {
  const raw = ctx.url.searchParams.get('limit')
  if (!raw) return DEFAULT_PAGE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new BadRequestError(`limit must be a whole number between 1 and ${MAX_PAGE}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a preferences payload.
 *
 * Every field is checked against the closed set from `model.ts`, so an unknown channel is a 400
 * rather than a row the database rejects with a constraint violation the caller cannot read. The
 * `critical` exception is not enforced here because there is nothing to enforce: a preference
 * cannot express it. That is the design — §10.3 lives in routing and in two CHECK constraints,
 * not in a validation rule that a future route could forget.
 */
function parsePreferences(value: unknown): Preference[] {
  if (!Array.isArray(value)) throw new BadRequestError('preferences must be an array')
  if (value.length > 500) throw new BadRequestError('too many preferences in one request')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new BadRequestError(`preferences[${index}] must be an object`)
    const category = entry['category']
    if (typeof category !== 'string' || !isCategory(category)) {
      throw new BadRequestError(`preferences[${index}].category is not a known category`)
    }
    const channel = entry['channel']
    if (typeof channel !== 'string' || !isChannel(channel)) {
      throw new BadRequestError(`preferences[${index}].channel is not a known channel`)
    }
    const digest = entry['digest'] ?? 'instant'
    if (typeof digest !== 'string' || !isDigest(digest)) {
      throw new BadRequestError(`preferences[${index}].digest must be instant, hourly, daily or off`)
    }
    const minPriority = entry['minPriority'] ?? 'low'
    if (typeof minPriority !== 'string' || !isPriority(minPriority)) {
      throw new BadRequestError(`preferences[${index}].minPriority is not a known priority`)
    }
    const enabled = entry['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new BadRequestError(`preferences[${index}].enabled must be a boolean`)
    }
    return {
      category,
      channel,
      enabled: enabled ?? true,
      digest,
      minPriority,
    }
  })
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new BadRequestError('request body must be a JSON object')
    return parsed
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line, the trace and
 * the Lantern issue.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health and metrics answers are a point-in-time fact. A cached 200 from a replica that has
    // since gone unready is exactly the lie this arrangement exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
