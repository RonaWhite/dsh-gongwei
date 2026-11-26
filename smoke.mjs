// 冒烟测试：用假 ctx 把插件跑起来，验证打卡判定、记录、周报、配置、工具/命令/记忆注册。
// 用两次独立加载覆盖两条口径：没有历史（只有基准线）与有历史（基准线 + 个人平均）。
// 用法：node smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let pass = 0
let fail = 0
const check = (label, cond, extra) => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`)
  }
}

// 所有被测插件实例与 fixture 共用同一个测试时钟，不能依赖运行当天是周几。
// 固定从周五中午开始：B 的前 3 个工作日均在本周，E 的本周连击为 4 天。
// 时钟仍随真实耗时前进，保留 createdAt / updatedAt 的先后关系；不 mock 定时器。
const RealDate = globalThis.Date
const realStartedAt = RealDate.now()
const testStartedAt = new RealDate(2026, 10, 20, 12, 0).getTime()
globalThis.Date = class SmokeDate extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? [testStartedAt + RealDate.now() - realStartedAt] : args))
  }

  static now() {
    return testStartedAt + RealDate.now() - realStartedAt
  }
}

const pad2 = (n) => String(n).padStart(2, '0')
const keyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const now = new Date()
const todayKey = keyOf(now)

/**
 * 造一个假的 petApi7340，只实现 memory 那一槽。
 * 行为照抄 dsh-pet：单槽、只留最后注册的、register 返回注销函数。
 */
function makePetApi() {
  const state = { def: null, disposeCalls: 0 }
  return {
    memory: {
      register(def) {
        state.def = def
        let live = true
        return () => {
          if (!live) return
          live = false
          state.disposeCalls += 1
          if (state.def === def) state.def = null
        }
      },
      list() {
        return { native: 'native', external: state.def === null ? [] : [state.def.id] }
      },
    },
    state,
  }
}

/** 造一个假 webServer，只实现 register/getOrigin。 */
function makeWebServer() {
  const routes = []
  return {
    routes,
    getOrigin: () => 'http://127.0.0.1:9999',
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** 直接调插件的路由 handler，模拟宿主的 req/res。 */
function callRoute(route, { method = 'GET', path = route.path, body, host = '127.0.0.1:9999' } = {}) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = {
      method,
      url: path,
      headers: { host },
      on(event, fn) {
        ;(listeners[event] ??= []).push(fn)
        return req
      },
      destroy() {},
    }
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value
      },
      end(chunk) {
        this.body += chunk ?? ''
        let parsed = null
        try {
          parsed = JSON.parse(this.body)
        } catch {
          parsed = null
        }
        resolve({ status: this.statusCode, headers: this.headers, body: this.body, json: parsed })
      },
    }
    const run = async () => {
      const result = Promise.resolve(route.handler(req, res))
      if (body !== undefined) {
        const text = JSON.stringify(body)
        for (const fn of listeners.data ?? []) fn(Buffer.from(text))
      }
      for (const fn of listeners.end ?? []) fn()
      await result
    }
    void run()
  })
}

/** 造一个假 ctx，收集注册项。petApi 传了就模拟「桌宠在场」，不传就是没有桌宠。 */
function makeCtx(logs, petApi = null, webServer = null, connection = null, extra = {}) {
  const registered = { tools: [], commands: [], sections: [] }
  const disposers = []
  /** 还没等到服务就挂起的 inject 回调（模拟真 ctx.inject 的子 fiber 挂起）。 */
  const pending = []
  const ctx = {
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    get(name, optional) {
      // extra 里塞的服务优先：用来模拟 llm / agentDefaultModel 这类可选能力
      if (Object.prototype.hasOwnProperty.call(extra, name)) {
        const value = extra[name]
        if (value === null) {
          if (optional) return undefined
          throw new Error(`unknown service ${name}`)
        }
        return value
      }
      if (name === 'tools')
        return { register: (def) => (registered.tools.push(def), () => {}) }
      if (name === 'commands')
        return { register: (def) => (registered.commands.push(def), () => {}) }
      if (name === 'systemPrompt')
        return { section: (sec) => (registered.sections.push(sec), () => {}) }
      if (name === 'petApi7340') {
        if (petApi !== null) return petApi
        if (optional) return undefined
        // 真 ctx 是严格 getter：没这个服务且非 optional 时会抛，这里照做
        throw new Error('unknown service petApi7340')
      }
      if (name === 'webServer') return webServer === null ? undefined : webServer
      if (name === 'connection') return connection === null ? undefined : connection
      if (optional) return undefined
      throw new Error(`unknown service ${name}`)
    },
    effect(fn, label) {
      const dispose = fn()
      disposers.push([label, dispose])
      return dispose
    },
    /**
     * 真 ctx.inject 会起一个子 fiber：依赖齐了才执行回调，缺依赖就静静挂着，
     * 服务后到还会自动激活。这里照这个语义模拟——服务齐了立刻跑，缺服务先记账，
     * 等 provide() 把服务补上再跑。
     */
    inject(names, callback) {
      const ready = () =>
        names.every((name) => {
          try {
            return ctx.get(name, true) !== undefined
          } catch {
            return false
          }
        })
      if (ready()) return callback(ctx)
      pending.push({ names, callback })
      return undefined
    },
    /** 模拟「服务晚一步才挂上」：补进 extra 之后把等待中的 inject 唤醒。 */
    provide(name, value) {
      extra[name] = value
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const item = pending[i]
        const ok = item.names.every((n) => {
          try {
            return ctx.get(n, true) !== undefined
          } catch {
            return false
          }
        })
        if (!ok) continue
        pending.splice(i, 1)
        item.callback(ctx)
      }
    },
  }
  return { ctx, registered, disposers }
}

/**
 * 造一个假 llm：按调用序号依次吐出预设回复，并记下每次请求。
 * summaryReply 传函数时按 (options) 现算，方便测「条数对不上就降级」。
 */
function makeLlm({ reply, delayMs = 0, throwOnCall = false } = {}) {
  const calls = []
  let index = 0
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      if (throwOnCall) throw new Error('provider exploded')
      index += 1
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      const text = typeof reply === 'function' ? reply(options, index) : reply
      if (typeof text === 'string' && text !== '') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const fakeModel = { currentSelection: () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }) }

/** 造一个假 connection：默认放行，可模拟「未登录」或「不可信来源」。 */
function makeConnection({ reject = false, isTrusted = () => true } = {}) {
  return {
    isTrusted,
    requestRejection: () => (reject ? 401 : undefined),
  }
}

const teardown = (disposers) => {
  for (const [label, dispose] of disposers) {
    if (typeof dispose !== 'function') continue
    try {
      dispose()
    } catch (error) {
      console.log(`  ! dispose ${label}: ${error.message}`)
    }
  }
}

/* ── 相位 A：全新环境，没有任何历史 ── */
console.log('\n[A] 全新环境（无历史）')
const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-a-'))
process.env.DSH_HOME = homeA
const logsA = []
const a = makeCtx(logsA)
const pluginA = await import(`./index.js?a=1`)
pluginA.apply(a.ctx)
await new Promise((r) => setTimeout(r, 150))

check('tools.gongwei 注册了', a.registered.tools.some((t) => t.name === 'gongwei'))
check('commands.gongwei 注册了', a.registered.commands.some((c) => c.name === 'gongwei'))
check('memory section 注册了', a.registered.sections.some((s) => s.name === 'gongwei-memory'))

const STATE_A = path.join(homeA, 'dsh-gongwei', 'state.json')
const readA = () => JSON.parse(fs.readFileSync(STATE_A, 'utf8'))
const toolA = a.registered.tools.find((t) => t.name === 'gongwei')
const callA = (args) => toolA.execute(args, {})

const firstA = await callA({ action: 'checkin' })
check('首次打卡有文案', typeof firstA === 'string' && firstA.length > 0, firstA)
check('首次打卡提到基准线', firstA.includes('基准'), firstA)
check('首次打卡不假装有历史', !firstA.includes('比以往') && !/近 \d+ 次平均/.test(firstA), firstA)
check('首次打卡说明基准线刚生效', firstA.includes('第一次生效'), firstA)
check('state.json 落盘了', fs.existsSync(STATE_A))
check('今天的 checkin 有值', /^\d{2}:\d{2}$/.test(readA().days[todayKey].checkin), readA().days[todayKey])

const againA = await callA({ action: 'checkin' })
check('重复打卡说明已打过', againA.includes('已经打过卡'), againA)

const logA = await callA({ action: 'log', text: '今天跑通了记忆检索的 baseline' })
check('记录成功', logA.includes('记下了'), logA)
check('entries 有 1 条', readA().days[todayKey].entries.length === 1)
const emptyA = await callA({ action: 'log', text: '   ' })
check('空内容被拒', emptyA.includes('空的'), emptyA)

const statusA = await callA({ action: 'status' })
check('状态含打卡时间', statusA.includes(readA().days[todayKey].checkin), statusA)
check('状态含记录内容', statusA.includes('记忆检索'), statusA)

const badCfg = await callA({ action: 'config', reminder_time: '晚上九点' })
check('坏时间被拒', badCfg.includes('HH:MM'), badCfg)
const goodCfg = await callA({ action: 'config', reminder_time: '21:15', baseline: '08:50' })
check('好时间被接受', goodCfg.includes('已更新'), goodCfg)
check('配置落盘', readA().config.reminderTime === '21:15' && readA().config.baseline === '08:50')
const badDay = await callA({ action: 'config', weekly_day: 9 })
check('坏周报日被拒', badDay.includes('1（周一）'), badDay)

teardown(a.disposers)
check('A 无 error 日志', logsA.every(([lvl]) => lvl !== 'error'))

/* ── 相位 B：预置 3 个工作日的历史，验证双口径 ── */
console.log('\n[B] 有历史（基准线 + 个人平均）')
const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-b-'))
process.env.DSH_HOME = homeB
const seed = { version: 1, config: {}, days: {}, flags: {}, meta: {} }
let seeded = 0
for (let i = 1; seeded < 3 && i < 20; i += 1) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
  if (d.getDay() === 0 || d.getDay() === 6) continue
  // 第一天故意用老格式（只有 note 字符串），验证升级后不丢字
  seed.days[keyOf(d)] =
    seeded === 0
      ? { checkin: '08:30', checkinTs: d.getTime(), entries: [], note: '旧格式里写的感想' }
      : { checkin: '08:30', checkinTs: d.getTime(), entries: [], note: '' }
  seeded += 1
}
fs.mkdirSync(path.join(homeB, 'dsh-gongwei'), { recursive: true })
fs.writeFileSync(path.join(homeB, 'dsh-gongwei', 'state.json'), JSON.stringify(seed, null, 2))

const logsB = []
const b = makeCtx(logsB)
const pluginB = await import(`./index.js?b=1`)
pluginB.apply(b.ctx)
await new Promise((r) => setTimeout(r, 150))

const STATE_B = path.join(homeB, 'dsh-gongwei', 'state.json')
const readB = () => JSON.parse(fs.readFileSync(STATE_B, 'utf8'))
const toolB = b.registered.tools.find((t) => t.name === 'gongwei')
const callB = (args) => toolB.execute(args, {})

const firstB = await callB({ action: 'checkin' })
check('文案同时给两条口径', firstB.includes('基准') && firstB.includes('平均'), firstB)
check('提到了近 3 次平均', firstB.includes('近 3 次'), firstB)
check('不出现「第一次生效」', !firstB.includes('第一次生效'), firstB)

const memoryText = b.registered.sections.find((s) => s.name === 'gongwei-memory').text()
check('记忆段含今天打卡', memoryText.includes(todayKey), memoryText)
check('记忆段含最近打卡', memoryText.includes('最近几次打卡'), memoryText)
check('记忆段含本周概况', /本周：到 \d+\/\d+ 天/.test(memoryText), memoryText)
check('记忆段含工具提示', memoryText.includes('gongwei 工具'), memoryText)

const weekB = await callB({ action: 'week' })
check('周报有标题', weekB.includes('# 本周工位周报'), weekB.slice(0, 60))
check('周报含每日小节', weekB.includes('## 每日'))
const reportFile = weekB.match(/已写入 (.+?)）/)?.[1]
check('周报文件写出来了', reportFile !== undefined && fs.existsSync(reportFile), reportFile)
if (reportFile) check('周报内容含到达时间', fs.readFileSync(reportFile, 'utf8').includes('08:30'))

const cmd = b.registered.commands.find((c) => c.name === 'gongwei')
const cmdStatus = await cmd.handler({ rawInput: '状态' })
check('命令 状态 成功', cmdStatus.kind === 'success' && cmdStatus.text.length > 0)
const cmdBad = await cmd.handler({ rawInput: '胡闹' })
check('命令 未知动词 报错', cmdBad.kind === 'error', cmdBad)
const cmdLog = await cmd.handler({ rawInput: '记 看完了 LoRA 那篇' })
check('命令 记 成功', cmdLog.kind === 'success' && readB().days[todayKey].entries.some((e) => e.text.includes('LoRA')), cmdLog)
const cmdEmpty = await cmd.handler({ rawInput: '记' })
check('命令 记 缺内容报错', cmdEmpty.kind === 'error', cmdEmpty)

/* ── 感想单独通道 ── */
const cmdThink = await cmd.handler({ rawInput: '感想 今天有点烦，方向还没定下来' })
check('命令 感想 成功', cmdThink.kind === 'success', cmdThink)
check('感想进了 thoughts', readB().days[todayKey].thoughts.some((t) => t.text.includes('有点烦')))
check('感想没混进 entries', !readB().days[todayKey].entries.some((e) => e.text.includes('有点烦')))
const cmdThinkEmpty = await cmd.handler({ rawInput: '感想' })
check('命令 感想 缺内容报错', cmdThinkEmpty.kind === 'error', cmdThinkEmpty)

/* ── 公众号成文版周报 ── */
const cmdArticle = await cmd.handler({ rawInput: '公众号' })
check('命令 公众号 成功', cmdArticle.kind === 'success', cmdArticle)
const articleFile = cmdArticle.text.match(/已写入 (.+?)）/)?.[1]
check('成文版文件写出来了', articleFile !== undefined && fs.existsSync(articleFile), articleFile)
const articleText = articleFile ? fs.readFileSync(articleFile, 'utf8') : ''
check('成文版不是统计表', !articleText.includes('应到 3 天，实到'), articleText.slice(0, 80))
check('成文版含「学到的」小节', articleText.includes('## 学到的'), articleText.slice(0, 200))
check('成文版含「想到的」小节', articleText.includes('## 想到的'), articleText.slice(0, 200))
check('成文版把感想原样织进去了', articleText.includes('有点烦'), articleText)
check('成文版含「下周」收尾', articleText.includes('## 下周'), articleText.slice(-200))
check('成文版行文用第一人称', articleText.includes('我在工位坐了'), articleText.slice(0, 200))

/* ── 老格式回落：只有 note 字符串时不能丢字 ── */
const weekStatText = fs.readFileSync(
  (await callB({ action: 'week' })).match(/已写入 (.+?)）/)[1],
  'utf8',
)
check('老格式 note 被当作感想接过来', weekStatText.includes('旧格式里写的感想'), weekStatText)
check('老格式 note 归到感想栏而不是记录栏', /- 感想：旧格式里写的感想/.test(weekStatText), weekStatText)

/* ── 工具层：think / week style ── */
const toolThink = await callB({ action: 'think', text: '工具通道写的感想' })
check('工具 think 成功', toolThink.includes('感想收下了'), toolThink)
const toolWeekArticle = await callB({ action: 'week', style: 'article' })
check('工具 week style=article 出成文', toolWeekArticle.includes('# 这周在工位的'), toolWeekArticle.slice(0, 60))
const toolWeekStat = await callB({ action: 'week' })
check('工具 week 默认出统计表', toolWeekStat.includes('# 本周工位周报'), toolWeekStat.slice(0, 60))

teardown(b.disposers)
check('B 无 error 日志', logsB.every(([lvl]) => lvl !== 'error'))

/* ── 相位 C：周报补发 ──
   场景：上一个周报时刻已经过去，但当时应用没开着（lastWeeklyReport 停在更早的一周）。
   启动时 tick 必须把那份周报补出来，而不是等下一个周五。 */
console.log('\n[C] 周报错过时刻后补发')
const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-c-'))
process.env.DSH_HOME = homeC
const seedC = {
  version: 1,
  // 周报日设为周六、时刻 00:01：保证「最近一次该交周报的时刻」一定已经过去，不受跑测试的时间影响
  config: { weeklyDay: 6, weeklyTime: '00:01', reminderTime: '23:59' },
  days: {},
  flags: {},
  meta: { createdAt: new Date().toISOString(), lastWeeklyReport: '2000-01-03' },
}
fs.mkdirSync(path.join(homeC, 'dsh-gongwei'), { recursive: true })
fs.writeFileSync(path.join(homeC, 'dsh-gongwei', 'state.json'), JSON.stringify(seedC, null, 2))

const logsC = []
const c = makeCtx(logsC)
const pluginC = await import(`./index.js?c=1`)
pluginC.apply(c.ctx)
await new Promise((r) => setTimeout(r, 400))

const readC = () => JSON.parse(fs.readFileSync(path.join(homeC, 'dsh-gongwei', 'state.json'), 'utf8'))
const doneC = readC().meta.lastWeeklyReport
check('补发后 lastWeeklyReport 前进了', typeof doneC === 'string' && doneC > '2000-01-03', doneC)
const reportFilesC = fs.readdirSync(path.join(homeC, 'dsh-gongwei', 'reports'), { withFileTypes: true }).map((d) => d.name)
check('补发出了周报文件', reportFilesC.some((f) => /^week-\d{4}-\d{2}-\d{2}\.md$/.test(f)), reportFilesC)
check('补发的周报正是被错过的那一周', reportFilesC.includes(`week-${doneC}.md`), { doneC, reportFilesC })
teardown(c.disposers)
check('C 无 error 日志', logsC.every(([lvl]) => lvl !== 'error'))

/* ── 相位 D：刚装上（从未交过周报）不能补发空周报 ── */
console.log('\n[D] 首次运行不补发空周报')
const homeD = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-d-'))
process.env.DSH_HOME = homeD
const seedD = { version: 1, config: { weeklyDay: 6, weeklyTime: '00:01' }, days: {}, flags: {}, meta: {} }
fs.mkdirSync(path.join(homeD, 'dsh-gongwei'), { recursive: true })
fs.writeFileSync(path.join(homeD, 'dsh-gongwei', 'state.json'), JSON.stringify(seedD, null, 2))
const logsD = []
const d = makeCtx(logsD)
const pluginD = await import(`./index.js?d=1`)
pluginD.apply(d.ctx)
await new Promise((r) => setTimeout(r, 400))
const readD = () => JSON.parse(fs.readFileSync(path.join(homeD, 'dsh-gongwei', 'state.json'), 'utf8'))
const reportsD = fs.existsSync(path.join(homeD, 'dsh-gongwei', 'reports'))
check('首次运行没写周报', reportsD === false, reportsD)
check('首次运行只把当前周记为已交', typeof readD().meta.lastWeeklyReport === 'string', readD().meta)
teardown(d.disposers)
check('D 无 error 日志', logsD.every(([lvl]) => lvl !== 'error'))

/* ── 相位 E：连续出勤 ──
   规则：只数有打卡的工作日；周末跳过不打断；今天没打之前不判它断。 */
console.log('\n[E] 连续出勤')
const homeE = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-e-'))
process.env.DSH_HOME = homeE
const seedE = { version: 1, config: {}, days: {}, flags: {}, meta: {} }
/** 往前数 n 个工作日，返回日期数组（不含今天）。 */
const backWorkdays = (n) => {
  const out = []
  for (let i = 1; out.length < n && i < 40; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    if (d.getDay() === 0 || d.getDay() === 6) continue
    out.push(d)
  }
  return out
}
// 最近 3 个工作日连续打卡
const wd6 = backWorkdays(6)
for (const d of wd6.slice(0, 3)) {
  seedE.days[keyOf(d)] = { checkin: '09:30', checkinTs: d.getTime(), entries: [], thoughts: [] }
}
// 空掉第 4 个工作日（wd6[3]），再在 wd6[4] 打一天：验证断点确实把连击切成两段
if (wd6[4]) seedE.days[keyOf(wd6[4])] = { checkin: '10:00', checkinTs: wd6[4].getTime(), entries: [], thoughts: [] }
fs.mkdirSync(path.join(homeE, 'dsh-gongwei'), { recursive: true })
fs.writeFileSync(path.join(homeE, 'dsh-gongwei', 'state.json'), JSON.stringify(seedE, null, 2))

const logsE = []
const e = makeCtx(logsE)
const pluginE = await import(`./index.js?e=1`)
pluginE.apply(e.ctx)
await new Promise((r) => setTimeout(r, 150))
const readE = () => JSON.parse(fs.readFileSync(path.join(homeE, 'dsh-gongwei', 'state.json'), 'utf8'))
const toolE = e.registered.tools.find((t) => t.name === 'gongwei')
const callE = (args) => toolE.execute(args, {})
const sectionE = () => e.registered.sections.find((s) => s.name === 'gongwei-memory').text()

const beforeToday = sectionE()
check('今天没打卡时不算断', /连续：上段连续 3 个工作日/.test(beforeToday), beforeToday)
check('连续行报了最长天数', /最长 \d+ 天/.test(beforeToday), beforeToday)

const checkinE = await callE({ action: 'checkin' })
check('打卡后连续天数包含今天', checkinE.includes('连续第 4 个工作日'), checkinE)
const afterToday = sectionE()
check('记忆段转成当前连续', /连续：当前连续 4 个工作日/.test(afterToday), afterToday)

const againE = await callE({ action: 'checkin' })
check('重复打卡仍报连续天数', againE.includes('连续第 4 个工作日'), againE)

const weekE = await callE({ action: 'week' })
check('统计周报含连续行', /- (当前|上段)连续 \d+ 个工作日/.test(weekE), weekE)
check('统计周报含本周最长连击', weekE.includes('本周最长连击'), weekE)

const statusE = await callE({ action: 'status' })
check('状态里有连续天数', /连续 \d+ 个工作日/.test(statusE), statusE)

const articleE = await callE({ action: 'week', style: 'article' })
check('成文版没把连续天数当空话塞进去', articleE.includes('## 下周'), articleE.slice(-300))

/* 断了以后：清掉最近两天，连续应回落且给出「重新开始」的说法 */
const seedE2 = JSON.parse(JSON.stringify(seedE))
for (const d of backWorkdays(1)) delete seedE2.days[keyOf(d)]
fs.writeFileSync(path.join(homeE, 'dsh-gongwei', 'state.json'), JSON.stringify(seedE2, null, 2))
const homeE2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-e2-'))
fs.mkdirSync(path.join(homeE2, 'dsh-gongwei'), { recursive: true })
fs.writeFileSync(path.join(homeE2, 'dsh-gongwei', 'state.json'), JSON.stringify(seedE2, null, 2))
process.env.DSH_HOME = homeE2
const logsE2 = []
const e2 = makeCtx(logsE2)
const pluginE2 = await import(`./index.js?e2=1`)
pluginE2.apply(e2.ctx)
await new Promise((r) => setTimeout(r, 150))
const sectionE2 = e2.registered.sections.find((s) => s.name === 'gongwei-memory').text()
check('断了以后当前连击归零', /连续：连续记录断了/.test(sectionE2), sectionE2)
check('断了以后仍报出历史最长', /最长 \d+ 天，累计 \d+ 天/.test(sectionE2), sectionE2)
teardown(e2.disposers)
check('E2 无 error 日志', logsE2.every(([lvl]) => lvl !== 'error'))

teardown(e.disposers)
check('E 无 error 日志', logsE.every(([lvl]) => lvl !== 'error'))

/* ── 相位 F：桌宠对话记忆 ──
   桌宠在场的唯一影响面是 petApi7340.memory.recall：它能在对话前改写 system。
   这里验证「挂得上、说得对、卸得掉」，以及没有桌宠时不炸。 */
console.log('\n[F] 桌宠对话记忆')
const homeF = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-f-'))
process.env.DSH_HOME = homeF
const seedF = { version: 1, config: {}, days: {}, flags: {}, meta: {} }
const yF = backWorkdays(1)
if (yF[0]) seedF.days[keyOf(yF[0])] = { checkin: '09:20', checkinTs: yF[0].getTime(), entries: [], thoughts: [] }
fs.mkdirSync(path.join(homeF, 'dsh-gongwei'), { recursive: true })
fs.writeFileSync(path.join(homeF, 'dsh-gongwei', 'state.json'), JSON.stringify(seedF, null, 2))

const logsF = []
const petApi = makePetApi()
const f = makeCtx(logsF, petApi)
const pluginF = await import(`./index.js?f=1`)
pluginF.apply(f.ctx)
await new Promise((r) => setTimeout(r, 150))

check('记忆槽挂上了', petApi.state.def !== null && petApi.state.def.id === 'dsh-gongwei', petApi.state.def?.id)
const toolF = f.registered.tools.find((t) => t.name === 'gongwei')
const callF = (args) => toolF.execute(args, {})
await callF({ action: 'checkin' })
await callF({ action: 'log', text: '看完了 retnet 那篇，cache 那块没看懂' })
await callF({ action: 'think', text: '有点怀疑这个方向值不值得做这么久' })

const recalled = petApi.state.def?.recall({ system: '原人设', history: [], userText: '今天怎么样' })
const recalledSystem = recalled?.system ?? ''
check('召回有返回', typeof recalled?.system === 'string', recalled)
check('召回保留了原人设', recalledSystem.startsWith('原人设'), recalledSystem.slice(0, 40))
check('召回带了工位记录', recalledSystem.includes('【工位记录】'), recalledSystem)
check('召回含今天打卡时间', /今天 \d{2}:\d{2} 到工位/.test(recalledSystem), recalledSystem)
check('召回含今天学到的内容', recalledSystem.includes('retnet'), recalledSystem)
check('召回含今天的感想', recalledSystem.includes('值不值得'), recalledSystem)
check('召回带出了连续出勤', recalledSystem.includes('连续'), recalledSystem)
check('召回只改 system 不碰历史', recalled.system !== undefined && recalled.history === undefined && recalled.userText === undefined, recalled)

teardown(f.disposers)
check('卸载后记忆槽被注销', petApi.state.def === null && petApi.state.disposeCalls === 1, petApi.state)
check('F 无 error 日志', logsF.every(([lvl]) => lvl !== 'error'))

/* 没有桌宠时：插件照常起来，只是不挂记忆 */
const homeG = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-g-'))
process.env.DSH_HOME = homeG
const logsG = []
const g = makeCtx(logsG)
const pluginG = await import(`./index.js?g=1`)
pluginG.apply(g.ctx)
await new Promise((r) => setTimeout(r, 150))
const toolG = g.registered.tools.find((t) => t.name === 'gongwei')
const checkinG = await toolG.execute({ action: 'checkin' }, {})
check('没有桌宠也能打卡', typeof checkinG === 'string' && checkinG.includes('打卡') || /\d{2}:\d{2}/.test(checkinG), checkinG)
teardown(g.disposers)
check('没有桌宠时不报 error', logsG.every(([lvl]) => lvl !== 'error'), logsG)

/* ── 相位 H：想学的池子 ── */
console.log('\n[H] 想学的池子')
const homeH = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-h-'))
process.env.DSH_HOME = homeH
const logsH = []
const h = makeCtx(logsH)
const pluginH = await import(`./index.js?h=1`)
pluginH.apply(h.ctx)
await new Promise((r) => setTimeout(r, 150))

const STATE_H = path.join(homeH, 'dsh-gongwei', 'state.json')
const readH = () => JSON.parse(fs.readFileSync(STATE_H, 'utf8'))
const toolH = h.registered.tools.find((t) => t.name === 'gongwei')
const callH = (args) => toolH.execute(args, {})

const emptyList = await callH({ action: 'plan_list' })
check('空池子有提示', emptyList.includes('空的'), emptyList)

const addEmpty = await callH({ action: 'plan_add', text: '   ' })
check('空内容加不进池子', addEmpty.includes('空的'), addEmpty)

const add1 = await callH({ action: 'plan_add', text: '把 RetNet 的 cache 机制搞明白' })
check('加进池子了', add1.includes('丢进池子'), add1)
check('池子落盘 1 条', readH().plans.length === 1, readH().plans)
const add2 = await callH({ action: 'plan_add', text: '学一下 Chroma 的检索参数' })
const add3 = await callH({ action: 'plan_add', text: '看看 skills 到底怎么写' })
check('池子 3 条', readH().plans.length === 3)
check('加的时候报了待做条数', add3.includes('3 条想学'), add3)

const list1 = await callH({ action: 'plan_list' })
check('列表带序号', list1.includes('1. ') && list1.includes('3. '), list1)
check('列表标未完成', list1.includes('○'), list1)
check('列表写了欠几条', list1.includes('3 条没做'), list1)

// 划掉一条：既改状态，也自动写一条学习记录
// 序号按「未完成在前、新的在前」排，所以第 1 条是最后加进去的那个
const order1 = readH().plans.filter((p) => !p.done).sort((a, b) => b.createdAt - a.createdAt)
check('列表顺序 = 新的在前', list1.indexOf(order1[0].text) < list1.indexOf(order1[1].text), list1)
const done1 = await callH({ action: 'plan_done', ref: '1' })
check('划掉成功', done1.includes('划掉了'), done1)
check('划掉的是序号 1 那条', done1.includes(order1[0].text), done1)
check('划掉写了学习记录', readH().days[todayKey].entries.length === 1, readH().days[todayKey])
check('学习记录是「看完了想学的」', readH().days[todayKey].entries[0].text.startsWith('看完了想学的：'), readH().days[todayKey].entries[0])
check('划掉自动补打卡', readH().days[todayKey].checkin !== null, readH().days[todayKey].checkin)
check('planLogTs 落了盘', typeof readH().plans.find((p) => p.done)?.planLogTs === 'number', readH().plans.find((p) => p.done))

const doneAgain = await callH({ action: 'plan_done', ref: order1[0].text })
check('重复划掉被拒', doneAgain.includes('早就划掉了'), doneAgain)

// 撤销：状态回滚，那条自动写的记录也要收回
const undo1 = await callH({ action: 'plan_undo', ref: order1[0].text })
check('撤销成功', undo1.includes('放回池子'), undo1)
check('撤销把学习记录也收回了', readH().days[todayKey].entries.length === 0, readH().days[todayKey].entries)
check('撤销后池子 3 条未做', readH().plans.filter((p) => !p.done).length === 3)

const undoAgain = await callH({ action: 'plan_undo', ref: order1[0].text })
check('没划掉的说没划掉', undoAgain.includes('本来就没划掉'), undoAgain)

// 重载后 planLogTs 要还在：否则撤销收不回记录
const done2 = await callH({ action: 'plan_done', ref: 'RetNet' })
check('再划一次', done2.includes('划掉了'), done2)
const targetId = readH().plans.find((p) => p.done).id
const pluginH2 = await import(`./index.js?h=2`)
const h2 = makeCtx([])
pluginH2.apply(h2.ctx)
await new Promise((r) => setTimeout(r, 150))
const toolH2 = h2.registered.tools.find((t) => t.name === 'gongwei')
check('重载后 planLogTs 还在', typeof readH().plans.find((p) => p.id === targetId)?.planLogTs === 'number')
const redo = await toolH2.execute({ action: 'plan_undo', ref: targetId }, {})
check('重载后仍能撤销', redo.includes('放回池子'), redo)
check('重载后撤销也收回了记录', readH().days[todayKey].entries.length === 0, readH().days[todayKey].entries)
teardown(h2.disposers)

// 关键词定位与歧义
await callH({ action: 'plan_add', text: '整理一份检索参数的笔记' })
await callH({ action: 'plan_add', text: '整理一份 skills 的笔记' })
const ambiguous = await callH({ action: 'plan_done', ref: '整理一份' })
check('模糊匹配会说对上好几条', ambiguous.includes('好几条'), ambiguous)
const byKeyword = await callH({ action: 'plan_done', ref: 'Chroma' })
check('关键词能定位', byKeyword.includes('Chroma') && byKeyword.includes('划掉了'), byKeyword)

const notFound = await callH({ action: 'plan_done', ref: '量子纠缠' })
check('找不到会说找不到', notFound.includes('没找到'), notFound)

// 备注
const note1 = await callH({ action: 'plan_note', ref: 'RetNet', text: '先看第三章，别贪多' })
check('备注写上了', note1.includes('先看第三章'), note1)
const emptyNote = await callH({ action: 'plan_note', ref: 'RetNet', text: '' })
check('空备注被拒', emptyNote.includes('空的'), emptyNote)
const list2 = await callH({ action: 'plan_list' })
check('备注出现在列表里', list2.includes('先看第三章'), list2)

// 今天视图
const todayView = await callH({ action: 'plan_today' })
check('今天视图有日期', todayView.includes(todayKey), todayView)
check('今天视图报了已划掉', todayView.includes('划掉了'), todayView)
check('今天视图报了待做', todayView.includes('没做'), todayView)
check('今天视图带「几天前加的」', todayView.includes('今天加的'), todayView)

// 系统提示里要能看到欠债，但不能把整池子塞进去
const sectionH = h.registered.sections.find((s) => s.name === 'gongwei-memory')
const memoH = sectionH.text()
check('记忆里有池子', memoH.includes('想学的池子'), memoH)
check('记忆里没把整个池子念一遍', memoH.split('\n').length < 30, memoH)

// 周报要算进去
const weekH = await callH({ action: 'week' })
check('周报有「想学的」小节', weekH.includes('## 想学的'), weekH)
check('周报报了本周划掉条数', weekH.includes('本周划掉'), weekH)
const articleH = await callH({ action: 'week', style: 'article' })
check('成文版不列欠债清单', !articleH.includes('还欠'), articleH)
check('成文版不重复列划掉的', !articleH.includes('想学的，看完了'), articleH)

// 删除
const beforeDrop = readH().plans.length
const drop1 = await callH({ action: 'plan_drop', ref: '到底怎么写' })
check('删掉成功', drop1.includes('删掉了'), drop1)
check('池子少了一条', readH().plans.length === beforeDrop - 1)

teardown(h.disposers)
check('H 无 error 日志', logsH.every(([lvl]) => lvl !== 'error'), logsH)

/* ── 相位 I：设置页面板走的 HTTP 接口 ── */
console.log('\n[I] 设置页面板的 HTTP 接口')
const homeI = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-i-'))
process.env.DSH_HOME = homeI
const logsI = []
const web = makeWebServer()
const i = makeCtx(logsI, null, web, makeConnection())
const pluginI = await import(`./index.js?i=1`)
pluginI.apply(i.ctx)
await new Promise((r) => setTimeout(r, 150))

const route = web.routes.find((r) => r.path === '/dsh-gongwei/api/plans')
check('注册了池子路由', route !== undefined, web.routes.map((r) => r.path))
check('路由是 prefix', route?.kind === 'prefix', route?.kind)

const STATE_I = path.join(homeI, 'dsh-gongwei', 'state.json')
const readI = () => JSON.parse(fs.readFileSync(STATE_I, 'utf8'))

const emptyGet = await callRoute(route)
check('GET 空池子 ok', emptyGet.json?.ok === true, emptyGet.json)
check('GET 空池子 plans 是数组', Array.isArray(emptyGet.json?.plans), emptyGet.json)
check('GET 带统计', emptyGet.json?.stats?.open === 0, emptyGet.json?.stats)

const post1 = await callRoute(route, { method: 'POST', body: { text: '把 Chroma 的 distance 参数搞明白' } })
check('POST 加成功', post1.json?.ok === true, post1.json)
check('POST 后池子 1 条', post1.json?.plans?.length === 1, post1.json?.plans)
check('POST 落了盘', readI().plans.length === 1)

const emptyPost = await callRoute(route, { method: 'POST', body: { text: '  ' } })
check('POST 空正文被拒', emptyPost.json?.ok === false && emptyPost.json.error.includes('空的'), emptyPost.json)

const planId = post1.json.plans[0].id
check('返回的条目有 id', typeof planId === 'string' && planId !== '', planId)
check('返回的条目没有内部字段', post1.json.plans[0].planLogTs === undefined, post1.json.plans[0])

const patchDone = await callRoute(route, {
  method: 'PATCH',
  path: `/dsh-gongwei/api/plans/${encodeURIComponent(planId)}`,
  body: { done: true },
})
check('PATCH 划掉成功', patchDone.json?.ok === true, patchDone.json)
check('PATCH 划掉写了学习记录', readI().days[todayKey].entries.length === 1, readI().days[todayKey])
check('面板划掉也自动补打卡', readI().days[todayKey].checkin !== null)

const patchUndone = await callRoute(route, {
  method: 'PATCH',
  path: `/dsh-gongwei/api/plans/${encodeURIComponent(planId)}`,
  body: { done: false },
})
check('PATCH 取消划掉成功', patchUndone.json?.ok === true, patchUndone.json)
check('cancel 收回了学习记录', readI().days[todayKey].entries.length === 0, readI().days[todayKey].entries)

const patchNote = await callRoute(route, {
  method: 'PATCH',
  path: `/dsh-gongwei/api/plans/${encodeURIComponent(planId)}`,
  body: { note: '先看官方文档那一节' },
})
check('PATCH 备注成功', patchNote.json?.ok === true, patchNote.json)
check('备注落了盘', readI().plans[0].note === '先看官方文档那一节')

const patchText = await callRoute(route, {
  method: 'PATCH',
  path: `/dsh-gongwei/api/plans/${encodeURIComponent(planId)}`,
  body: { text: '把 Chroma 的 distance 和 ef 参数都搞明白' },
})
check('PATCH 改正文成功', patchText.json?.ok === true, patchText.json)
check('正文落了盘', readI().plans[0].text.includes('ef 参数'))

const patchEmpty = await callRoute(route, {
  method: 'PATCH',
  path: `/dsh-gongwei/api/plans/${encodeURIComponent(planId)}`,
  body: { note: '  ', text: '   ' },
})
check('PATCH 全空被拒', patchEmpty.json?.ok === false, patchEmpty.json)

const del = await callRoute(route, {
  method: 'DELETE',
  path: `/dsh-gongwei/api/plans/${encodeURIComponent(planId)}`,
})
check('DELETE 成功', del.json?.ok === true, del.json)
check('DELETE 后池子空了', readI().plans.length === 0)

const delMissing = await callRoute(route, {
  method: 'DELETE',
  path: '/dsh-gongwei/api/plans/p999-nope',
})
check('删不存在的会说找不到', delMissing.json?.ok === false && delMissing.json.error.includes('没找到'), delMissing.json)

// 从桌宠待办搬一次
const petTodoDir = path.join(homeI, 'dsh-pet')
fs.mkdirSync(petTodoDir, { recursive: true })
fs.writeFileSync(
  path.join(petTodoDir, 'todos.json'),
  JSON.stringify({
    version: 1,
    todos: [
      { id: 't1', text: '了解一下飞书', dueAt: null, done: false, createdAt: 1794000000000, updatedAt: 1794000000000, completedAt: null, lastRemindedAt: null },
      { id: 't2', text: 'AI怎么生成喜欢的音色', dueAt: null, done: true, createdAt: 1794000000000, updatedAt: 1794100000000, completedAt: 1794100000000, lastRemindedAt: null },
      { id: 't3', text: '  把 Chroma 的 distance 和 ef 参数都搞明白  ', dueAt: null, done: false, createdAt: 1794000000000, updatedAt: 1794000000000, completedAt: null, lastRemindedAt: null },
    ],
  }),
)
const imported = await callRoute(route, { method: 'POST', path: '/dsh-gongwei/api/plans/import' })
check('导入成功', imported.json?.ok === true, imported.json)
check('导入搬进 3 条（含已完成的那条）', imported.json?.plans?.length === 3, imported.json?.plans)
check('导入保留了已划掉状态', imported.json.plans.some((p) => p.done && p.text.includes('音色')), imported.json.plans)
check('导入带回了 message', typeof imported.json.message === 'string' && imported.json.message.includes('搬了'), imported.json.message)

const importAgain = await callRoute(route, { method: 'POST', path: '/dsh-gongwei/api/plans/import' })
check('重复导入不重复加', importAgain.json?.plans?.length === 3, importAgain.json?.plans)
check('重复导入说没新东西', importAgain.json.message.includes('没有新东西'), importAgain.json.message)

// 回归：真实事故是「搬过来」点两次池子翻倍。桌宠同步给待办补了 [想学] 标记后，
// 待办正文变成 "[想学] 了解一下飞书"，而池子里存的是无前缀的 "了解一下飞书"。
// 旧导入用带前缀原文当去重键，对不上就再导一遍，还把前缀当正文堆进去。
// 这里把待办换成带标记版本再导入，必须一条都不新增、也不产生叠前缀正文。
const prefixedTodos = JSON.parse(fs.readFileSync(path.join(petTodoDir, 'todos.json'), 'utf8'))
prefixedTodos.todos = prefixedTodos.todos.map((t) => ({ ...t, text: `[想学] ${t.text}` }))
fs.writeFileSync(path.join(petTodoDir, 'todos.json'), JSON.stringify(prefixedTodos))
const importPrefixed = await callRoute(route, { method: 'POST', path: '/dsh-gongwei/api/plans/import' })
check('带标记的待办重复导入不新增', importPrefixed.json?.plans?.length === 3, importPrefixed.json?.plans)
check('带标记的待办重复导入说没新东西', importPrefixed.json.message.includes('没有新东西'), importPrefixed.json.message)
check('导入不产生叠前缀正文', importPrefixed.json.plans.every((p) => !p.text.includes('[想学]')), importPrefixed.json.plans)

// 没有桌宠待办文件时要好好报错，不能崩
fs.rmSync(petTodoDir, { recursive: true, force: true })
const importMissing = await callRoute(route, { method: 'POST', path: '/dsh-gongwei/api/plans/import' })
check('没有待办文件时正常报错', importMissing.json?.ok === false && importMissing.json.error.includes('没找到'), importMissing.json)

// 清干净，后面的删除测试不受影响
for (const plan of readI().plans) {
  await callRoute(route, { method: 'DELETE', path: `/dsh-gongwei/api/plans/${encodeURIComponent(plan.id)}` })
}

const badMethod = await callRoute(route, { method: 'PUT', path: '/dsh-gongwei/api/plans' })
check('无 id 的 PUT 被拒', badMethod.status === 405, badMethod)

// 非回环来源 + 不被 connection 信任 → 必须被挡。这是面板接口唯一的攻击面
const foreignCtx = makeCtx([], null, makeWebServer(), makeConnection({ isTrusted: () => false }))
const pluginForeign = await import(`./index.js?i-foreign=1`)
pluginForeign.apply(foreignCtx.ctx)
await new Promise((r) => setTimeout(r, 150))
const foreignWeb = foreignCtx.ctx.get('webServer')
const foreignRoute = foreignWeb.routes[0]
const foreign = await callRoute(foreignRoute, { host: 'evil.example.com' })
check('非回环来源被拒 403', foreign.status === 403, foreign)
// 回环来源即使 connection 不认也放行（本机直开设置页的正常路径）
const loop = await callRoute(foreignRoute, { host: '127.0.0.1:9999' })
check('回环来源放行', loop.status === 200, loop.status)
teardown(foreignCtx.disposers)

// 未登录（requestRejection 给码）必须挡
const unauthCtx = makeCtx([], null, makeWebServer(), makeConnection({ reject: true }))
const pluginUnauth = await import(`./index.js?i-unauth=1`)
pluginUnauth.apply(unauthCtx.ctx)
await new Promise((r) => setTimeout(r, 150))
const unauthRoute = unauthCtx.ctx.get('webServer').routes[0]
const unauth = await callRoute(unauthRoute)
check('未登录被拒 401', unauth.status === 401, unauth.status)
teardown(unauthCtx.disposers)

// 没有 connection 服务时 fail-closed（宁可面板打不开，也不能把数据交出去）
const noConnCtx = makeCtx([], null, makeWebServer(), null)
const pluginNoConn = await import(`./index.js?i-noconn=1`)
pluginNoConn.apply(noConnCtx.ctx)
await new Promise((r) => setTimeout(r, 150))
const noConnRoute = noConnCtx.ctx.get('webServer').routes[0]
const noConn = await callRoute(noConnRoute)
check('栅栏不可用时 fail-closed', noConn.status === 503, noConn.status)
teardown(noConnCtx.disposers)

// 卸载后路由要撤掉
teardown(i.disposers)
check('卸载后路由注销', web.routes.length === 0, web.routes.map((r) => r.path))
check('I 无 error 日志', logsI.every(([lvl]) => lvl !== 'error'), logsI)

/* ── 相位 J：斜杠命令的解析（中文标点、口头主语、别名、认不出来） ── */
// 起因：用户敲「想学：xxx」拿到的却是用法提示——解析器只按空白切词，
// 冒号后面不加空格就整串变成一个不认识的动词。这里把各种真实写法都锁住。
console.log('\n[J] 斜杠命令解析')
const homeJ = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-j-'))
process.env.DSH_HOME = homeJ
const logsJ = []
const j = makeCtx(logsJ)
const pluginJ = await import(`./index.js?j=1`)
pluginJ.apply(j.ctx)
await new Promise((r) => setTimeout(r, 150))
const STATE_J = path.join(homeJ, 'dsh-gongwei', 'state.json')
const readJ = () => JSON.parse(fs.readFileSync(STATE_J, 'utf8'))
const cmdJ = j.registered.commands.find((c) => c.name === 'gongwei')
const runJ = (rawInput) => cmdJ.handler({ rawInput })

// 认不出来的必须报错，而且**不能**顺手打成一次卡（老实现就是掉进打卡分支）
const typo = await runJ('胡说八道')
check('认不出来的报错', typo.kind === 'error', typo)
check('认不出来时没打卡', readJ().days[todayKey]?.checkin === undefined, readJ().days[todayKey])
const typo2 = await runJ('想学习英语')
check('「想学习」不被切成「想学」+「习」', typo2.kind === 'error', typo2)
check('「想学习」没打卡', readJ().days[todayKey]?.checkin === undefined, readJ().days[todayKey])

// 中文冒号 / 半角冒号 / 空格，都应该认
const colonFull = await runJ('想学：把 RetNet 的 cache 机制搞明白')
check('全角冒号分隔', colonFull.kind === 'success' && colonFull.text.includes('丢进池子'), colonFull)
const colonHalf = await runJ('想学:Chroma 的检索参数')
check('半角冒号分隔', colonHalf.kind === 'success', colonHalf)
const bySpace = await runJ('想学 skills 到底怎么写')
check('空格分隔', bySpace.kind === 'success', bySpace)
check('三条都进池子了', readJ().plans.length === 3, readJ().plans.length)

// 口头主语与常见别名
const withPrefix = await runJ('我想学：学习率怎么调')
check('去掉口头主语「我想学」', withPrefix.kind === 'success' && withPrefix.text.includes('丢进池子'), withPrefix)
const aliasAdd = await runJ('添加 看看 LoRA 的实现')
check('别名「添加」', aliasAdd.kind === 'success', aliasAdd)
const aliasThrow = await runJ('丢进池子：读一下 RoPE 的论文')
check('别名「丢进池子」', aliasThrow.kind === 'success', aliasThrow)

// 记 / 感想 也要认冒号
const logColon = await runJ('记：今天把 baseline 跑通了')
check('「记：」冒号分隔', logColon.kind === 'success', logColon)
check('记录落盘了', readJ().days[todayKey].entries.some((e) => e.text.includes('baseline 跑通')), readJ().days[todayKey].entries)
const thinkColon = await runJ('感想：方向还没定，先把基础补上')
check('「感想：」冒号分隔', thinkColon.kind === 'success', thinkColon)
check('感想落盘了', readJ().days[todayKey].thoughts.some((t) => t.text.includes('方向还没定')), readJ().days[todayKey].thoughts)
const polite = await runJ('帮我记一条：看了 LoRA 那篇')
check('去口头语「帮我记一条」', polite.kind === 'success' && polite.text.includes('记下了'), polite)

// 剩下几个动词也别断
const listJ = await runJ('池子')
check('「池子」列表', listJ.kind === 'success' && listJ.text.includes('想学的'), listJ)
const doneJ = await runJ('完了 1')
check('「完了 1」划掉', doneJ.kind === 'success' && doneJ.text.includes('划掉'), doneJ)
// 划掉之后序号会重排（未完成的还在前面、新的在前），所以「撤销 1」指向的已经不是同一条了。
// 按刚划掉那条正文里的关键词来撤销，才测得到「撤销」这个动词本身。
const justDone = readJ().plans.find((p) => p.done && typeof p.planLogTs === 'number')
const doneKeyword = justDone.text.split(/\s+/)[0]
const undoJ = await runJ(`撤销 ${doneKeyword}`)
check('「撤销」放回', undoJ.kind === 'success' && undoJ.text.includes('放回'), undoJ)
check('撤销后那条回到未完成', readJ().plans.find((p) => p.id === justDone.id)?.done === false, readJ().plans.find((p) => p.id === justDone.id))
const statusJ = await runJ('状态')
check('「状态」', statusJ.kind === 'success', statusJ)
// 真空输入仍然当打卡（这是唯一允许把「空」解释成动作的地方）
const emptyJ = await runJ('')
check('空输入当打卡', emptyJ.kind === 'success' && /\d{2}:\d{2}/.test(emptyJ.text), emptyJ)
check('J 无 error 日志', logsJ.every(([lvl]) => lvl !== 'error'), logsJ)

fs.rmSync(homeJ, { recursive: true, force: true })

/* ── 相位 K：打卡菜单点击 → 克隆音色配音 ── */
// 要验证两件事：① 打卡分支走的是 speak:true + surface=desktop（否则宿主不写 voiceTo、不出声）；
// ② 语音文案是短的口语鼓励语，不是 checkinSentence 那种念报表的长句。
// 手段：mock 全局 fetch，把 callPet 的每次请求路径与 body 记下来。
console.log('\n[K] 打卡菜单点击 → 配音')
const homeK = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-k-'))
process.env.DSH_HOME = homeK
// 预置「上一个工作日」的记录与感想：打卡问候的钩子要能把那句打算拎出来问一句。
const prevK = backWorkdays(1)[0]
const seedK = { version: 1, config: {}, days: {}, flags: {}, meta: {} }
if (prevK) {
  seedK.days[keyOf(prevK)] = {
    checkin: '09:40',
    checkinTs: prevK.getTime(),
    entries: [
      { at: '10:30', ts: prevK.getTime() + 3_600_000, text: '看了 LoRA 的推导，明白了低秩分解那一步' },
    ],
    thoughts: [
      {
        at: '18:00',
        ts: prevK.getTime() + 8 * 3_600_000,
        text: '今天想了很多，明天要把记账小程序的表结构先定下来。',
      },
    ],
  }
}
seedK.plans = [
  {
    id: 'pk1',
    text: '学微信公众号文章的排版和配图',
    note: '',
    source: 'chat',
    done: false,
    createdAt: now.getTime(),
    doneAt: null,
    doneDay: null,
    planLogTs: null,
  },
]
fs.mkdirSync(path.join(homeK, 'dsh-gongwei'), { recursive: true })
fs.writeFileSync(path.join(homeK, 'dsh-gongwei', 'state.json'), JSON.stringify(seedK, null, 2))
const logsK = []
const webK = makeWebServer()
const k = makeCtx(logsK, null, webK, makeConnection())
const originalFetch = globalThis.fetch
const fetchesK = []
let clickFired = false
globalThis.fetch = async (url, init) => {
  fetchesK.push({ url: String(url), init })
  const u = String(url)
  if (u.includes('/menu/events')) {
    // 模拟宿主的 8 秒长轮询：这里睡一小会儿给循环降速，否则 while 会空转打满 CPU。
    await new Promise((r) => setTimeout(r, 150))
    const events = clickFired ? {} : { '打个卡': 'main' }
    clickFired = true
    return { text: async () => JSON.stringify({ ok: true, events }) }
  }
  if (u.includes('/config')) return { text: async () => JSON.stringify({ main: {} }) }
  return { text: async () => JSON.stringify({ ok: true }) }
}
try {
  const pluginK = await import(`./index.js?k=1`)
  pluginK.apply(k.ctx)
  // 等 boot（含一次 events 轮询投喂点击）+ onMenuClick 跑完
  await new Promise((r) => setTimeout(r, 400))

  const voiceCall = fetchesK.find(
    (f) => f.url.includes('/broadcast') && f.url.includes('surface=desktop') && JSON.parse(f.init.body).speak === true,
  )
  check('打卡点击发了 speak:true 的 broadcast', Boolean(voiceCall), fetchesK.map((f) => f.url))
  if (voiceCall) {
    const text = JSON.parse(voiceCall.init.body).text
    check('打卡气泡带到达时间', /\d{2}:\d{2}/.test(text), text)
    check('打卡气泡带连续天数', text.includes('连续第'), text)
    check('打卡气泡引用昨天的打算', text.includes('昨天你') && text.includes('记账小程序'), text)
    check('引文摘掉了「明天」这类时间词', !text.includes('「明天'), text)
    check('打卡气泡是两行（到达 + 钩子）', text.includes('\n'), text)
    check('打卡气泡不是报表', !text.includes('基准') && !text.includes('平均'), text)
  }
  // 纯函数分支
  const vRepeat = pluginK.checkinVoiceText({ fresh: false })
  check('重复打卡文案只有一行', vRepeat.includes('已经打过卡') && !vRepeat.includes('\n'), vRepeat)
  const vStreak = pluginK.checkinVoiceText({ fresh: true, minutes: 540, streak: { current: 3 } })
  check('无钩子时只有一行', !vStreak.includes('\n') && vStreak.includes('连续第 3 个工作日'), vStreak)
  const vEarly = pluginK.checkinVoiceText({ fresh: true, minutes: 540, verdict: 'early' })
  const vLate = pluginK.checkinVoiceText({ fresh: true, minutes: 540, verdict: 'late' })
  const vOn = pluginK.checkinVoiceText({ fresh: true, minutes: 540, verdict: 'ontime' })
  check('早晚分档措辞不同', vEarly !== vLate && vLate !== vOn && vEarly !== vOn, [vEarly, vLate, vOn])
  check('早到戳早到那句', vEarly.includes('利索'), vEarly)
  check('晚到不说教', vLate.includes('来了就算数'), vLate)
  const vSeed1 = pluginK.checkinVoiceText({ fresh: true, minutes: 540, verdict: 'early' }, { seed: 1 })
  check('同一天变体稳定、换天会换', vEarly === pluginK.checkinVoiceText({ fresh: true, minutes: 540, verdict: 'early' }, { seed: 0 }) && vSeed1 !== vEarly, [vEarly, vSeed1])
  const vMile = pluginK.checkinVoiceText({ fresh: true, minutes: 540, streak: { current: 5 } })
  check('连击逢五换庆祝句', vMile.includes('这条线还没断'), vMile)
  const vHook = pluginK.checkinVoiceText({ fresh: true, minutes: 540, verdict: 'early' }, { hook: '池子里还欠 18 条', seed: 0 })
  check('钩子另起一行', vHook.includes('\n池子里还欠 18 条'), vHook)
  teardown(k.disposers)
} finally {
  globalThis.fetch = originalFetch
}
fs.rmSync(homeK, { recursive: true, force: true })

/* ── 相位 L：「想学的」⇄ 桌宠待办 双向合并 ── */
// 用内存里的一份假待办列表模拟 dsh-pet 的 /todos HTTP 接口（create/update/remove 都照
// 它的语义：update 推 updatedAt、remove 幂等）。这样既能验证投影/收养/回写/清理，
// 又完全不碰真实的 todos.json。
console.log('\n[L] 想学的 ⇄ 桌宠待办 合并同步')
const homeL = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-l-'))
process.env.DSH_HOME = homeL
const logsL = []
const webL = makeWebServer()
const l = makeCtx(logsL, null, webL, makeConnection())
const originalFetchL = globalThis.fetch

const petTodosL = []
let todoSeqL = 0
const seedTodoL = (text, dueAt = null, done = false) => {
  const t = {
    id: `todo-l${(++todoSeqL).toString(36)}`,
    text,
    dueAt,
    done,
    createdAt: 1_700_000_000_000 + todoSeqL,
    updatedAt: 1_700_000_000_000 + todoSeqL,
    completedAt: done ? 1_700_000_000_000 + todoSeqL : null,
    lastRemindedAt: null,
  }
  petTodosL.push(t)
  return t
}
// 限期任务（带 dueAt）：不管自动收编开不开，都该留作任务、一个字不碰
const nativeDueL = new Date(2026, 10, 30, 10, 0).getTime()
const nativeIdL = seedTodoL('用户自己的原生待办：交房租', nativeDueL).id
// 同文收养用的原生待办：给个 dueAt，让它先不被 1.5 自动收编，留给步骤 ② 走收养路径
const adoptTextL = '把 RetNet 的 cache 机制搞明白'
const adoptTodoL = seedTodoL(adoptTextL, nativeDueL)
// 无截止的原生待办：新规则下应被自动收编进池子，并补上 [想学] 标记
const autoTodoTextL = '桌宠端写的：想学 React'
const autoTodoL = seedTodoL(autoTodoTextL)
const jsonResL = (o) => ({ text: async () => JSON.stringify(o) })

globalThis.fetch = async (url, init) => {
  const u = String(url)
  const method = String(init?.method ?? 'GET').toUpperCase()
  const body = init?.body ? JSON.parse(init.body) : null
  if (u.includes('/menu/events')) {
    await new Promise((r) => setTimeout(r, 250))
    return jsonResL({ ok: true, events: {} })
  }
  if (u.includes('/config')) return jsonResL({ main: {} })
  if (u.includes('/dsh-pet-7340/todos')) {
    const pathname = new URL(u).pathname
    const m = /\/todos(?:\/([^/?]+))?$/.exec(pathname)
    const id = m && m[1] ? decodeURIComponent(m[1]) : null
    if (method === 'GET') return jsonResL({ ok: true, todos: petTodosL })
    if (method === 'POST') {
      const t = seedTodoL(body.text, body.dueAt ?? null)
      return jsonResL({ ok: true, todo: t })
    }
    if (method === 'PATCH') {
      const t = petTodosL.find((x) => x.id === id)
      if (!t) return jsonResL({ ok: false, reason: 'todo-not-found' })
      if (body && Object.prototype.hasOwnProperty.call(body, 'text')) t.text = body.text
      if (body && Object.prototype.hasOwnProperty.call(body, 'dueAt')) t.dueAt = body.dueAt
      if (body && Object.prototype.hasOwnProperty.call(body, 'done')) {
        t.done = body.done
        t.completedAt = body.done ? Date.now() : null
      }
      t.updatedAt = Date.now()
      return jsonResL({ ok: true, todo: { ...t } })
    }
    if (method === 'DELETE') {
      const i = petTodosL.findIndex((x) => x.id === id)
      if (i >= 0) petTodosL.splice(i, 1)
      return jsonResL({ ok: true, removed: i >= 0 ? 1 : 0 })
    }
  }
  return jsonResL({ ok: true })
}

const waitSyncL = () => new Promise((r) => setTimeout(r, 1450))
const STATE_L = path.join(homeL, 'dsh-gongwei', 'state.json')
const readL = () => JSON.parse(fs.readFileSync(STATE_L, 'utf8'))
try {
  const pluginL = await import(`./index.js?l=1`)
  pluginL.apply(l.ctx)
  await new Promise((r) => setTimeout(r, 400))
  const toolL = l.registered.tools.find((t) => t.name === 'gongwei')
  const callL = (args) => toolL.execute(args, {})

  // 纯函数：截止时间解析与命令行剥时间
  check('parseDueAt 解析本地时间', pluginL.parseDueAt('2026-11-20 10:20') === new Date(2026, 10, 20, 10, 20).getTime())
  check('parseDueAt 拒绝乱写', pluginL.parseDueAt('不知道哪天') === null)
  const derived = pluginL.extractDue('看论文 @2026-11-20 10:20')
  check('extractDue 剥出行尾 @时间', derived.text === '看论文' && derived.dueRaw === '2026-11-20 10:20', derived)

  // 初始同步：
  // - 带 dueAt 的限期待办一个字不碰
  // - 无 dueAt 的原生待办按新规则自动收编进池子，并补上 [想学] 标记
  check('限期待办没被改', petTodosL.some((t) => t.id === nativeIdL && t.text === '用户自己的原生待办：交房租'))
  check('限期待办没被加标记', !petTodosL.some((t) => t.id === nativeIdL && t.text.startsWith('[想学] ')))
  const autoPlanL = readL().plans.find((p) => p.text === autoTodoTextL)
  check('无期限原生待办被收编进池子', Boolean(autoPlanL), readL().plans.map((p) => p.text))
  check('收编的原生待办补上了标记', petTodosL.find((t) => t.id === autoTodoL.id)?.text === '[想学] ' + autoTodoTextL,
    petTodosL.find((t) => t.id === autoTodoL.id)?.text)
  check('收编建立了映射', Boolean(readL().meta.todoMap?.[autoPlanL?.id]), readL().meta.todoMap)

  // ① 加一条带截止的：投影成带 [想学] 标记、带 dueAt 的待办
  const dueMsL = new Date(2026, 10, 20, 10, 20).getTime()
  const addedL = await callL({ action: 'plan_add', text: '写创新成果报告', due_at: '2026-11-20 10:20' })
  check('带截止的加进池子', addedL.includes('截止'), addedL)
  await waitSyncL()
  const reportPlanL = readL().plans.find((p) => p.text === '写创新成果报告')
  check('plan 存了 dueAt', reportPlanL && reportPlanL.dueAt === dueMsL, reportPlanL)
  const reportTodoL = petTodosL.find((t) => t.text === '[想学] 写创新成果报告')
  check('投影出带标记的待办', Boolean(reportTodoL), petTodosL.map((t) => t.text))
  check('投影带上了 dueAt', reportTodoL && reportTodoL.dueAt === dueMsL, reportTodoL)
  check('投影映射落了盘', Boolean(readL().meta.todoMap?.[reportPlanL.id]), readL().meta.todoMap)

  // ② 加一条与限期待办同文的：应收养那条待办（并清掉它的 dueAt 以对齐 plan），不重复造
  const beforeCountL = petTodosL.length
  await callL({ action: 'plan_add', text: adoptTextL })
  await waitSyncL()
  check('收养没造新待办', petTodosL.length === beforeCountL, petTodosL.length)
  check('收养的待办补上了标记', petTodosL.find((t) => t.id === adoptTodoL.id)?.text === '[想学] ' + adoptTextL,
    petTodosL.find((t) => t.id === adoptTodoL.id)?.text)

  // ③ 桌宠端用户改了投影（文字 + 勾完成）：下一次同步写回 plan，且带上学习记录
  const editedTodoL = petTodosL.find((t) => t.text === '[想学] 写创新成果报告')
  editedTodoL.text = '[想学] 写创新成果报告（第二版）'
  editedTodoL.done = true
  editedTodoL.completedAt = Date.now()
  editedTodoL.updatedAt = Date.now()
  await callL({ action: 'plan_add', text: '顺手触发一次同步' }) // 借一次动作唤醒防抖同步
  await waitSyncL()
  const rewrittenL = readL().plans.find((p) => p.id === reportPlanL.id)
  check('桌宠改文写回了 plan', rewrittenL?.text === '写创新成果报告（第二版）', rewrittenL)
  check('桌宠勾完成写回了 plan', rewrittenL?.done === true, rewrittenL)
  check('回写完成也记了学习记录', Object.values(readL().days).some((d) => d.entries.some((e) => e.text.includes('写创新成果报告（第二版）'))))

  // ④ 用户在桌宠端删了投影：plan 跟着删
  const iAdoptL = petTodosL.findIndex((t) => t.id === adoptTodoL.id)
  if (iAdoptL >= 0) petTodosL.splice(iAdoptL, 1)
  await callL({ action: 'plan_add', text: '再一次触发同步' })
  await waitSyncL()
  check('桌宠删除带走 plan', !readL().plans.some((p) => p.text === adoptTextL), readL().plans.map((p) => p.text))

  // ⑤ gongwei 端划掉/删掉：桌宠投影跟着完成/清除
  await callL({ action: 'plan_drop', ref: '写创新成果报告（第二版）' })
  await waitSyncL()
  check('删 plan 带走桌宠投影', !petTodosL.some((t) => t.text.startsWith('[想学] 写创新成果报告')), petTodosL.map((t) => t.text))
  check('原生待办全程未被碰', petTodosL.some((t) => t.id === nativeIdL && t.text === '用户自己的原生待办：交房租'))

  // ⑥ 用户直接在桌宠端新建一条带标记的待办：应被吸收入池子（复用同一条，不另建投影）
  const newPetTodoDue = new Date(2026, 10, 22, 9, 0).getTime()
  const newPetTodo = seedTodoL('[想学] 桌宠端直接加的想学项', newPetTodoDue)
  await callL({ action: 'plan_add', text: '唤醒同步' }) // 借一次动作唤醒防抖同步（它自己也会投影一条，故按正文计数）
  await waitSyncL()
  const absorbedPlanL = readL().plans.find((p) => p.text === '桌宠端直接加的想学项')
  check('桌宠新建带标记待办被吸收入池', Boolean(absorbedPlanL), readL().plans.map((p) => p.text))
  check('吸收的 plan 带上了 dueAt', absorbedPlanL && absorbedPlanL.dueAt === newPetTodoDue, absorbedPlanL)
  const dupCountL = petTodosL.filter((t) => t.text && t.text.includes('桌宠端直接加的想学项')).length
  check('吸收没另造待办', dupCountL === 1, dupCountL)
  check('吸收复用了同一条待办', readL().meta.todoMap?.[absorbedPlanL?.id]?.id === newPetTodo.id, readL().meta.todoMap?.[absorbedPlanL?.id])
  check('吸收后原生待办仍未被碰', petTodosL.some((t) => t.id === nativeIdL && t.text === '用户自己的原生待办：交房租'))

  // ⑦ 关掉自动收编后：新加的无期限原生待办不再被收编、也不加标记
  const offMsgL = await callL({ action: 'config', adopt_untimed_todos: false })
  check('关掉自动收编有回执', offMsgL.includes('关'), offMsgL)
  check('开关落了盘', readL().config?.adoptUntimedTodos === false, readL().config)
  const manualTodo = seedTodoL('手动留着不收编：某个灵感')
  await callL({ action: 'plan_add', text: '唤醒同步用' })
  await waitSyncL()
  check('关掉后无期限待办没进池子', !readL().plans.some((p) => p.text === '手动留着不收编：某个灵感'), readL().plans.map((p) => p.text))
  check('关掉后待办没被加标记', petTodosL.find((t) => t.id === manualTodo.id)?.text === '手动留着不收编：某个灵感',
    petTodosL.find((t) => t.id === manualTodo.id)?.text)

  teardown(l.disposers)
} finally {
  globalThis.fetch = originalFetchL
}
fs.rmSync(homeL, { recursive: true, force: true })

/* ── 相位 M：气泡摘要卡 + 全文面板 ── */
// 这里验证 m01578 那套改动：气泡只放摘要（模型压缩，用不了就启发式兜底）、
// 按句读截断不吃半句、时长按字数走，以及设置页「今天」能拿到完整原文。
console.log('\n[M] 气泡摘要卡 + 今天面板')

const LONG_ENTRY = '看B站黑马程序员的AI名词解释视频，了解了机器学习、深度学习、强化学习（开题里提到，以后可能用这个思想）。开始看鱼皮的 Vibe Coding 教程，打算以后用AI多做网站并争取上线。'
const LONG_THOUGHT = '今天尝试开始根据自己的需求来设计插件了，还有挺多bug的，多测试多优化吧。感觉还是得多用用DSH，多学习多总结。'
const LONG_ENTRY_2 = '复现了 baseline，dev F1 +1.3，比昨天那个版本稳一些。'
const LONG_ENTRY_3 = '把插件的菜单回执改了一遍，气泡原来只能显示半句话，现在先摘要再截断。'

/** 起一个装了记录的插件实例，返回 {plugin, fetches, logs, disposers, web}。 */
async function bootWithEntries({ tag, entries, thoughts, llm, extra = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `gongwei-m-${tag}-`))
  process.env.DSH_HOME = home
  const dir = path.join(home, 'dsh-gongwei')
  fs.mkdirSync(dir, { recursive: true })
  const day = { checkin: '10:49', checkinTs: now.getTime(), entries, thoughts }
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ version: 1, config: {}, days: { [todayKey]: day }, flags: {}, plans: [], meta: {} }, null, 2),
    'utf8',
  )
  const logs = []
  const web = makeWebServer()
  const ctxPack = makeCtx(logs, null, web, makeConnection(), {
    llm: llm ?? null,
    agentDefaultModel: fakeModel,
    ...extra,
  })
  const fetches = []
  const originalFetch = globalThis.fetch
  let clicks = null
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    fetches.push({ url: u, init })
    if (u.includes('/menu/events')) {
      await new Promise((r) => setTimeout(r, 120))
      const events = clicks === null ? {} : clicks
      clicks = null
      return { text: async () => JSON.stringify({ ok: true, events }) }
    }
    if (u.includes('/config')) return { text: async () => JSON.stringify({ main: {} }) }
    if (u.includes('/todos')) return { text: async () => JSON.stringify({ ok: true, todos: [] }) }
    return { text: async () => JSON.stringify({ ok: true }) }
  }
  const plugin = await import(`./index.js?m-${tag}=1`)
  plugin.apply(ctxPack.ctx)
  await new Promise((r) => setTimeout(r, 200))
  return {
    plugin,
    fetches,
    logs,
    web,
    home,
    disposers: ctxPack.disposers,
    /** 点一次桌宠菜单，等它把气泡（含模型精修的第二次）发出去，返回最后那条。 */
    async click(label, waitMs = 1400) {
      fetches.length = 0
      clicks = { [label]: 'main' }
      await new Promise((r) => setTimeout(r, waitMs))
      const calls = fetches.filter((f) => f.url.includes('/broadcast'))
      if (calls.length === 0) return null
      const body = JSON.parse(calls[calls.length - 1].init.body)
      return { text: body.text, duration: body.duration, bubbles: calls.map((c) => JSON.parse(c.init.body).text) }
    },
    restore() {
      globalThis.fetch = originalFetch
      teardown(ctxPack.disposers)
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

// ① 有模型：气泡应该是压缩后的一句话清单
{
  const llm = makeLlm({ reply: '1|看了 AI 名词解释视频（机器学习/深度学习/强化学习）\n2|入门 Vibe Coding，打算多做网站上线' })
  const m = await bootWithEntries({
    tag: 'a',
    entries: [
      { at: '10:50', ts: now.getTime(), text: LONG_ENTRY },
      { at: '11:20', ts: now.getTime(), text: '复现了 baseline，dev F1 +1.3' },
    ],
    thoughts: [],
    llm,
  })
  const bubble = await m.click('今天记录')
  check('气泡发出来了', bubble !== null, bubble)
  check('气泡没超容量', bubble.text.length <= 120, bubble.text.length)
  check('气泡带了条数', bubble.text.includes('2 条'), bubble.text)
  check('气泡带了总字数', /\d+ 字/.test(bubble.text), bubble.text)
  check('气泡用了模型摘要', bubble.text.includes('机器学习') || bubble.text.includes('Vibe'), bubble.text)
  check('气泡没把原文整段塞进去', !bubble.text.includes('开题里提到'), bubble.text)
  check('气泡指路到设置页', bubble.text.includes('成长手记'), bubble.text)
  check('模型被调用了一次', llm.calls.length === 1, llm.calls.length)
  // 摘要已经在启动时预热好了，所以点下去只有一次气泡（不闪两下）
  check('预热命中缓存时只弹一次', bubble.bubbles.length === 1, bubble.bubbles)
  check('模型请求带 system', typeof llm.calls[0]?.system === 'string' && llm.calls[0].system.includes('24 个字'), llm.calls[0]?.system)
  check('system 禁止脑补', llm.calls[0]?.system.includes('不要补充'), llm.calls[0]?.system)
  check('模型请求带会话身份', llm.calls[0]?.sessionId === 'dsh-gongwei', llm.calls[0]?.sessionId)
  check('模型请求是纯对象 messages', Array.isArray(llm.calls[0]?.messages) && llm.calls[0].messages[0].role === 'user', llm.calls[0]?.messages)

  // ② 缓存：同一批内容再点一次，不该再花一次模型调用
  const again = await m.click('今天记录')
  check('二次点击仍有气泡', again !== null)
  check('二次点击命中缓存（模型只调 1 次）', llm.calls.length === 1, llm.calls.length)
  m.restore()
}

// ②b 冷启动（预热还没跑完就点）：先弹启发式，模型好了再覆盖，不能让用户干等
{
  const llm = makeLlm({
    reply: '1|看了 AI 名词解释视频，了解三类学习\n2|入门 Vibe Coding',
    delayMs: 600,
  })
  const m = await bootWithEntries({
    tag: 'a2',
    entries: [
      { at: '10:50', ts: now.getTime(), text: LONG_ENTRY },
      { at: '11:20', ts: now.getTime(), text: LONG_ENTRY_2 },
    ],
    thoughts: [],
    llm,
  })
  const bubble = await m.click('今天记录', 2000)
  check('冷启动也照样出气泡', bubble !== null, bubble)
  check('冷启动先弹启发式（两步）', bubble.bubbles.length === 2, bubble.bubbles)
  check('冷启动第一步是原文首句', bubble.bubbles[0].includes('看B站黑马程序员'), bubble.bubbles[0])
  check('冷启动第二步换成模型摘要', bubble.bubbles[1].includes('入门 Vibe Coding'), bubble.bubbles[1])
  m.restore()
}

// ③ 模型把两条并成一条：对上的用摘要，对不上的单条退回原文首句，不能整体丢弃
{
  const llm = makeLlm({ reply: '1|看了 AI 名词解释视频，了解三类学习\n2|入门 Vibe Coding' })
  const m = await bootWithEntries({
    tag: 'b',
    entries: [
      { at: '10:50', ts: now.getTime(), text: LONG_ENTRY },
      { at: '11:20', ts: now.getTime(), text: LONG_ENTRY_2 },
      { at: '11:40', ts: now.getTime(), text: LONG_ENTRY_3 },
    ],
    thoughts: [],
    llm,
  })
  const bubble = await m.click('今天记录')
  check('漏条也照样出气泡', bubble !== null, bubble)
  check('对上的条目用了模型摘要', bubble.text.includes('入门 Vibe Coding'), bubble.text)
  check('漏掉的条目退回原文首句', bubble.text.includes('把插件的菜单回执改了一遍'), bubble.text)
  check('漏条后仍不超容量', bubble.text.length <= 120, bubble.text.length)
  check('模型只调一次', llm.calls.length === 1, llm.calls.length)
  m.restore()
}

// ③b 模型完全没按编号格式回：整体放弃，全部退回启发式
{
  const llm = makeLlm({ reply: '只有一行没有编号' })
  const m = await bootWithEntries({
    tag: 'b2',
    entries: [
      { at: '10:50', ts: now.getTime(), text: LONG_ENTRY },
      { at: '11:20', ts: now.getTime(), text: '复现了 baseline，dev F1 +1.3' },
    ],
    thoughts: [],
    llm,
  })
  const bubble = await m.click('今天记录')
  check('没编号也照样出气泡', bubble !== null, bubble)
  check('没编号降级到原文首句', bubble.text.includes('B站') || bubble.text.includes('复现'), bubble.text)
  check('没编号降级后仍不超容量', bubble.text.length <= 120, bubble.text.length)
  check('没编号时不骂用户', bubble.text.includes('今天 2 条'), bubble.text)
  m.restore()
}

// ④ 模型抛错：静默降级 + 留 warn，不能把菜单点崩
{
  const llm = makeLlm({ throwOnCall: true })
  const m = await bootWithEntries({
    tag: 'c',
    entries: [{ at: '10:50', ts: now.getTime(), text: LONG_ENTRY }],
    thoughts: [],
    llm,
  })
  const bubble = await m.click('今天记录')
  check('模型抛错仍有气泡', bubble !== null, bubble)
  check('模型抛错降到首句', bubble.text.includes('B站'), bubble.text)
  check('模型抛错留了 warn', m.logs.some(([lvl, msg]) => lvl === 'warn' && msg.includes('摘要失败')), m.logs)
  check('模型抛错没留 error', m.logs.every(([lvl]) => lvl !== 'error'), m.logs)
  m.restore()
}

// ⑤ 没有 llm 服务：不报错，直接启发式
{
  const m = await bootWithEntries({
    tag: 'd',
    entries: [{ at: '10:50', ts: now.getTime(), text: LONG_ENTRY }],
    thoughts: [{ at: '10:55', ts: now.getTime(), text: LONG_THOUGHT }],
    llm: null,
  })
  const entryBubble = await m.click('今天记录')
  const thinkBubble = await m.click('记条感想')
  check('没模型也能出记录气泡', entryBubble !== null && entryBubble.text.includes('1 条'), entryBubble)
  check('没模型也能出感想气泡', thinkBubble !== null && thinkBubble.text.includes('1 条'), thinkBubble)
  check('没模型不报 error', m.logs.every(([lvl]) => lvl !== 'error'), m.logs)

  // ⑥ 句读截断：不能停在半句话中间
  const clipped = m.plugin.__test.clip(LONG_ENTRY, 60)
  check('截断结果以省略号收尾', clipped.endsWith('…'), clipped)
  check('截断长度不超上限', clipped.length <= 60, clipped.length)
  check(
    '截断停在句读处',
    /[。！？；，、]…$/.test(clipped) || clipped.replace('…', '').length <= 60,
    clipped,
  )
  const noPunct = m.plugin.__test.clip('这是一段完全没有标点符号的长句子用来测试硬切的行为是否正确', 20)
  check('无标点时长句硬切', noPunct.endsWith('…') && noPunct.length <= 20, noPunct)

  // ⑦ 时长按字数走
  check('短文案时长取下限', m.plugin.__test.bubbleDuration('短') === 6000, m.plugin.__test.bubbleDuration('短'))
  const longDuration = m.plugin.__test.bubbleDuration('字'.repeat(120))
  check('长文案时长更长', longDuration > 20_000 && longDuration <= 22_000, longDuration)
  check('气泡用了动态时长', entryBubble.duration === m.plugin.__test.bubbleDuration(entryBubble.text), {
    sent: entryBubble.duration,
    expect: m.plugin.__test.bubbleDuration(entryBubble.text),
  })

  // ⑧ 设置页「今天」接口：拿到的是完整原文，不是摘要
  const todayRoute = m.web.routes.find((r) => r.path === '/dsh-gongwei/api/today')
  check('注册了今天的路由', todayRoute !== undefined, m.web.routes.map((r) => r.path))
  const today = await callRoute(todayRoute)
  check('今天的接口 ok', today.json?.ok === true, today.json)
  check('今天的接口回了日期', today.json?.day === todayKey, today.json?.day)
  check('今天的接口回了完整记录原文', today.json?.entries?.[0]?.text === LONG_ENTRY, today.json?.entries?.[0])
  check('今天的接口回了完整感想原文', today.json?.thoughts?.[0]?.text === LONG_THOUGHT, today.json?.thoughts?.[0])
  check('今天的接口统计了字数', today.json?.entryChars === LONG_ENTRY.length, today.json?.entryChars)
  check('今天的接口带连续出勤', typeof today.json?.streak === 'string' && today.json.streak.includes('连续'), today.json?.streak)
  const notGet = await callRoute(todayRoute, { method: 'POST', body: {} })
  check('今天的接口拒绝非 GET', notGet.status === 405, notGet.status)

  check('编号分行且不含竖线', /\n1\. /.test(entryBubble.text) && !entryBubble.text.includes('｜'), entryBubble.text)
  check('clip 保留换行', m.plugin.__test.clip('标题\n1. 内容') === '标题\n1. 内容')
  const reportRoute = m.web.routes.find((r) => r.path === '/dsh-gongwei/api/reports')
  check('注册周报阅读接口', !!reportRoute)
  const reportPreview = await callRoute(reportRoute)
  check('周报预览两种正文', reportPreview.json?.ok && reportPreview.json.stat.includes('# ') && reportPreview.json.article.includes('# '), reportPreview.json)
  check('预览不声称归档', reportPreview.json?.saved === false)
  const savedReport = await callRoute(reportRoute, { method: 'POST', body: {} })
  check('周报归档成功', savedReport.json?.saved === true)
  const badReportMethod = await callRoute(reportRoute, { method: 'DELETE' })
  check('周报拒绝其他方法', badReportMethod.status === 405)
  const weeklyCard = await m.click('本周战绩')
  check('本周概览分行不塞原文', weeklyCard.text.includes('\n1. 出勤') && !weeklyCard.text.includes(LONG_ENTRY), weeklyCard)
  // 「写周报」已并入「本周战绩」：看一眼就等于归档，气泡同时说明已存 + 指向每周回顾
  check('本周战绩顺手归档并指向每周回顾', weeklyCard.text.includes('已归档') && weeklyCard.text.includes('每周回顾') && !weeklyCard.text.includes('.md'), weeklyCard)

  // ⑨ 空的一天：气泡是引导语，面板是空状态
  // 必须先停掉上面这个实例——它还在长轮询，会抢走下一个实例的点击事件。
  m.restore()
  const m2 = await bootWithEntries({ tag: 'e', entries: [], thoughts: [], llm: null })
  const emptyBubble = await m2.click('今天记录')
  check('空记录气泡是引导语', emptyBubble !== null && emptyBubble.text.includes('还没记'), emptyBubble)
  const emptyToday = await callRoute(m2.web.routes.find((r) => r.path === '/dsh-gongwei/api/today'))
  check('空记录面板仍 ok', emptyToday.json?.ok === true, emptyToday.json)
  check('空记录面板条目为空', Array.isArray(emptyToday.json?.entries) && emptyToday.json.entries.length === 0, emptyToday.json?.entries)
  m2.restore()
}


/* ── 相位 N：用户稳定画像（长期记忆） ── */
// m00807 用户要求「以后都叫你小鱼了，你记住这个吧」+ 一堆要长期记住的交互偏好。
// 这些不能只塞进当天感想（几轮就被刷掉），要写进每轮生效的 profile，并能在记忆 section 里看到。
console.log('\n[N] 用户稳定画像（长期记忆）')
const homeN = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-n-'))
process.env.DSH_HOME = homeN
const logsN = []
const n = makeCtx(logsN)
const pluginN = await import(`./index.js?n=1`)
pluginN.apply(n.ctx)
await new Promise((r) => setTimeout(r, 150))

const STATE_N = path.join(homeN, 'dsh-gongwei', 'state.json')
const readN = () => JSON.parse(fs.readFileSync(STATE_N, 'utf8'))
const toolN = n.registered.tools.find((t) => t.name === 'gongwei')
const callN = (args) => toolN.execute(args, {})
const secN = n.registered.sections.find((s) => s.name === 'gongwei-memory')

// ① 全新环境画像为空，记忆 section 不提名字
check('新环境画像名字为空', readN().profile.assistantName === '', readN().profile)
check('空画像记忆段不含「关于用户」', !secN.text().includes('关于用户'), secN.text().slice(0, 120))

// ② 改名字 + 追加画像
const setNameN = await callN({ action: 'profile', profile_action: 'set_name', text: '小鱼' })
check('set_name 有回执', setNameN.includes('小鱼'), setNameN)
check('名字落盘', readN().profile.assistantName === '小鱼', readN().profile)
const addN = await callN({ action: 'profile', profile_action: 'add', text: '多督促、多鼓励，用户玻璃心' })
check('add 有回执', addN.includes('记下了'), addN)
await callN({ action: 'profile', profile_action: 'add', text: '周末去对象那里，不来工位' })
check('两条画像落盘', readN().profile.lines.length === 2, readN().profile.lines)
const dupN = await callN({ action: 'profile', profile_action: 'add', text: '多督促、多鼓励，用户玻璃心' })
check('重复画像不重复加', readN().profile.lines.length === 2 && dupN.includes('已经记着'), dupN)

// ③ 记忆 section 每轮带出画像
const memN = secN.text()
check('记忆段带出助手名字', memN.includes('小鱼'), memN.slice(0, 200))
check('记忆段带出画像条目', memN.includes('玻璃心') && memN.includes('周末去对象那里'), memN.slice(0, 300))
check('画像在打卡摘要之前', memN.indexOf('关于用户') < memN.indexOf('今天（'), memN.slice(0, 200))

// ④ 空名字被拒 + remove 关键词
const badNameN = await callN({ action: 'profile', profile_action: 'set_name', text: '   ' })
check('空名字被拒', badNameN.includes('不能是空'), badNameN)
const removeN = await callN({ action: 'profile', profile_action: 'remove', text: '周末' })
check('remove 有回执', removeN.includes('去掉了 1'), removeN)
check('remove 真的删了', readN().profile.lines.length === 1, readN().profile.lines)
const listN = await callN({ action: 'profile', profile_action: 'list' })
check('list 看得到名字', listN.includes('小鱼'), listN)
check('list 看得到剩余画像', listN.includes('玻璃心') && !listN.includes('周末'), listN)

// ⑤ 重载后画像还在（loadStore 保留 profile 字段）
const homeN2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-n2-'))
fs.mkdirSync(path.join(homeN2, 'dsh-gongwei'), { recursive: true })
fs.copyFileSync(STATE_N, path.join(homeN2, 'dsh-gongwei', 'state.json'))
process.env.DSH_HOME = homeN2
const n2 = makeCtx([])
const pluginN2 = await import(`./index.js?n=2`)
pluginN2.apply(n2.ctx)
await new Promise((r) => setTimeout(r, 150))
const secN2 = n2.registered.sections.find((s) => s.name === 'gongwei-memory')
check('重载后画像仍在', secN2.text().includes('小鱼') && secN2.text().includes('玻璃心'), secN2.text().slice(0, 200))
teardown(n2.disposers)
fs.rmSync(homeN2, { recursive: true, force: true })

teardown(n.disposers)
fs.rmSync(homeN, { recursive: true, force: true })

/* ── 相位 O：服务晚一步才挂上，注册要能追上 ── */
console.log('\n[O] 服务比插件晚一步就绪')
const homeO = fs.mkdtempSync(path.join(os.tmpdir(), 'gongwei-o-'))
process.env.DSH_HOME = homeO
const logsO = []
// 四个服务一开始都不存在：extra 里显式 null 表示「还不存在」
const o = makeCtx(logsO, null, null, null, { tools: null, commands: null, systemPrompt: null })
const pluginO = await import(`./index.js?o=1`)
pluginO.apply(o.ctx)
await new Promise((r) => setTimeout(r, 150))

check('服务都还没来时没注册工具', o.registered.tools.length === 0, o.registered.tools.length)
check('服务都还没来时没注册命令', o.registered.commands.length === 0, o.registered.commands.length)
check('服务都还没来时没注册记忆段', o.registered.sections.length === 0, o.registered.sections.length)

// 服务后到：provide 之后应该自动补注册，不需要重载插件
o.ctx.provide('tools', { register: (def) => (o.registered.tools.push(def), () => {}) })
o.ctx.provide('commands', { register: (def) => (o.registered.commands.push(def), () => {}) })
o.ctx.provide('systemPrompt', { section: (sec) => (o.registered.sections.push(sec), () => {}) })
o.ctx.provide('webServer', makeWebServer())

check('tools 后到也注册上了工具', o.registered.tools.some((t) => t.name === 'gongwei'), o.registered.tools.map((t) => t.name))
check('commands 后到也注册上了命令', o.registered.commands.some((c) => c.name === 'gongwei'), o.registered.commands.map((c) => c.name))
check('systemPrompt 后到也注册上了记忆段', o.registered.sections.some((s) => s.name === 'gongwei-memory'), o.registered.sections.map((s) => s.name))

// 工具本身可用：起床就打卡，证明注册的不是空壳
const toolO = o.registered.tools.find((t) => t.name === 'gongwei')
const checkinO = await toolO.execute({ action: 'checkin' }, {})
check('后注册的工具真的能打卡', checkinO.includes('打卡') || checkinO.includes('工位'), checkinO.slice(0, 80))

teardown(o.disposers)
fs.rmSync(homeO, { recursive: true, force: true })

fs.rmSync(homeB, { recursive: true, force: true })
fs.rmSync(homeC, { recursive: true, force: true })
fs.rmSync(homeD, { recursive: true, force: true })
fs.rmSync(homeE, { recursive: true, force: true })
fs.rmSync(homeE2, { recursive: true, force: true })
fs.rmSync(homeF, { recursive: true, force: true })
fs.rmSync(homeG, { recursive: true, force: true })
fs.rmSync(homeH, { recursive: true, force: true })
fs.rmSync(homeI, { recursive: true, force: true })

globalThis.Date = RealDate
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
