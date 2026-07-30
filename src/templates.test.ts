/**
 * Templates: substitution, the missing-parameter behaviour, and the link.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TEMPLATES, TEMPLATE_IDS, renderTemplate, templateFor } from './templates.ts'
import { DEFAULT_LOCALE, LOCALES, resolveLocale } from './model.ts'

const BASE = 'https://app.cloudsforge.test'

test('every template has text for every declared locale', () => {
  for (const id of TEMPLATE_IDS) {
    const template = templateFor(id)
    for (const locale of LOCALES) {
      const text = template.text[locale]
      assert.ok(text, `${id} has no ${locale} text`)
      assert.ok(text.subject.length > 0, `${id} has an empty subject`)
      assert.ok(text.body.length > 0, `${id} has an empty body`)
    }
  }
})

test('every placeholder in a template is a declared parameter', () => {
  // Otherwise a template can reference something no rule supplies, and the catalogue test that
  // checks rules against `params` would pass while the notification still rendered a blank.
  const placeholder = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  for (const id of TEMPLATE_IDS) {
    const template = templateFor(id)
    const text = `${template.text[DEFAULT_LOCALE].subject} ${template.text[DEFAULT_LOCALE].body} ${template.path}`
    for (const match of text.matchAll(placeholder)) {
      const name = match[1] ?? ''
      assert.ok(template.params.includes(name), `${id} uses {{${name}}} but does not declare it`)
    }
  }
})

test('a rendered notification substitutes its parameters and builds an absolute link', () => {
  const rendered = renderTemplate(
    TEMPLATES['security.key_exported'],
    { walletLabel: 'Main wallet', at: '2026-07-30 04:12 UTC' },
    'en-GB',
    BASE,
  )
  assert.match(rendered.body, /Main wallet/)
  assert.match(rendered.body, /2026-07-30 04:12 UTC/)
  assert.equal(rendered.link, `${BASE}/settings/security/exports`)
  assert.deepEqual(rendered.missing, [])
})

test('a missing parameter blanks the placeholder and is reported, rather than throwing', () => {
  // A notification with a gap in it is recoverable. A critical notification that threw on the way
  // out of the door is a breach of 04-domain-model §10.3.
  const rendered = renderTemplate(TEMPLATES['security.key_exported'], {}, 'en-GB', BASE)
  assert.deepEqual([...rendered.missing].sort(), ['at', 'walletLabel'])
  assert.doesNotMatch(rendered.body, /\{\{/)
})

test('substitution is single pass, so a parameter value cannot inject another placeholder', () => {
  const rendered = renderTemplate(
    TEMPLATES['security.key_exported'],
    { walletLabel: '{{at}}', at: 'SECRET' },
    'en-GB',
    BASE,
  )
  // The literal `{{at}}` from the value survives; it is not resolved to `SECRET`.
  assert.match(rendered.body, /\{\{at\}\}/)
  assert.equal(rendered.body.includes('SECRET'), true, 'the real {{at}} still resolved')
  assert.equal(rendered.body.match(/SECRET/g)?.length, 1, 'and only once')
})

test('a base URL with a trailing slash joins correctly', () => {
  const withSlash = renderTemplate(TEMPLATES['digest.summary'], {}, 'en-GB', `${BASE}/`)
  const without = renderTemplate(TEMPLATES['digest.summary'], {}, 'en-GB', BASE)
  assert.equal(withSlash.link, without.link)
  assert.equal(without.link, `${BASE}/notifications`)
})

test('an unknown locale falls back rather than failing', () => {
  assert.equal(resolveLocale('de-DE'), DEFAULT_LOCALE)
  assert.equal(resolveLocale(null), DEFAULT_LOCALE)
  assert.equal(resolveLocale('en-GB'), 'en-GB')
})

test('the security templates say what to do, not just what happened', () => {
  // Wording is a design decision here, not decoration: a notification that reports a fact the
  // user cannot act on has told them nothing useful at the moment they most need help.
  for (const id of ['security.new_device', 'security.password_changed', 'security.key_exported'] as const) {
    const body = TEMPLATES[id].text['en-GB'].body
    assert.match(body, /If this was not you/, `${id} does not tell the user what to do`)
  }
})
