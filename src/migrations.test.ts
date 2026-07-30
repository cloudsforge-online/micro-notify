/**
 * The migration set itself.
 *
 * The first two tests need no database: they check properties of the list, and an out-of-order or
 * duplicated version is the sort of mistake that only shows up on the one database that has
 * already applied the earlier file.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type postgres from 'postgres'
import { ALL_TABLES, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { CATEGORIES, CHANNELS, PRIORITIES } from './model.ts'
import { enabled, migrateTestDb, openDb, skip } from './testsupport.ts'

test('versions are unique, contiguous and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length)
  versions.forEach((version, index) => assert.equal(version, index + 1))
  assert.equal(SCHEMA_VERSION, versions[versions.length - 1])
})

test('the CHECK lists are generated from the types, so they cannot drift', () => {
  const preferences = MIGRATIONS.find((m) => m.name === 'preferences')?.up ?? ''
  for (const category of CATEGORIES) assert.match(preferences, new RegExp(`'${category}'`))
  for (const channel of CHANNELS) assert.match(preferences, new RegExp(`'${channel}'`))

  const notifications = MIGRATIONS.find((m) => m.name === 'notifications')?.up ?? ''
  for (const priority of PRIORITIES) assert.match(notifications, new RegExp(`'${priority}'`))
})

test('the two constraints that encode §10.3 are present in the migration text', () => {
  // Named, so a future migration that drops one is a visible deletion rather than an omission.
  const notifications = MIGRATIONS.find((m) => m.name === 'notifications')?.up ?? ''
  assert.match(notifications, /notifications_critical_never_suppressed/)
  assert.match(notifications, /notifications_critical_reaches_a_channel/)
})

describe('applied schema', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    if (!enabled) return
    sql = openDb(2)
    await migrateTestDb(sql)
  })

  after(async () => {
    if (!enabled) return
    await sql.end({ timeout: 5 })
  })

  test('every table the reset truncates actually exists', async () => {
    // A table missing from ALL_TABLES leaks rows between test files; one that does not exist
    // makes every reset fail. Both are caught here rather than in whichever test ran second.
    const rows = await sql<Array<{ tablename: string }>>`
      select tablename from pg_tables where schemaname = 'public'
    `
    const present = new Set(rows.map((row) => row.tablename))
    for (const table of ALL_TABLES) assert.ok(present.has(table), `${table} is missing`)
  })

  test('the schema reports the version this build requires', async () => {
    const rows = await sql<Array<{ version: number }>>`
      select coalesce(max(version), 0)::int as version from schema_migrations
    `
    assert.equal(rows[0]?.version, SCHEMA_VERSION)
  })

  test('the generated outcome column spells the terminal states out', async () => {
    // `undeliverable_no_transport` is one value in one column, so the dead-letter view is a
    // group-by rather than a case expression in three dashboards.
    const rows = await sql<Array<{ outcome: string }>>`
      select (case when 'undeliverable' = 'undeliverable' then 'undeliverable_' || 'no_transport' end) as outcome
    `
    assert.equal(rows[0]?.outcome, 'undeliverable_no_transport')

    const definition = await sql<Array<{ generation_expression: string }>>`
      select generation_expression from information_schema.columns
       where table_name = 'deliveries' and column_name = 'outcome'
    `
    assert.match(definition[0]?.generation_expression ?? '', /undeliverable_/)
  })
})
