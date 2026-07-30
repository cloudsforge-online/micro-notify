/**
 * Reading an inbound event, and the one coupling this service has to the shared package's prose.
 *
 * The first test is the important one. `readInboundEvent` accepts a well-formed envelope on an
 * unregistered topic by recognising the registry's own error string, because AD-08 requires
 * notify to map events whose producing services are not written yet. That string is reproduced in
 * `events.ts`, and this pins it: if the package rewords the message, this test fails loudly, and
 * until it is fixed notify rejects unregistered topics — the fail-closed direction.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeEvent, validateEnvelope } from '@cloudsforge/contracts-events'
import { readInboundEvent, registryLagError } from './events.ts'
import { isKnownTopic } from './catalogue.ts'
import { ALICE, registeredEvent, unregisteredEvent } from './testsupport.ts'

const known = isKnownTopic

test('the registry-lag error string this service keys on is still the one the package emits', () => {
  const envelope = unregisteredEvent('identity.password.changed', ALICE, { user_id: ALICE })
  const verdict = validateEnvelope(envelope)
  assert.equal(verdict.ok, false)
  if (verdict.ok) return
  assert.deepEqual(verdict.errors, [registryLagError('identity.password.changed')])
})

test('a registered topic is accepted without a lag flag', () => {
  const event = registeredEvent('custody.key.exported', ALICE, { user_id: ALICE, key_id: 'k1' })
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.registryLag, false)
  assert.equal(read.event.topic, 'custody.key.exported')
})

test('an unregistered topic this service maps is accepted, and flagged', () => {
  const event = unregisteredEvent('identity.password.changed', ALICE, { user_id: ALICE })
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.equal(read.registryLag, true)
})

test('an unregistered topic this service does not map is rejected', () => {
  // Acceptance is not "it parsed"; it is "notify knows what to do with it". Otherwise the ingest
  // endpoint would happily record anything anyone posted.
  const event = unregisteredEvent('someservice.something.happened', ALICE, {})
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, false)
})

test('an unregistered topic with anything ELSE wrong is rejected', () => {
  const event = {
    ...unregisteredEvent('identity.password.changed', ALICE, { user_id: ALICE }),
    actor: 'user:',
  }
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, false)
  if (read.ok) return
  assert.equal(read.kind, 'malformed')
})

test('a producer publishing under another service namespace is rejected', () => {
  // The registry enforces this for registered topics; there is no spec for an unregistered one,
  // so the check is done by hand rather than skipped. A service under another's prefix is either
  // a copy-paste or an impersonation.
  const event = unregisteredEvent('identity.password.changed', ALICE, { user_id: ALICE }, {
    producer: 'market',
  })
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, false)
  if (read.ok) return
  assert.match(read.errors.join(' '), /does not own topic/)
})

test('a hyphenated producer name matches its underscored topic segment', () => {
  // `admin-api` is a legal ProducerService and an illegal topic segment: the registry's own
  // grammar forbids hyphens. Normalising is what lets a service incident have a topic at all.
  const event = unregisteredEvent('admin_api.incident.opened', 'incident-1', { title: 'Degraded' }, {
    producer: 'admin-api',
  })
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, true)
})

test('a major version this build cannot read is unreadable_version, not malformed', () => {
  const event = { ...registeredEvent('custody.key.exported', ALICE, { user_id: ALICE }), version: '2.0' }
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, false)
  if (read.ok) return
  // The distinction matters operationally: one tells an operator to redeploy, the other to page
  // the producer's owner.
  assert.equal(read.kind, 'unreadable_version')
})

test('a newer minor of the same major is accepted', () => {
  // AD-02's additive-only rule. A consumer that rejected a newer minor would halt its inbox the
  // moment any producer shipped an added field.
  const event = { ...registeredEvent('custody.key.exported', ALICE, { user_id: ALICE }), version: '1.7' }
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, true)
})

test('a malformed envelope is rejected with every problem, not just the first', () => {
  const read = readInboundEvent({ topic: 'not a topic' }, known)
  assert.equal(read.ok, false)
  if (read.ok) return
  assert.ok(read.errors.length > 1)
})

test('a non-object payload becomes an empty one rather than a crash downstream', () => {
  const event = { ...makeEvent({ topic: 'custody.key.exported', key: ALICE, actor: 'system', payload: 'oops' }) }
  const read = readInboundEvent(event, known)
  assert.equal(read.ok, true)
  if (!read.ok) return
  assert.deepEqual(read.event.payload, {})
})
