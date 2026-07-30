/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work, and adding one fails review — the estate
 * runs eight of them today, each guarded only by a module-local boolean, which is a variable that
 * by construction cannot be seen by a second process. That is why two withdrawal workers can sign
 * against one nonce.
 *
 * **The lease key names the contended resource, not the row.** This is the decision most likely
 * to be got wrong by someone extending this file, and it is where the correctness lives. Ask:
 * what would break if two of these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work                | Key              | Why                                                |
 *   |---------------------|------------------|----------------------------------------------------|
 *   | notify.dispatch     | `queue`          | The contended resource is the pending-delivery      |
 *   |                     |                  | queue as a whole. Keying on a delivery id would     |
 *   |                     |                  | create one job row per delivery — a second queue    |
 *   |                     |                  | shadowing the first, with its own retry policy,     |
 *   |                     |                  | which is exactly the duplication AD-08 forbids.     |
 *   | notify.digest       | `windows`        | The set of open digest batches. Two flushers would  |
 *   |                     |                  | each build a summary from the same entries and the  |
 *   |                     |                  | user would get the batch twice.                     |
 *   | notify.broadcast    | `broadcast:<id>` | One broadcast's fan-out. Two broadcasts must run    |
 *   |                     |                  | concurrently; one broadcast must not run twice, and |
 *   |                     |                  | the dedupe key makes the second run a no-op anyway. |
 *
 * Note what `notify.dispatch` is **not**: it is not one job per delivery. Deliveries carry their
 * own lease, attempts and backoff in the `deliveries` table, because that table is also the
 * delivery history and the dead-letter view. Putting the retry state in `jobs` instead would mean
 * a dead delivery is a row in `jobs` that an operator has to join back to a notification, and
 * `GET /admin/deliveries` would be a union of two tables.
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger } from '@cloudsforge/telemetry'
import { dispatchDue, fanOutBroadcast, flushDueDigests, type PipelineDeps } from './pipeline.ts'

export const DISPATCH_KIND = 'notify.dispatch'
export const DIGEST_KIND = 'notify.digest'
export const BROADCAST_KIND = 'notify.broadcast'

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer is the boot seed
 * below plus the reschedule on completion — so the interval survives a restart, is visible in a
 * table an operator can query, and is claimed by exactly one replica.
 *
 * One second for dispatch, thirty for digests. A digest window is an hour at its shortest, so
 * polling it every second would be a query a hundred and twenty times per window that finds
 * nothing.
 */
export const RECURRING: ReadonlyArray<{ kind: string; key: string; everyMs: number }> = [
  { kind: DISPATCH_KIND, key: 'queue', everyMs: 1_000 },
  { kind: DIGEST_KIND, key: 'windows', everyMs: 30_000 },
]

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling
 * a job that has failed its full attempt budget hides a permanent fault behind a busy loop.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
  const byKind = new Map(RECURRING.map((r) => [r.kind, r]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind ? byKind.get(event.kind) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) =>
        logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }),
      )
  }
}

export interface JobDeps {
  readonly pipeline: PipelineDeps
  readonly batchSize: number
  /**
   * Pull the dispatcher forward. Optional so a test can register handlers without a queue.
   *
   * Enqueued with `onConflict: 'earliest'` by the composition root, which is what makes calling
   * it freely safe: it moves the existing recurring row's `run_at` back rather than creating a
   * second dispatcher.
   */
  readonly enqueueDispatch?: () => Promise<void>
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  runner.register(DISPATCH_KIND, async (_job, ctx) => {
    // Drain the backlog within one lease rather than one batch per tick: after an outage there
    // may be thousands of pending deliveries, and one batch per second would take an hour to
    // clear them. The heartbeat is what makes that safe — without it a long drain outlives the
    // lease and a second replica starts claiming the same rows.
    for (;;) {
      if (ctx.signal.aborted) return
      const summary = await dispatchDue(deps.pipeline, deps.batchSize)
      if (summary.claimed === 0) return
      deps.pipeline.logger.debug('dispatch pass', { ...summary })
      await ctx.heartbeat()
    }
  })

  runner.register(DIGEST_KIND, async (_job, ctx) => {
    const summary = await flushDueDigests(deps.pipeline, deps.batchSize)
    if (summary.flushed > 0) {
      deps.pipeline.logger.info('digests flushed', { ...summary })
      // The summaries just written are pending deliveries. Pulling the dispatcher forward means a
      // digest fires on its window rather than up to a second later, which matters only because
      // "the batch fires on its schedule" is a thing this service promises.
      if (!ctx.signal.aborted) await deps.enqueueDispatch?.()
    }
  })

  runner.register<{ broadcastId?: string }>(BROADCAST_KIND, async (job) => {
    const broadcastId = job.payload.broadcastId
    if (typeof broadcastId !== 'string') {
      // A payload that cannot be acted on is a permanent fault. Throwing burns the attempt budget
      // and dead-letters it, which is correct — retrying will not make the payload valid.
      throw new Error(`${BROADCAST_KIND} requires a string broadcastId`)
    }
    const summary = await fanOutBroadcast(deps.pipeline, broadcastId)
    deps.pipeline.logger.info('broadcast fanned out', { broadcastId, ...summary })
  })

  return runner
}
