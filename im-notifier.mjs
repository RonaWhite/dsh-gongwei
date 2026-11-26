import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const TARGET_ID = 'gongwei-reminders'
const TARGET_NAME = '小鱼工位提醒'
const MAX_ATTEMPTS = 100

function failure(code) {
  return Object.assign(new Error(code), { code })
}

// Never persist exception messages: providers may include credentials or bodies.
function errorCode(error) {
  const code = error?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code)
    ? code : 'IM_NOTIFIER_ERROR'
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function validRoute(route) {
  if (typeof route === 'string') return route.trim().length > 0
  if (!route || typeof route !== 'object' || Array.isArray(route)) return false
  try {
    const json = JSON.stringify(route)
    return json !== '{}' && canonical(route) === canonical(JSON.parse(json))
  } catch { return false }
}

function sameRoute(a, b) {
  return validRoute(a) && validRoute(b) && canonical(a) === canonical(b)
}

function list(result, key) {
  const items = Array.isArray(result) ? result : result?.[key]
  if (!Array.isArray(items)) throw failure('IM_INVALID_RESPONSE')
  return items
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw failure(error instanceof SyntaxError ? 'IM_INVALID_JSON' : errorCode(error))
  }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, file)
    // POSIX needs the directory entry flushed as well; Windows cannot open it.
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await handle?.close().catch(() => {})
    await fs.unlink(temporary).catch(() => {})
  }
}

// Exclusive sidecars prevent two notifier instances from racing. A stale lock
// fails closed, rather than risking a second delivery after a process crash.
async function locked(file, callback) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  let handle
  try { handle = await fs.open(`${file}.lock`, 'wx', 0o600) }
  catch (error) { throw failure(error.code === 'EEXIST' ? 'IM_BUSY' : errorCode(error)) }
  try { return await callback() }
  finally {
    await handle.close()
    await fs.unlink(`${file}.lock`)
  }
}

/**
 * Optional IM transport; never reads diaries or sends during setup.
 * getService returns the IM service (or null). Both methods resolve structured
 * results, including failures, so callers can keep desktop-pet delivery intact.
 * Deduplication covers the latest 100 event IDs retained in statusPath.
 */
export function createImNotifier({ getService, getCandidate, configPath, statusPath, now = Date.now, log } = {}) {
  if (typeof configPath !== 'string' || typeof statusPath !== 'string' ||
      path.resolve(configPath) === path.resolve(statusPath)) {
    throw new TypeError('Distinct configPath and statusPath are required')
  }
  let queue = Promise.resolve()
  const serialize = callback => {
    const result = queue.then(callback, callback)
    queue = result.catch(() => {})
    return result
  }
  const report = error => {
    const code = errorCode(error)
    try { if (typeof log === 'function') log({ code }) } catch {}
    return { ok: false, sent: false, code, error: { code } }
  }
  const timestamp = () => {
    const value = now()
    return new Date(value).toISOString()
  }
  const serviceFor = async () => {
    const service = await getService?.()
    if (!service) throw failure('IM_SERVICE_ABSENT')
    return service
  }
  const validateConfig = config => {
    if (!config || typeof config.botId !== 'string' || !config.botId ||
        typeof config.targetId !== 'string' || !config.targetId || !validRoute(config.route)) {
      throw failure('IM_INVALID_CONFIG')
    }
    return { botId: config.botId, targetId: config.targetId, route: config.route }
  }
  const setupWith = service => locked(configPath, async () => {
    const saved = await readJson(configPath)
    if (saved !== null) return validateConfig(saved)
    // Optional explicit opt-in supplied by the integrating caller. Invalid
    // explicit candidates fail closed instead of silently trying discovery.
    let candidate = await getCandidate?.()
    let botId
    if (candidate !== null && candidate !== undefined) {
      if (candidate.kind !== 'user' || typeof candidate.botId !== 'string' ||
          !candidate.botId || !validRoute(candidate.route)) throw failure('IM_INVALID_CANDIDATE')
      botId = candidate.botId
    } else {
      const bots = list(await service.listBots(), 'bots').filter(bot => bot.channel === 'wechat')
      if (bots.length !== 1) throw failure('IM_AMBIGUOUS_BOT')
      botId = bots[0].botId ?? bots[0].id
      if (typeof botId !== 'string' || !botId) throw failure('IM_INVALID_BOT')
      const suggestions = list(await service.listSuggestions(botId), 'suggestions')
        .filter(item => item.kind === 'user')
      if (suggestions.length !== 1 || !validRoute(suggestions[0].route)) {
        throw failure('IM_AMBIGUOUS_USER')
      }
      candidate = suggestions[0]
    }
    // Snapshot only the route; do not retain provider metadata or credentials.
    const route = JSON.parse(JSON.stringify(candidate.route))
    const targets = list(await service.listTargets(botId), 'targets')
    if (targets.some(target => (target.targetId === TARGET_ID || target.id === TARGET_ID ||
        target.name === TARGET_NAME) && (target.kind !== 'user' || !sameRoute(target.route, route)))) {
      throw failure('IM_TARGET_CONFLICT')
    }
    const existing = targets.filter(target => target.kind === 'user' && sameRoute(target.route, route))
    if (existing.length > 1) throw failure('IM_AMBIGUOUS_TARGET')
    let targetId
    if (existing.length === 1) targetId = existing[0].targetId ?? existing[0].id
    else {
      await service.createTarget(botId, { targetId: TARGET_ID, kind: 'user', route, name: TARGET_NAME })
      targetId = TARGET_ID
    }
    const config = validateConfig({ botId, targetId, route })
    await atomicJson(configPath, config)
    return config
  })

  return {
    setup: () => serialize(async () => {
      try {
        const config = await setupWith(await serviceFor())
        return { ok: true, botId: config.botId, targetId: config.targetId }
      } catch (error) { return report(error) }
    }),
    send: (eventId, text) => serialize(async () => {
      try {
        if (typeof eventId !== 'string' || !eventId || eventId.length > 512 || typeof text !== 'string' || !text) {
          throw failure('IM_INVALID_EVENT')
        }
        return await locked(statusPath, async () => {
          const status = await readJson(statusPath) ?? { attempts: [] }
          if (!Array.isArray(status.attempts) || status.attempts.some(attempt =>
              !attempt || typeof attempt.eventId !== 'string')) throw failure('IM_INVALID_STATUS')
          if (status.attempts.some(attempt => attempt.eventId === eventId)) {
            return { ok: false, sent: false, duplicate: true, code: 'IM_ALREADY_ATTEMPTED', error: { code: 'IM_ALREADY_ATTEMPTED' } }
          }
          const attempt = { eventId, at: timestamp(), status: 'attempting' }
          // Commit BEFORE even service discovery. A crash or unknown failure is
          // terminal for this ID; never automatically retry uncertain sends.
          const next = { attempts: [...status.attempts, attempt].slice(-MAX_ATTEMPTS) }
          await atomicJson(statusPath, next)
          try {
            const service = await serviceFor()
            const config = await setupWith(service)
            const targets = list(await service.listTargets(config.botId), 'targets')
            const matches = targets.filter(target => (target.targetId ?? target.id) === config.targetId)
            if (matches.length !== 1 || matches[0].kind !== 'user' || !sameRoute(matches[0].route, config.route)) {
              throw failure('IM_ROUTE_CHANGED')
            }
            const result = await service.send(config.botId, config.targetId, text, { signal: AbortSignal.timeout(20000) })
            if (result?.sent !== true) throw failure('IM_SEND_NOT_CONFIRMED')
            attempt.status = 'sent'
            await atomicJson(statusPath, next)
            return { ok: true, sent: true }
          } catch (error) {
            attempt.status = 'failed'
            attempt.error = { code: errorCode(error) }
            await atomicJson(statusPath, next)
            return report(error)
          }
        })
      } catch (error) { return report(error) }
    }),
  }
}
