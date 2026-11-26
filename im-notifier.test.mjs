import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createImNotifier } from './im-notifier.mjs'

const route = { toUserId: 'fake-user-one' }
const other = { toUserId: 'fake-user-two' }
const target = (extra = {}) => ({ targetId: 'gongwei-reminders', name: '小鱼工位提醒', kind: 'user', route, ...extra })

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gongwei-notifier-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const calls = { send: [], create: [], suggestions: 0 }
  let targets = []
  const service = {
    listBots: async () => [{ botId: 'fake-bot', channel: 'wechat' }, { botId: 'ignored', channel: 'telegram' }],
    listSuggestions: async () => {
      calls.suggestions++
      return { suggestions: [{ kind: 'group', route: other }, { kind: 'user', route }] }
    },
    listTargets: async () => targets,
    createTarget: async (botId, value) => { calls.create.push({ botId, value }); targets.push(value) },
    send: async (...args) => { calls.send.push(args); return { sent: true } },
    ...overrides,
  }
  const options = {
    configPath: path.join(dir, 'config.json'), statusPath: path.join(dir, 'status.json'),
    getService: () => service, now: () => new Date('2026-11-23T08:00:00Z'),
  }
  return {
    service, calls, options,
    create: (extra = {}) => createImNotifier({ ...options, ...extra }),
    setTargets: value => { targets = value },
    readConfig: async () => JSON.parse(await fs.readFile(options.configPath, 'utf8')),
    readStatus: async () => JSON.parse(await fs.readFile(options.statusPath, 'utf8')),
  }
}

test('unique wechat bot/user creates target, saves minimal lock and setup never sends', async t => {
  const f = await fixture(t)
  const result = await f.create().setup()
  assert.equal(result.ok, true)
  assert.deepEqual(await f.readConfig(), { botId: 'fake-bot', targetId: 'gongwei-reminders', route })
  assert.deepEqual(f.calls.create, [{ botId: 'fake-bot', value: target() }])
  assert.equal(f.calls.send.length, 0)
})

test('ambiguous or missing bot/user candidates fail closed', async t => {
  for (const [name, overrides, expected] of [
    ['two users', { listSuggestions: async () => ({ suggestions: [{ kind: 'user', route }, { kind: 'user', route: other }] }) }, 'IM_AMBIGUOUS_USER'],
    ['no user', { listSuggestions: async () => ({ suggestions: [{ kind: 'group', route }] }) }, 'IM_AMBIGUOUS_USER'],
    ['two bots', { listBots: async () => [{ botId: 'one', channel: 'wechat' }, { botId: 'two', channel: 'wechat' }] }, 'IM_AMBIGUOUS_BOT'],
    ['no bot', { listBots: async () => [] }, 'IM_AMBIGUOUS_BOT'],
  ]) await t.test(name, async t => {
    const f = await fixture(t, overrides)
    assert.equal((await f.create().setup()).code, expected)
    assert.equal(f.calls.create.length, 0)
    assert.equal(f.calls.send.length, 0)
    await assert.rejects(fs.stat(f.options.configPath), { code: 'ENOENT' })
  })
})

test('explicit user candidate bypasses bot and suggestion discovery, then saved route remains locked', async t => {
  const f = await fixture(t, {
    listBots: async () => { throw new Error('must not discover bots') },
    listSuggestions: undefined,
  })
  const getCandidate = () => ({ botId: 'explicit-bot', kind: 'user', route })
  assert.equal((await f.create({ getCandidate }).setup()).ok, true)
  assert.deepEqual(await f.readConfig(), { botId: 'explicit-bot', targetId: 'gongwei-reminders', route })
  assert.equal(f.calls.send.length, 0)
  const changed = () => ({ botId: 'different-bot', kind: 'user', route: other })
  assert.equal((await f.create({ getCandidate: changed }).send('explicit-send', 'text')).sent, true)
  assert.deepEqual(await f.readConfig(), { botId: 'explicit-bot', targetId: 'gongwei-reminders', route })
})

test('invalid explicit candidate fails closed without fallback', async t => {
  for (const candidate of [{ botId: 'bot', kind: 'group', route }, { kind: 'user', route }, { botId: 'bot', kind: 'user', route: {} }]) {
    const f = await fixture(t)
    assert.equal((await f.create({ getCandidate: () => candidate }).setup()).code, 'IM_INVALID_CANDIDATE')
    assert.equal(f.calls.create.length, 0)
    assert.equal(f.calls.suggestions, 0)
  }
})

test('send requires explicit sent true acknowledgement and never retries unconfirmed results', async t => {
  for (const response of [{ sent: false }, undefined, false, { ok: true }]) {
    const f = await fixture(t)
    f.service.send = async () => { f.calls.send.push('attempt'); return response }
    assert.equal((await f.create().send('unconfirmed', 'text')).code, 'IM_SEND_NOT_CONFIRMED')
    assert.equal((await f.readStatus()).attempts[0].status, 'failed')
    assert.equal((await f.readStatus()).attempts[0].error.code, 'IM_SEND_NOT_CONFIRMED')
    assert.equal((await f.create().send('unconfirmed', 'text')).duplicate, true)
    assert.equal(f.calls.send.length, 1)
  }
})

test('reuse same kind/route target even when its targetId is different', async t => {
  const f = await fixture(t)
  f.setTargets([target({ targetId: 'previous-target', name: 'Existing reminder' })])
  assert.equal((await f.create().setup()).targetId, 'previous-target')
  assert.equal(f.calls.create.length, 0)
})

test('same reserved name or ID with different route is rejected', async t => {
  for (const entry of [target({ route: other }), target({ targetId: 'another-id', route: other })]) {
    const f = await fixture(t)
    f.setTargets([entry])
    assert.equal((await f.create().setup()).code, 'IM_TARGET_CONFLICT')
    assert.equal(f.calls.create.length, 0)
  }
})

test('route change, kind change, missing or duplicate locked target prevents send', async t => {
  for (const entries of [[target({ route: other })], [target({ kind: 'group' })], [], [target(), target()]]) {
    const f = await fixture(t)
    const notifier = f.create()
    assert.equal((await notifier.setup()).ok, true)
    f.setTargets(entries)
    assert.equal((await notifier.send('route-check', 'caller text')).code, 'IM_ROUTE_CHANGED')
    assert.equal(f.calls.send.length, 0)
    assert.equal((await f.readStatus()).attempts[0].error.code, 'IM_ROUTE_CHANGED')
  }
})

test('durable claim precedes send; reload deduplicates and body never enters state', async t => {
  const f = await fixture(t)
  const secret = 'fake-private-body-do-not-store'
  f.service.send = async (botId, targetId, text, options) => {
    const attempt = (await f.readStatus()).attempts[0]
    assert.equal(attempt.status, 'attempting')
    assert.equal(attempt.eventId, 'event-one')
    assert.equal(botId, 'fake-bot')
    assert.equal(targetId, 'gongwei-reminders')
    assert.equal(text, secret)
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.signal.aborted, false)
    f.calls.send.push(text)
    return { sent: true }
  }
  assert.equal((await f.create().send('event-one', secret)).sent, true)
  const replay = await f.create().send('event-one', secret)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.sent, false)
  assert.equal(f.calls.send.length, 1)
  assert.equal((await f.readStatus()).attempts[0].status, 'sent')
  assert.ok(!JSON.stringify(await f.readStatus()).includes(secret))
  assert.ok(!JSON.stringify(await f.readConfig()).includes(secret))
  assert.equal(f.calls.suggestions, 1)
})

test('unknown send failure has no retry and persists only error.code', async t => {
  const logs = []
  const f = await fixture(t)
  f.service.send = async () => {
    f.calls.send.push('attempt')
    throw Object.assign(new Error('credential=secret body=private'), { code: 'ETIMEDOUT' })
  }
  assert.equal((await f.create({ log: entry => logs.push(entry) }).send('timeout-event', 'private')).code, 'ETIMEDOUT')
  assert.equal((await f.create().send('timeout-event', 'private')).duplicate, true)
  assert.equal(f.calls.send.length, 1)
  assert.deepEqual((await f.readStatus()).attempts[0].error, { code: 'ETIMEDOUT' })
  assert.deepEqual(logs, [{ code: 'ETIMEDOUT' }])
  assert.ok(!JSON.stringify(await f.readStatus()).includes('private'))
})

test('service absent and failed setup are contained; attempts remain terminal', async t => {
  const f = await fixture(t)
  const absent = f.create({ getService: () => null })
  assert.equal((await absent.setup()).code, 'IM_SERVICE_ABSENT')
  assert.equal((await absent.send('no-service', 'caller text')).code, 'IM_SERVICE_ABSENT')
  assert.equal((await f.create().send('no-service', 'caller text')).duplicate, true)
  f.service.listSuggestions = async () => ({ suggestions: [] })
  assert.equal((await f.create().send('bad-setup', 'caller text')).code, 'IM_AMBIGUOUS_USER')
  assert.equal(f.calls.send.length, 0)
  assert.equal((await f.readStatus()).attempts.length, 2)
})

test('concurrent calls in one instance attempt once', async t => {
  const f = await fixture(t)
  const notifier = f.create()
  const results = await Promise.all(Array.from({ length: 8 }, () => notifier.send('same-event', 'text')))
  assert.equal(results.filter(result => result.sent).length, 1)
  assert.equal(f.calls.send.length, 1)
})

test('cross-instance lock fails closed rather than racing send', async t => {
  const f = await fixture(t)
  let release
  let entered
  const start = new Promise(resolve => { entered = resolve })
  f.service.send = async () => {
    f.calls.send.push('attempt')
    entered()
    await new Promise(resolve => { release = resolve })
    return { sent: true }
  }
  const first = f.create().send('cross-instance', 'text')
  await start
  try { assert.equal((await f.create().send('cross-instance', 'text')).code, 'IM_BUSY') }
  finally { release() }
  assert.equal((await first).sent, true)
  assert.equal(f.calls.send.length, 1)
})

test('retains at most 100 attempts; pre-send failure also bounded', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.options.statusPath, JSON.stringify({ attempts: Array.from({ length: 100 }, (_, i) => ({ eventId: `old-${i}`, status: 'sent' })) }))
  const result = await f.create({ getService: () => null }).send('newest', 'text')
  assert.equal(result.sent, false)
  const attempts = (await f.readStatus()).attempts
  assert.equal(attempts.length, 100)
  assert.equal(attempts[0].eventId, 'old-1')
  assert.equal(attempts.at(-1).eventId, 'newest')
})

test('corrupted config/status fail closed and never overwrite invalid input', async t => {
  for (const key of ['configPath', 'statusPath']) {
    const f = await fixture(t)
    await fs.writeFile(f.options[key], 'not-json')
    assert.equal((await f.create().send('corrupt', 'text')).code, 'IM_INVALID_JSON')
    assert.equal(await fs.readFile(f.options[key], 'utf8'), 'not-json')
    assert.equal(f.calls.send.length, 0)
  }
})

test('status persistence failure prevents any service.send', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.options.configPath, 'filesystem-obstruction')
  const result = await f.create({ statusPath: path.join(f.options.configPath, 'impossible', 'status.json') })
    .send('cannot-save', 'text')
  assert.equal(result.sent, false)
  assert.equal(f.calls.send.length, 0)
})
