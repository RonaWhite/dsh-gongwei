/**
 * dsh-gongwei —— 工位打卡 · 每日学习记录 · 周报 · 持久记忆
 *
 * 挂在 dsh-pet 桌宠上：右键「更多」里出现打卡项，点了就弹气泡；
 * 同时在 DSH 里注册 `gongwei` 工具与 `/gongwei` 命令，让对话也能打卡与记录。
 *
 * 设计取舍：
 * - 不往桌宠源码里塞东西，只用它公开的两条扩展面：`/dsh-pet-7340/menu/*`（菜单）
 *   与 `/dsh-pet-7340/broadcast`（气泡）。气泡文案由本插件给，不走模型，零成本。
 * - 数据落地为单个 JSON 文件（DSH_HOME/dsh-gongwei/state.json），人可读、可手改、可备份。
 * - 不注册 Config schema：配置写在同一个 JSON 的 config 段里，用 `/gongwei 配置` 改。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createImNotifier } from './im-notifier.mjs'

export const name = 'dsh-gongwei'
export const inject = []

const OWNER = 'dsh-gongwei'
const MENU_PATH = '/dsh-pet-7340/menu/item'
const MENU_EVENTS_PATH = '/dsh-pet-7340/menu/events'
const BROADCAST_PATH = '/dsh-pet-7340/broadcast'
const PET_CONFIG_PATH = '/dsh-pet-7340/config'
const PET_STATE_PATH = '/dsh-pet-7340/state'
/** 桌宠「待办事项」的 HTTP 端点。gongwei 清单用它做投影，让一份数据在两处都能看、都能改。 */
const TODOS_PATH = '/dsh-pet-7340/todos'

const DAY_MS = 86_400_000
/**
 * 气泡里最多放多少字。这个数是量出来的，不是拍的。
 *
 * 桌宠 whisper 气泡（.pet-bubble.is-whisper）宽度是 `font * 10.989`，本机 font=23 → 约 253px；
 * 字号是 `font * 0.7473` ≈ 17px，所以一行约 14 个中文字。高度方向没有 max-height，
 * 但窗口上沿余量由待办面板尺寸决定（约 265px），减掉上下 padding 只够 8~9 行。
 * 安全容量因此约 110~120 字——超过就会被窗口边缘裁掉，而且旧的写法还会把一整句话锯成两半。
 */
const TEXT_MAX = 120
/** 「想学」池子里的单条正文与备注上限。池子是要长期用的，所以给得比气泡宽。 */
const PLAN_TEXT_MAX = 200
/** 桌宠待办正文上限（src/host/todo/types.ts TODO_TEXT_MAX）：标记+正文不能超过它。 */
const TODO_TEXT_MAX = 200
const PLAN_NOTE_MAX = 500
/** 池子最多存多少条：只挡失控，正常用不到。 */
const PLAN_MAX = 500

/**
 * 合并标记：投影到桌宠待办时，正文前面加这个前缀。
 * 双向同步靠它分辨「这是 gongwei 管的项目」还是「用户自己加的原生待办」——
 * 只有带标记的才会被我们回写/清理，原生待办绝不碰。
 */
const TODO_MARK = '[想学] '
/**
 * 周报推送失败后的重试间隔。iLink 主动推送被拒（ret=-2 prepare failed）在用户没跟机器人
 * 说过话时会一直失败，所以不能一次就放弃：每 10 分钟试一次，最多 6 次（约一小时）。
 * eventId 带 attempts 序号，否则 im-notifier 的幂等会把它当成重复事件直接丢掉。
 */
const WEEKLY_PUSH_RETRY_MS = 10 * 60_000
const WEEKLY_PUSH_MAX_ATTEMPTS = 6
/** dueAt 字符串解析：接受 'YYYY-MM-DD HH:MM'（本地时区）或毫秒时间戳。 */
export function parseDueAt(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const s = String(raw).trim()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s)
  if (m === null) return null
  const [, y, mo, d, h, mi] = m
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0))
  return Number.isFinite(dt.getTime()) ? dt.getTime() : null
}

/**
 * 从一行命令末尾剥出截止时间，返回 { text, dueRaw }。
 * 支持两种写法：`... @2026-11-20 10:20` 或 `... 截止 2026-11-20 10:20`。
 * 认出的时间会被 parseDueAt 校验；认不出就整段留在 text 里，交给 addPlan 当普通内容。
 */
export function extractDue(raw) {
  const s = String(raw ?? '')
  const m = /(?:@|截止)\s*(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2})?)\s*$/.exec(s)
  if (m === null) return { text: s.trim(), dueRaw: null }
  const dueRaw = m[1]
  if (parseDueAt(dueRaw) === null) return { text: s.trim(), dueRaw: null }
  return { text: s.slice(0, m.index).trim(), dueRaw }
}

/* ────────────────────────── 时间小工具 ────────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0')
const dateKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const hmOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

function parseHm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (m === null) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h > 23 || mi > 59) return null
  return h * 60 + mi
}

const fmtMin = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6

/** 该日所在周的周一（本地 0 点）。 */
function weekStartOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const offset = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - offset)
  return x
}

const dayDiff = (a, b) => Math.round((a.getTime() - b.getTime()) / DAY_MS)

/** 'YYYY-MM-DD' → 本地 0 点的 Date。 */
function dateOfKey(key) {
  const [y, m, d] = String(key).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 下一个工作日（跳过周末）。 */
function nextWorkday(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  while (isWeekend(x)) x.setDate(x.getDate() + 1)
  return x
}

/** 上一个工作日（跳过周末）。 */
function prevWorkday(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  while (isWeekend(x)) x.setDate(x.getDate() - 1)
  return x
}

/* ────────────────────────── 存储 ────────────────────────── */

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
/** 数据目录：默认跟着 DSH_HOME，可用 GONGWEI_DATA_DIR 指到别的盘（本机 C 盘紧张，E 盘宽裕）。 */
const DATA_DIR = process.env.GONGWEI_DATA_DIR ?? path.join(HOME, 'dsh-gongwei')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const REPORT_DIR = path.join(DATA_DIR, 'reports')

const DEFAULT_CONFIG = {
  reminderTime: '21:30',
  baseline: '09:00',
  weeklyDay: 5,
  weeklyTime: '21:45',
  petId: '',
  /**
   * 桌宠「待办事项」里没有 dueAt 的原生条目，自动收进「想学的」池子。
   * 用户自己的口径：带截止=限期交作业（留在待办），不带截止=想学（进池子）。
   * 设 false 可退回老行为：只认带 [想学] 标记的，原生待办一个字不碰。
   */
  adoptUntimedTodos: true,
  /**
   * 周报副本目录：周报除了写进 DATA_DIR/reports（插件自己的归档），再往这里放一份好找的。
   * 空字符串 = 不额外存副本。目录不存在会自动建。
   */
  reportCopyDir: '',
  /**
   * 久坐提醒：工作日每隔多少分钟冒一次「起来活动」的泡。0 = 关。
   * 只在当天已打卡、且落在 stretchStart~stretchEnd 之间（跳过午休 12:00-13:30）才提醒；
   * 计时基准取「打卡时刻」而不是固定 09:30，免得上午十点才来的人一坐下就被催。
   */
  stretchEvery: 50,
  stretchStart: '09:30',
  stretchEnd: '18:00',
  /** 久坐提醒要不要同时推到微信（默认只弹桌宠气泡，免得一天十几条把手机刷满）。 */
  stretchToIm: false,
}

function emptyStore() {
  return {
    version: 1,
    config: { ...DEFAULT_CONFIG },
    /**
     * 用户的稳定画像：不同于每天会被刷掉的「感想」，这些是每轮对话都要带着的长期事实
     * （怎么称呼助手、希望助手怎么对待自己、作息规律、长期想练的能力等）。
     * assistantName = 用户给助手起的名字；lines = 一条条的稳定画像。
     */
    profile: { assistantName: '', lines: [] },
    days: {},
    flags: {},
    /**
     * 想学的东西的「池子」：不预设日期，想到什么丢什么。
     * 跟「待办事项」的区别是它没有截止时间——它是素材库，不是排期表。
     * 每天从池子里挑几条今天的，划掉就自动往当天学习记录里写一条。
     */
    plans: [],
    meta: {
      createdAt: new Date().toISOString(),
      lastWeeklyReport: null,
      planSeq: 0,
      // 双向合并后：每条 gongwei 计划对应的桌宠待办 id。key=plan.id，value=todo.id。
      // 只有真正同步过、又没在桌宠端被删掉的条目才留在这里。
      todoMap: {},
    },
  }
}

/** 计划条目容错解析：任一条坏掉就整条丢掉，别让一条脏数据拖垮整个池子。 */
function parsePlan(raw, fallbackId) {
  if (raw === null || typeof raw !== 'object') return null
  const text = String(raw.text ?? '').trim()
  if (text === '') return null
  const created = Number(raw.createdAt)
  const doneAt = Number(raw.doneAt)
  const planLogTs = Number(raw.planLogTs)
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId,
    text: text.slice(0, PLAN_TEXT_MAX),
    note: String(raw.note ?? '').trim().slice(0, PLAN_NOTE_MAX),
    source: typeof raw.source === 'string' ? raw.source : 'chat',
    done: raw.done === true,
    createdAt: Number.isFinite(created) ? created : Date.now(),
    doneAt: Number.isFinite(doneAt) && raw.done === true ? doneAt : null,
    doneDay: typeof raw.doneDay === 'string' ? raw.doneDay : null,
    // 截止时刻（epoch 毫秒）：有它的计划会投影成带日期的桌宠待办，到点分档提醒。
    dueAt: parseDueAt(raw.dueAt),
    // 划掉时自动写进学习记录的那条的 ts：撤销要靠它精确删除，重新加载后不能丢
    planLogTs: Number.isFinite(planLogTs) && raw.done === true ? planLogTs : null,
  }
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return emptyStore()
    const seenIds = new Set()
    const plans = []
    for (const item of Array.isArray(parsed.plans) ? parsed.plans : []) {
      const plan = parsePlan(item, `p-${plans.length + 1}`)
      if (plan === null || seenIds.has(plan.id)) continue
      seenIds.add(plan.id)
      plans.push(plan)
    }
    const profileRaw = parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : {}
    const profile = {
      assistantName: String(profileRaw.assistantName ?? ''),
      lines: (Array.isArray(profileRaw.lines) ? profileRaw.lines : [])
        .map((line) => String(line).trim())
        .filter((line) => line !== ''),
    }
    return {
      version: 1,
      config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
      profile,
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      flags: parsed.flags && typeof parsed.flags === 'object' ? parsed.flags : {},
      plans,
      meta: { ...emptyStore().meta, ...(parsed.meta ?? {}) },
    }
  } catch {
    return emptyStore()
  }
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, STATE_FILE)
}

/** 取某天的记录，没有就建一条空壳（不写盘，由调用方决定）。 */
function dayEntry(store, key) {
  const existing = store.days[key]
  if (existing && typeof existing === 'object') {
    // 老格式只有 note 一个字符串字段，把它当第一条感想接过来，不丢用户写过的字
    const thoughts = Array.isArray(existing.thoughts) ? existing.thoughts : []
    if (thoughts.length === 0 && typeof existing.note === 'string' && existing.note.trim() !== '') {
      thoughts.push({ at: '', ts: 0, text: existing.note })
    }
    return {
      checkin: typeof existing.checkin === 'string' ? existing.checkin : null,
      checkinTs: typeof existing.checkinTs === 'number' ? existing.checkinTs : null,
      entries: Array.isArray(existing.entries) ? existing.entries : [],
      thoughts,
    }
  }
  return { checkin: null, checkinTs: null, entries: [], thoughts: [] }
}

/* ────────────────────────── 打卡判定 ────────────────────────── */

/** 最近 N 个工作日的打卡分钟数（不含今天、不含周末、按日期倒序取）。 */
function recentCheckins(store, todayKey, limit = 10) {
  const out = []
  for (const [key, value] of Object.entries(store.days)) {
    if (key >= todayKey) continue
    const minutes = parseHm(value?.checkin)
    if (minutes === null) continue
    const [y, m, d] = key.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    if (isWeekend(date)) continue
    out.push({ key, minutes })
  }
  out.sort((a, b) => (a.key < b.key ? 1 : -1))
  return out.slice(0, limit)
}

/**
 * 双口径比较：固定基准线 + 个人近期平均。
 * 返回 null（无历史）或 { baseline, average, vsBaseline, vsAverage }（单位：分钟，负数 = 更早）。
 */
function compareCheckin(store, todayKey, minutes) {
  const baseline = parseHm(store.config.baseline)
  const history = recentCheckins(store, todayKey)
  const average =
    history.length === 0 ? null : Math.round(history.reduce((sum, item) => sum + item.minutes, 0) / history.length)
  if (baseline === null && average === null) return null
  return {
    baseline,
    average,
    historyCount: history.length,
    vsBaseline: baseline === null ? null : minutes - baseline,
    vsAverage: average === null ? null : minutes - average,
  }
}

function deltaWords(delta) {
  const abs = Math.abs(delta)
  if (abs === 0) return '分秒不差'
  return `${delta < 0 ? '早了' : '晚了'} ${abs} 分钟`
}

/* ────────────────────────── 连续出勤 ────────────────────────── */

/**
 * 连续出勤：连续多少个工作日来打了卡。
 *
 * 规则：
 * - 只数有打卡的工作日；周末整段跳过，既不计数也不打断（周末本来就不来，不该算断）。
 * - 今天算不算，取决于今天打了没：没打之前不判它断——早上九点还没打卡，不代表连续记录结束了。
 *   断点只由「已经过去的工作日」产生。
 * - 顺带算历史最长和累计天数：只报当前值的话，断了就一无所有，没有可追的东西。
 */
function streakInfo(store, today) {
  const attended = (key) => {
    const entry = store.days[key]
    return Boolean(entry) && typeof entry === 'object' && parseHm(entry.checkin) !== null
  }
  const todayWorkday = !isWeekend(today)
  const todayDone = todayWorkday && attended(dateKeyOf(today))

  let cursor = todayWorkday && todayDone ? today : prevWorkday(today)
  let current = 0
  for (let guard = 0; guard < 4000; guard += 1) {
    if (!attended(dateKeyOf(cursor))) break
    current += 1
    cursor = prevWorkday(cursor)
  }

  // 历史最长：把所有有打卡的工作日按日期排好，看相邻两个是不是紧挨着的工作日
  const keys = Object.keys(store.days)
    .filter((k) => attended(k) && !isWeekend(dateOfKey(k)))
    .sort()
  let best = 0
  let run = 0
  let prevDate = null
  for (const key of keys) {
    const d = dateOfKey(key)
    run = prevDate !== null && dateKeyOf(nextWorkday(prevDate)) === key ? run + 1 : 1
    if (run > best) best = run
    prevDate = d
  }
  if (current > best) best = current

  return { current, includesToday: todayDone, best, total: keys.length, todayWorkday }
}

/**
 * 打卡文案尾巴：只说「今天算进连击后的第几天」。
 *
 * 只在刚打完卡时调用，所以这里不处理「今天还没打」——那句催促在 tick 的提醒里，那边才知道时间点。
 */
function streakTail(info) {
  if (!info.todayWorkday || !info.includesToday) return ''
  if (info.current >= 2) return ` 连续第 ${info.current} 个工作日。`
  if (info.best >= 3) return ` 连续记录从今天重新开始，上次最长 ${info.best} 天。`
  return ''
}

/** 「连续 N 个工作日（最长 M 天，累计 T 天）」的一段话。 */
function streakLine(info) {
  if (info.total === 0) return '还没有连续记录。'
  const detail = `最长 ${info.best} 天，累计 ${info.total} 天`
  if (info.current <= 0) return `连续记录断了（${detail}）`
  const head = info.includesToday ? `当前连续 ${info.current} 个工作日` : `上段连续 ${info.current} 个工作日`
  return `${head}（${detail}）`
}

/**
 * 日期串 → 稳定整数序号。
 *
 * 用来「按天轮换」文案：同一天永远是同一个变体（不会刷新两次变一句话），
 * 换一天才会换——这样既有变化，又不显得随机乱跳。
 */
function keySerial(key) {
  const parts = String(key ?? '').split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return 0
  return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86_400_000)
}

/** 按 seed 从一组候选里挑一个；空数组给空串。 */
function pickRotating(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return ''
  const size = list.length
  return list[((seed % size) + size) % size]
}

/** 摘掉开头的「明天 / 今天 / 周一」这类时间词——第二天念出来会变成「昨天你说明天…」。 */
function stripLeadTime(text) {
  return String(text ?? '')
    .replace(/^(?:今天|明天|后天|之后|接下来|下?周[一二三四五六日末])\s*/, '')
    .trim()
}

/**
 * 从最近几段文字里挑一段最值得第二天拿出来问的话。
 *
 * 打分而不是「命中第一个」：真实记录里既有「明天要把表结构定下来」这种明确打算，
 * 也有「鱼皮那句『站在巨人的肩膀上』很对」这种引用别人的感想——后者拎出来问一句很怪。
 * 所以：有行动词加分，动作动词开头再加分，带引号（多半在引用别人的话）减分，纯感受词减分。
 * 平局取靠后的一段——最后一句通常是收尾的结论。
 *
 * 返回 { quote, score }；没有任何可用片段时返回 null。
 */
function bestIntent(texts, max = 24) {
  const actionWords = [
    '打算',
    '准备',
    '计划',
    '下一步',
    '接下来',
    '先把',
    '要做',
    '试试',
    '开始',
    '搞懂',
    '弄明白',
    '写完',
    '看完',
    '推进',
    '要',
  ]
  const verbHeads = ['把', '做', '写', '学', '看', '改', '跑', '整理', '搭', '试', '弄', '搞', '补', '定', '想']
  const moodWords = ['觉得', '感觉', '可能', '大概', '似乎', '好像']

  let best = null
  for (const text of texts) {
    const flat = flatText(text)
    if (flat === '') continue
    for (const sentence of flat.split(/[。！？；\n]/)) {
      for (const piece of sentence.split(/[，：:—]/)) {
        const clean = piece.trim()
        if (clean.length < 6) continue
        let score = 0
        if (actionWords.some((w) => clean.includes(w))) score += 3
        if (verbHeads.some((w) => clean.startsWith(w))) score += 2
        // 带引号/弯引号：多半是在复述别人的话，拎出来问会显得莫名其妙
        if (/[\u300c\u300d\u201c\u201d"']/.test(clean)) score -= 4
        if (moodWords.some((w) => clean.includes(w))) score -= 1
        // 同样像打算时，长一点的更具体、更适合被引用（「要把表结构先定下来」胜过「要开发的东西很多」）
        score += Math.min(2, Math.floor(clean.length / 12))
        if (score < 0) score = 0
        const quote = clip(stripLeadTime(clean), max)
        if (quote === '') continue
        if (best === null || score >= best.score) best = { quote, score }
      }
    }
  }
  return best
}

/** 早晚判断：两条口径（基准线 + 个人平均）都早才算早，都晚才算晚。 */
function verdictOf(comparison) {
  if (comparison === null || comparison === undefined) return 'unknown'
  const { average, vsBaseline, vsAverage, historyCount } = comparison
  const hasAverage = average !== null && historyCount > 0
  const signals = [vsBaseline, hasAverage ? vsAverage : null].filter((v) => v !== null)
  if (signals.length === 0) return 'unknown'
  if (signals.every((v) => v < 0)) return 'early'
  if (signals.every((v) => v > 0)) return 'late'
  return 'ontime'
}

/** 到达那一句：按早晚分档，每档三个说法轮换。 */
function arrivalLine(stamp, verdict, seed) {
  const at = stamp === '' ? '到工位了' : `${stamp} 到`
  const pool =
    verdict === 'early'
      ? [`${at}，比平常都利索。`, `${at}，今天起得比往常早。`, `${at}，这节奏可以。`]
      : verdict === 'late'
        ? [
            `${at}，比平常晚一点，来了就算数。`,
            `${at}，晚一点没关系，先挑一件小的开始。`,
            `${at}，坐下先把最要紧的那件拿起来。`,
          ]
        : verdict === 'ontime'
          ? [`${at}，跟平常一个节奏。`, `${at}，准点坐下。`, `${at}，稳。`]
          : [`${at}。`, `${at}，坐下了。`, '打卡成功，新的一天。']
  return pickRotating(pool, seed)
}

/** 连击逢 5 的整数天多给一句；其余返回 null（用普通的「连续第 N 个工作日」）。 */
function milestoneText(current) {
  if (current < 5 || current % 5 !== 0) return null
  return `连续第 ${current} 个工作日，这条线还没断。`
}

/**
 * 生成一句鼓励/提醒。两条口径同时说，措辞按有没有历史分岔：
 * 只有基准线时不能说「比以往」——第一天谈「以往」是假话。
 */
function checkinSentence(minutes, comparison, streak = null) {
  const stamp = fmtMin(minutes)
  const tail = streak === null ? '' : streakTail(streak)
  if (comparison === null) {
    return `打卡成功 · ${stamp}。${tail}`
  }
  const { baseline, average, vsBaseline, vsAverage, historyCount } = comparison
  const hasAverage = average !== null && historyCount > 0
  const signals = [vsBaseline, hasAverage ? vsAverage : null].filter((v) => v !== null)
  const allEarly = signals.length > 0 && signals.every((v) => v < 0)
  const allLate = signals.length > 0 && signals.every((v) => v > 0)
  const reference = hasAverage ? '你最近的平均' : '基准线'
  const lead = allEarly
    ? `今天 ${stamp} 到，比${reference}都早，状态在线。`
    : allLate
      ? `今天 ${stamp} 到，比${reference}晚一点，坐下了就先做最要紧的那件。`
      : `今天 ${stamp} 到，跟${reference}差不多。`
  const parts = []
  if (vsBaseline !== null) parts.push(`基准 ${fmtMin(baseline)}，你${deltaWords(vsBaseline)}`)
  if (hasAverage) parts.push(`近 ${historyCount} 次平均 ${fmtMin(average)}，你${deltaWords(vsAverage)}`)
  const detail = parts.length > 0 ? `（${parts.join('；')}）` : ''
  const firstNote = hasAverage ? '' : ' 今天是基准线第一次生效，攒够几次打卡后我会开始跟你的平均比。'
  return `${lead}${detail}${firstNote}${tail}`
}

/**
 * 打卡语音文案：一句像人说的话，不是报表。
 *
 * 三块料，按信息量优先：① 几点到的（按早晚分档、说法按天轮换）② 连击（逢 5 的整数天换句庆祝）
 * ③ 一句「钩子」——上一个工作日你写下的打算，或者池子里还欠的东西。
 *
 * 钩子由调用方算好传进来（要读 store 和历史），这里只管拼。
 * 完整的基准线 / 平均 / 连续明细留在 checkinSentence（对话工具的返回值里看得到）——
 * 那段念出来像念表格，反而没动力。
 */
export function checkinVoiceText(result, options = {}) {
  if (!result.fresh) return '今天已经打过卡啦，别贪心，去忙吧～'

  const { hook = '', seed = 0 } = options ?? {}
  const stamp = result.minutes === undefined ? '' : fmtMin(result.minutes)
  const streak = result.streak
  const current = streak?.current ?? 0

  let head = arrivalLine(stamp, result.verdict, seed)
  if (current >= 2) head += milestoneText(current) ?? `连续第 ${current} 个工作日。`

  return hook === '' ? head : `${head}\n${hook}`
}

/* ────────────────────────── 周报统计 ────────────────────────── */

function weekStats(store, today) {
  const start = weekStartOf(today)
  const days = []
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const key = dateKeyOf(d)
    const entry = dayEntry(store, key)
    days.push({
      key,
      date: d,
      weekday: i + 1,
      weekend: isWeekend(d),
      future: d.getTime() > today.getTime(),
      checkin: entry.checkin,
      minutes: parseHm(entry.checkin),
      entries: entry.entries,
      thoughts: entry.thoughts,
    })
  }
  const worked = days.filter((d) => !d.weekend && !d.future)
  const attended = worked.filter((d) => d.minutes !== null)
  const timed = attended.map((d) => d.minutes)
  const avg = timed.length === 0 ? null : Math.round(timed.reduce((a, b) => a + b, 0) / timed.length)
  const earliest = attended.length === 0 ? null : attended.reduce((a, b) => (a.minutes <= b.minutes ? a : b))
  const latest = attended.length === 0 ? null : attended.reduce((a, b) => (a.minutes >= b.minutes ? a : b))
  // 出勤只数工作日，学习和感想保留本周所有已发生记录，包括周末。
  const recorded = days.filter((d) => !d.future)
  const entryCount = recorded.reduce((sum, d) => sum + d.entries.length, 0)
  const thoughtCount = recorded.reduce((sum, d) => sum + d.thoughts.length, 0)
  // 本周最长连击：只在「已过去的工作日」里数，避免把未来几天算进来
  let weekRun = 0
  let weekBest = 0
  for (const day of worked) {
    weekRun = day.minutes === null ? 0 : weekRun + 1
    if (weekRun > weekBest) weekBest = weekRun
  }
  return {
    start,
    startKey: dateKeyOf(start),
    days,
    worked: worked.length,
    attended: attended.length,
    avg,
    earliest,
    latest,
    entryCount,
    thoughtCount,
    weekBest,
    plansDone: plansDoneInWeek(store, days),
    plansOpen: Array.isArray(store.plans) ? store.plans.filter((p) => !p.done).length : 0,
    plansAdded: Array.isArray(store.plans)
      ? store.plans.filter((p) => days.some((d) => d.key === dateKeyOf(new Date(p.createdAt)))).length
      : 0,
    streak: streakInfo(store, today),
  }
}

/** 本周划掉的计划条目（按 doneDay 落在本周）。 */
function plansDoneInWeek(store, days) {
  const keys = new Set(days.map((d) => d.key))
  return (Array.isArray(store.plans) ? store.plans : []).filter((p) => p.done && p.doneDay && keys.has(p.doneDay))
}

function weekMarkdown(store, today) {
  const stats = weekStats(store, today)
  const lines = []
  lines.push(`# 本周工位周报（${stats.startKey} 起）`)
  lines.push('')
  lines.push(`- 应到 ${stats.worked} 天，实到 ${stats.attended} 天`)
  if (stats.avg !== null) lines.push(`- 平均到达 ${fmtMin(stats.avg)}`)
  if (stats.earliest !== null)
    lines.push(`- 最早 ${stats.earliest.checkin}（${stats.earliest.key}），最晚 ${stats.latest.checkin}（${stats.latest.key}）`)
  lines.push(`- 学习记录 ${stats.entryCount} 条，感想 ${stats.thoughtCount} 条`)
  if (stats.plansDone.length > 0 || stats.plansOpen > 0) {
    lines.push(`- 想学的池子：本周划掉 ${stats.plansDone.length} 条，新丢进 ${stats.plansAdded} 条，还欠 ${stats.plansOpen} 条`)
  }
  if (stats.streak.total > 0) {
    lines.push(`- ${streakLine(stats.streak)}`)
    if (stats.weekBest > 1) lines.push(`- 本周最长连击 ${stats.weekBest} 个工作日`)
  }
  lines.push('')
  lines.push('## 每日')
  for (const day of stats.days) {
    if (day.future || (day.weekend && day.entries.length === 0 && day.thoughts.length === 0)) continue
    const head = `### ${day.key} ${WEEKDAY_NAMES[day.weekday - 1]}`
    lines.push(head)
    lines.push(`- 到达：${day.checkin ?? '未打卡'}`)
    if (day.entries.length === 0) lines.push('- 记录：（空）')
    for (const item of day.entries) lines.push(`- ${item.at ?? ''} ${item.text}`)
    for (const item of day.thoughts) lines.push(`- 感想：${item.text}`)
    lines.push('')
  }
  if (stats.plansDone.length > 0 || stats.plansOpen > 0) {
    lines.push('## 想学的')
    lines.push('')
    if (stats.plansDone.length > 0) {
      lines.push('本周划掉：')
      for (const plan of stats.plansDone) lines.push(`- ✓ ${plan.text}（${plan.doneDay}）`)
      lines.push('')
    }
    if (stats.plansOpen > 0) {
      lines.push(`还欠 ${stats.plansOpen} 条：`)
      const open = (Array.isArray(store.plans) ? store.plans : [])
        .filter((p) => !p.done)
        .sort((a, b) => a.createdAt - b.createdAt)
      for (const plan of open.slice(0, 15)) lines.push(`- ○ ${plan.text}`)
      if (open.length > 15) lines.push(`- ……还有 ${open.length - 15} 条`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * 公众号版周报：段落成文，不是统计表。
 *
 * 公众号的人不会去读「应到 5 实到 4」这种表，所以这里把同一批数据重新组织成
 * 有人称、有转折的叙述，并把当周学到的、想到的原样织进去——生成的是可直接发出去的
 * 草稿，不是最终稿；模型拿到后可以按自己的语气再改。
 */
function weekArticle(store, today) {
  const stats = weekStats(store, today)
  const lines = []
  const attendedDays = stats.days.filter((d) => !d.weekend && !d.future && d.minutes !== null)
  const entryDays = stats.days.filter((d) => !d.future && d.entries.length > 0)
  const thoughtDays = stats.days.filter((d) => !d.future && d.thoughts.length > 0)

  lines.push(`# 这周在工位的 ${stats.attended} 天`)
  lines.push('')

  // 开场：只讲能站得住的事实，没有数据就不硬凑
  if (stats.avg === null) {
    lines.push(`这一周应到 ${stats.worked} 天，一次卡都没打。` +
      '不必自我批评，把它记下来就好——下周从第一天开始。')
  } else {
    const arrivalTone =
      stats.avg <= 9 * 60
        ? '这个时间还算体面，至少是在上午把自己按到椅子上。'
        : '这个时间不算早，但重要的是来了。'
    lines.push(
      `这一周应到 ${stats.worked} 天，我在工位坐了 ${stats.attended} 天，平均 ${fmtMin(stats.avg)} 到。` +
      arrivalTone +
      (stats.earliest !== null && stats.earliest.key !== stats.latest.key
        ? `最早是${WEEKDAY_NAMES[stats.earliest.weekday - 1]}的 ${stats.earliest.checkin}，最晚是${WEEKDAY_NAMES[stats.latest.weekday - 1]}的 ${stats.latest.checkin}。`
        : ''),
    )
  }
  lines.push('')

  // 学到的：按天铺开，保留原始措辞
  if (entryDays.length > 0) {
    lines.push('## 学到的')
    lines.push('')
    for (const day of entryDays) {
      lines.push(`**${WEEKDAY_NAMES[day.weekday - 1]}**`)
      lines.push('')
      for (const item of day.entries) lines.push(`- ${item.text}`)
      lines.push('')
    }
  }

  // 想到的：感想原样保留，这是周报里最像人的部分
  if (thoughtDays.length > 0) {
    lines.push('## 想到的')
    lines.push('')
    for (const day of thoughtDays) {
      for (const item of day.thoughts) lines.push(`> ${item.text}`)
      lines.push('')
      lines.push(`——${WEEKDAY_NAMES[day.weekday - 1]}`)
      lines.push('')
    }
  }

  if (entryDays.length === 0 && thoughtDays.length === 0) {
    lines.push('## 学到的')
    lines.push('')
    lines.push('这一周没有留下任何学习记录。数据是空的，但我还记得自己在忙什么——' +
      '下笔这件事，下周补上。')
    lines.push('')
  }

  // 「想学的」不在这里单列：划掉时已经写进当天 entries 了，成文版再列一遍就是重复
  // 收尾：不写空话，给一句可执行的
  lines.push('## 下周')
  lines.push('')
  const { streak } = stats
  const streakStep =
    streak.current >= 3
      ? `连续 ${streak.current} 天了，下周最要紧的是别把这个数断掉——哪怕只来半天，也打个卡。`
      : streak.best >= 3 && streak.current < streak.best
        ? `之前最长连过 ${streak.best} 个工作日，现在从 ${streak.current} 重新起。不用回到那个数，先连到三天。`
        : ''
  const nextStep = streakStep !== ''
    ? streakStep
    : stats.avg === null
      ? '先不管早晚，把每天的「到了」和「学了什么」记下来。'
      : stats.attended < stats.worked
        ? `这周到 ${stats.attended}/${stats.worked} 天，下周先补齐出勤，再说时间。`
        : stats.plansOpen >= 5
          ? `想学的池子里还压着 ${stats.plansOpen} 条，下周挑两条把它划掉——留着不看的清单只是清单。`
          : '出勤是稳的，下一步是把记录写得更具体——写清「今天卡在哪、怎么通的」。'
  lines.push(nextStep)
  lines.push('')
  return lines.join('\n')
}

/* ────────────────────────── 桌宠 HTTP ────────────────────────── */

async function callPet(base, pathname, init) {
  if (base === null) return null
  try {
    const response = await fetch(base + pathname, {
      ...init,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, reason: 'bad-json', message: text.slice(0, 200) }
    }
  } catch (error) {
    return { ok: false, reason: 'network', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把一段话压成单行：气泡是 `white-space: normal` 的一段文本，换行会被折成空格，
 * 所以与其让浏览器乱折，不如我们自己在合适的位置断。
 */
function flatText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 句读优先截断：宁可短一截，也不要停在半句话中间。
 *
 * 旧实现是 `slice(0, N) + '…'`，一句「看 B 站黑马程序员的 AI 名词解释视频，了解了机器学习」
 * 会被锯成「…了解了机器学…」——读起来像坏掉了。这里先找最后一个句读（。！？；，、）再切。
 * 找不到合适断点时才硬切：说明这句话本身就很长，那也没办法。
 */
function clip(text, max = TEXT_MAX) {
  const flat = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n').trim()
  if (flat.length <= max) return flat
  const head = flat.slice(0, max - 1)
  // 句读后面跟着的引号/括号一起带上，视觉上才完整
  const lastBreak = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('、'),
    head.lastIndexOf('. '),
    head.lastIndexOf(', '),
  )
  // 断点太靠前（不到一半）就不用它：截出来的东西信息量太少，还不如硬切
  if (lastBreak >= Math.floor(max * 0.45)) return `${head.slice(0, lastBreak + 1)}…`
  return `${head}…`
}

/**
 * 气泡停留时长：按字数算，不是固定 14 秒。
 *
 * 固定值的问题是两头都不对——三行字晾 14 秒太久，满屏字 14 秒又读不完。
 * 按中文阅读速度（约 5 字/秒）给，再留 4 秒反应时间，钳在 6~22 秒之间。
 */
function bubbleDuration(text) {
  const chars = flatText(text).length
  const ms = 4000 + chars * 200
  return Math.min(22_000, Math.max(6000, Math.round(ms / 500) * 500))
}

/* ────────────────────────── 插件主体 ────────────────────────── */

export function apply(ctx) {
  const logger = ctx.logger
  const store = loadStore()
  let base = null
  let petId = store.config.petId || ''
  let disposed = false
  let lastTickMinute = ''
  /** 桌宠对话记忆槽的注销函数；null = 还没挂上（桌宠可能比插件晚加载）。 */
  let memoryDispose = null

  const log = (msg) => logger?.info?.(`[dsh-gongwei] ${msg}`)
  const warn = (msg) => logger?.warn?.(`[dsh-gongwei] ${msg}`)

  /**
   * 等某个服务就绪之后再注册。
   *
   * 本插件声明的是 `inject = []`：读盘、心跳、桌宠菜单都不依赖别的插件，
   * 没有界面的 profile 也要能跑。代价是 apply 会在服务就绪之前就执行完，
   * 早先这里用 `ctx.get(name, false)` 当场判断一次，服务晚一步就永久跳过——
   * 重启 DSH 后 tools/webServer 常常比本插件晚挂，结果整个会话里 gongwei
   * 工具都不存在（只有重载插件才恢复）。
   *
   * ctx.inject([...], cb) 会起一个带依赖声明的子 fiber：服务齐了才执行 cb，
   * 缺服务就静静挂着（不抛错），服务后到还会自动激活。子 fiber 跟着本插件
   * 一起卸载，注册的东西不会漏。
   */
  function whenService(names, label, setup) {
    ctx.inject(names, (scope) => {
      scope.effect(() => {
        const service = scope.get(names[0], false)
        if (!service) return () => {}
        return setup(service)
      }, label)
    })
  }

  // 仅提醒外发；不修改 DSH-IM 的全会话镜像设置。独立文件避免与主清单写入竞争。
  const imOptInFile = path.join(DATA_DIR, 'im-reminders-opt-in.json')
  const imNotifier = createImNotifier({
    getService: () => ctx.get('dshIm', false),
    getCandidate: () => imOptIn()?.candidate,
    configPath: path.join(DATA_DIR, 'im-reminders.json'),
    statusPath: path.join(DATA_DIR, 'im-reminders-status.json'),
    log: (message) => warn(`IM: ${message.code}`),
  })
  function imOptIn() {
    try { return JSON.parse(fs.readFileSync(imOptInFile, 'utf8')) } catch { return null }
  }
  function claimImTest(field) {
    const opt = imOptIn()
    if (opt?.enabled !== true || opt[field] === true) return false
    try {
      const tmp = `${imOptInFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ ...opt, [field]: true }, null, 2), 'utf8')
      fs.renameSync(tmp, imOptInFile)
      return true
    } catch { return false }
  }
  async function notifyReminder(eventId, text) {
    if (imOptIn()?.enabled !== true || disposed) return
    // IM 持久化幂等成功后才弹测试气泡，避免每分钟重复。
    const result = await imNotifier.send(eventId, text)
    if (!result.duplicate) await say(text)
  }
  async function notifyDueTodos(todos) {
    const opt = imOptIn()
    if (opt?.enabled !== true) return
    const now = Date.now()
    for (const todo of todos) {
      const due = todo.dueAt
      // 不补发启用之前的历史过期任务，避免刚接通就轰炸手机。
      if (todo.done || typeof due !== 'number' || due < opt.enabledAt) continue
      const left = due - now
      if (left > 15 * 60_000 || left < -60_000) continue
      const stage = left > 0 ? 'ahead15' : 'due'
      const title = String(todo.text ?? '').replace(/^\[想学\]\s*/, '').slice(0, 100)
      const text = stage === 'ahead15'
        ? `小鱼提醒：${title}，将在 ${hmOf(new Date(due))} 到期。方便的话现在收个尾吧。`
        : `小鱼提醒：${title}，到时间啦。做完可以在桌宠待办里勾掉。`
      await imNotifier.send(`todo:${todo.id}:${due}:${stage}`, text)
    }
  }

  /** 解析桌宠 HTTP 基址：优先 webServer 的 origin，退化为环境变量。 */
  function resolveBase() {
    const web = ctx.get('webServer', false)
    if (web && typeof web.getOrigin === 'function') {
      try {
        const origin = web.getOrigin()
        if (typeof origin === 'string' && origin !== '') return origin.replace(/\/$/, '')
      } catch {
        /* listen 之前会抛：下面走兜底 */
      }
    }
    const envOrigin = process.env.DSH_WEB_ORIGIN ?? process.env.BILI_DSH_ORIGIN
    return envOrigin ? envOrigin.replace(/\/$/, '') : null
  }

  async function ensurePet() {
    if (base === null) base = resolveBase()
    if (petId !== '') return petId
    const config = await callPet(base, PET_CONFIG_PATH, { method: 'GET' })
    if (config && typeof config === 'object') {
      const ids = Object.keys(config).filter((k) => k !== 'ok' && k !== 'reason')
      if (ids.length > 0) {
        petId = ids[0]
        store.config.petId = petId
        saveStore(store)
        return petId
      }
    }
    return ''
  }

  /** 让桌宠弹一句话。失败（睡觉/没显示/没宠物）静默——打卡数据已经落盘，播报是锦上添花。 */
  async function say(text) {
    const id = await ensurePet()
    if (id === '') return
    // surface=any：宿主会拿它跟宠物的实际 display 比对，不匹配就整条拒掉（pet-not-displayed）。
    // 我们不知道也不关心它此刻显示在哪一端，所以只能要 any。
    const result = await callPet(
      base,
      `${BROADCAST_PATH}?pet=${encodeURIComponent(id)}&surface=any`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: clip(text), duration: bubbleDuration(text) }),
      },
    )
    if (result?.ok === false) log(`broadcast skipped: ${result.reason} ${result.message ?? ''}`)
  }

  /**
   * 让桌宠「出声」说一句：走 broadcast 的 speak 开关 + 明确 surface。
   *
   * 宿主规则（src/host/routes/interaction.ts:151-159）：只有 `speak:true` 且 surface 能映射到
   * 某一端（web/desktop）时，才会在 pets.<id>.say 上写 voiceTo，消费端据此用克隆音色念出 text。
   * surface=any/both 映射不到具体端 → 不写 voiceTo → 只弹气泡不出声（这正是普通 say 的行为）。
   *
   * 这里选 desktop 是因为 gongwei 绑定的宠物（main/小鱼）display=desktop，显示门禁放行。
   * 用失败回退：万一 voiceTo 那次被拒（例如宠物临时切到别处），再发一次普通气泡，保证话不丢。
   */
  async function sayWithVoice(text, voiceSurface = 'desktop') {
    const id = await ensurePet()
    if (id === '') return
    const speakBody = { text: clip(text), duration: bubbleDuration(text), speak: true }
    const result = await callPet(
      base,
      `${BROADCAST_PATH}?pet=${encodeURIComponent(id)}&surface=${encodeURIComponent(voiceSurface)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(speakBody) },
    )
    if (result?.ok === false) {
      log(`voice broadcast skipped (${result.reason} ${result.message ?? ''}); falling back to plain bubble`)
      await say(text)
    }
  }

  /* ── 想学的池子 ⇄ 桌宠待办：双向合并 ── */

  /**
   * 一份清单、两处可见：gongwei 的 state.json 是唯一真相源，桌宠「待办事项」是它的投影。
   *
   * 为什么要双向：用户大部分时间在桌宠右键里勾待办，也可能直接在那儿改文字/改时间；
   * 只做单向投影的话，那边的改动就丢了。所以每次同步都比对「我们上次写下去的样子」（echo）：
   * - 哪边相对 echo 变了，就以那边为准推给另一边；两边都变了时以 gongwei 为准（真相源）。
   * - 带 TODO_MARK 的才是我们管的投影，用户自己加的原生待办一个字都不碰。
   *
   * echo 记在 meta.todoMap[planId] 里（id/text/dueAt/done/updatedAt），跨重启也在，
   * 这样「用户改过」和「我们只是提醒过（只动 lastRemindedAt，不动 updatedAt）」能分清。
   */
  let syncTimer = null
  let syncing = false

  function markedText(text) {
    // 幂等：正文若已经带过标记（历史脏数据 / 重复导入留下的 [想学]），先全部剥掉再加一次，
    // 保证任何路径都不会产生 [想学] [想学] … 的叠前缀。
    return (TODO_MARK + unmarkedText(String(text ?? ''))).slice(0, TODO_TEXT_MAX)
  }
  function unmarkedText(text) {
    const s = typeof text === 'string' ? text : String(text ?? '')
    // 反复剥：兼容已经叠了两三层标记的旧数据
    let out = s
    while (out.startsWith(TODO_MARK)) out = out.slice(TODO_MARK.length)
    return out
  }
  function todoMap() {
    if (!store.meta || typeof store.meta !== 'object') store.meta = {}
    if (!store.meta.todoMap || typeof store.meta.todoMap !== 'object') store.meta.todoMap = {}
    return store.meta.todoMap
  }
  function writeEcho(planId, todo) {
    if (!todo || typeof todo.id !== 'string') return
    todoMap()[planId] = {
      id: todo.id,
      text: todo.text,
      dueAt: todo.dueAt ?? null,
      done: todo.done === true,
      updatedAt: Number(todo.updatedAt) || 0,
    }
  }

  /** 防抖：一次动作（可能连着加好几条）只触发一次同步，避免一堆并发 POST。 */
  function scheduleSync() {
    if (disposed || syncing) return
    if (syncTimer !== null) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = null
      void syncWithPetTodos()
    }, 1200)
  }

  /** 把桌宠端用户的改动写回 plan。done 的切换走 finishPlan/reopenPlan，好把学习记录一起带上。 */
  function applyTodoToPlan(plan, todo) {
    // 先落文字/截止，再切完成状态：finishPlan 写学习记录用的是当时的 plan.text，
    // 顺序反了就会把「改名 + 勾完成」这一次的记录写成旧名字。
    const clean = unmarkedText(todo.text).trim().replace(/\s+/g, ' ').slice(0, PLAN_TEXT_MAX)
    if (clean !== '' && clean !== plan.text) plan.text = clean
    const due = Number(todo.dueAt)
    const nextDue = todo.dueAt === null || !Number.isFinite(due) ? null : due
    if (nextDue !== plan.dueAt) plan.dueAt = nextDue
    const now = new Date()
    if (todo.done === true && plan.done !== true) {
      finishPlan(plan.id, now)
    } else if (todo.done === false && plan.done === true) {
      reopenPlan(plan.id)
    }
  }

  async function syncWithPetTodos() {
    if (syncing) return
    if (base === null) base = resolveBase()
    if (base === null) {
      // webServer 还没 listen、环境变量也没给：等下一次心跳再试，别丢数据
      return
    }
    syncing = true
    try {
      const listed = await callPet(base, TODOS_PATH, { method: 'GET' })
      if (!listed || listed.ok !== true || !Array.isArray(listed.todos)) return
      void notifyDueTodos(listed.todos).catch(() => warn('IM: TODO_NOTIFY_FAILED'))
      const byId = new Map()
      for (const t of listed.todos) if (t && typeof t.id === 'string') byId.set(t.id, t)
      const map = todoMap()
      const headers = { 'content-type': 'application/json' }
      let touched = false

      // 1) 已有映射：比对 echo，决定哪边新
      //    删除先攒起来、循环后再统一做——边遍历 store.plans 边 splice 会漏掉后面那条。
      const gonePlanIds = new Set()
      for (const plan of store.plans) {
        const echo = map[plan.id]
        if (!echo || typeof echo !== 'object') continue
        const todo = byId.get(echo.id)
        if (!todo) {
          // 桌宠端那条被删了 = 用户从这唯一的清单里划掉了 → plan 也跟着删
          delete map[plan.id]
          gonePlanIds.add(plan.id)
          touched = true
          continue
        }
        const petEdited =
          todo.text !== echo.text ||
          (todo.dueAt ?? null) !== echo.dueAt ||
          (todo.done === true) !== echo.done
        const planEdited =
          markedText(plan.text) !== echo.text ||
          (plan.dueAt ?? null) !== echo.dueAt ||
          (plan.done === true) !== echo.done
        if (planEdited) {
          // gongwei 是真相源：推到桌宠
          const patched = await callPet(
            base,
            `${TODOS_PATH}/${encodeURIComponent(echo.id)}`,
            {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ text: markedText(plan.text), dueAt: plan.dueAt, done: plan.done }),
            },
          )
          if (patched?.ok && patched.todo) {
            writeEcho(plan.id, patched.todo)
            touched = true
          }
        } else if (petEdited) {
          // 桌宠端用户改过：写回 plan
          applyTodoToPlan(plan, todo)
          writeEcho(plan.id, todo)
          touched = true
        }
      }

      if (gonePlanIds.size > 0) {
        store.plans = store.plans.filter((p) => !gonePlanIds.has(p.id))
      }

      // 1.5) 桌宠端新建的待办：
      //      (a) 带 [想学] 标记、但没有映射、也不是下面某条 plan 的同文收养对象
      //          = 用户直接在待办面板里加的想学项 → 吸收入池子。
      //      (b) 原生待办（无标记）且没有 dueAt：按用户的口径「没设截止=想学，设了截止=限期交作业」
      //          自动收进池子，并给它补上 [想学] 标记，让两边一眼能对上。
      //          带 dueAt 的原生待办是限期任务，一个字不碰。
      //          config.adoptUntimedTodos=false 可退回老行为（原生待办一律不碰）。
      const ownedTodoIds = new Set(Object.values(map).map((e) => e?.id).filter(Boolean))
      const claimedTexts = new Set(store.plans.map((p) => p.text))
      const adoptUntimed = store.config?.adoptUntimedTodos !== false
      for (const todo of listed.todos) {
        if (!todo || typeof todo.id !== 'string') continue
        if (ownedTodoIds.has(todo.id)) continue
        if (typeof todo.text !== 'string') continue
        const marked = todo.text.startsWith(TODO_MARK)
        if (!marked && !adoptUntimed) continue
        // 限期任务（有 dueAt）且非我们管的：绝不收编
        if (!marked && todo.dueAt !== null && todo.dueAt !== undefined) continue
        const clean = unmarkedText(todo.text).trim().replace(/\s+/g, ' ')
        if (clean === '' || claimedTexts.has(clean)) continue
        // 再兜一层：这条待办会不会就是某条 plan 的投影，只是 echo 丢了（例如旧版本
        // 没写映射、或导入时正文带了标记导致对不上）？同文就收养它、补回映射，
        // 绝不再 addPlan 造一条新计划——这正是「搬过来」点两次池子翻倍的根因。
        const sameTextPlan = store.plans.find((p) => p.text === clean)
        if (sameTextPlan) {
          writeEcho(sameTextPlan.id, todo)
          claimedTexts.add(clean)
          ownedTodoIds.add(todo.id)
          touched = true
          continue
        }
        // dueAt 用毫秒直接建（addPlan 的 dueRaw 也吃 number）；原生无期限项这里就是 null
        const added = addPlan(clean, new Date(), 'pet-todo', todo.dueAt ?? null)
        if (!added.ok || !added.plan) continue
        // 给原生待办补上标记，免得下一轮又被当没管的原生项重复吸收；
        // 有标记的那版本来就带着标记，这里一并统一成 markedText 的样子。
        const wantedText = markedText(clean)
        let echoTodo = todo
        if (todo.text !== wantedText) {
          const patched = await callPet(
            base,
            `${TODOS_PATH}/${encodeURIComponent(todo.id)}`,
            { method: 'PATCH', headers, body: JSON.stringify({ text: wantedText, dueAt: todo.dueAt ?? null }) },
          )
          if (patched?.ok && patched.todo) echoTodo = patched.todo
        }
        writeEcho(added.plan.id, echoTodo)
        claimedTexts.add(clean)
        ownedTodoIds.add(todo.id)
        touched = true
        log(`adopted untodo "${clean.slice(0, 20)}" into pool`)
      }

      // 2) 没有映射的 plan：先找同文的原生待办「收养」（首次合并时池子是从待办导进来的，
      //    两边文字一样但没建立映射；不收养就会 POST 出一批重复项），找不到才新建。
      //    这样含没有截止时间的池子项也都投影过去，桌宠那边才是完整的一份清单。
      const claimedIds = new Set()
      for (const plan of store.plans) {
        if (map[plan.id]) continue
        const wanted = markedText(plan.text)
        let adopted = null
        for (const todo of listed.todos) {
          if (!todo || typeof todo.id !== 'string' || claimedIds.has(todo.id)) continue
          if (typeof todo.text !== 'string') continue
          if (unmarkedText(todo.text).trim().replace(/\s+/g, ' ') !== plan.text) continue
          adopted = todo
          break
        }
        if (adopted) {
          claimedIds.add(adopted.id)
          // 给收养的待办补上标记、对齐截止时间，免得下一轮又被当原生待办
          if (adopted.text !== wanted || (adopted.dueAt ?? null) !== plan.dueAt) {
            const patched = await callPet(
              base,
              `${TODOS_PATH}/${encodeURIComponent(adopted.id)}`,
              { method: 'PATCH', headers, body: JSON.stringify({ text: wanted, dueAt: plan.dueAt }) },
            )
            if (patched?.ok && patched.todo) {
              writeEcho(plan.id, patched.todo)
              touched = true
            } else {
              writeEcho(plan.id, adopted)
            }
          } else {
            writeEcho(plan.id, adopted)
          }
          continue
        }
        const created = await callPet(base, TODOS_PATH, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: wanted, dueAt: plan.dueAt }),
        })
        if (created?.ok && created.todo) {
          writeEcho(plan.id, created.todo)
          claimedIds.add(created.todo.id)
          touched = true
        }
      }

      // 3) 映射还在、但 plan 已经没了：把桌宠那条投影也删掉
      for (const [planId, echo] of Object.entries(map)) {
        if (!echo || typeof echo !== 'object') continue
        if (store.plans.some((p) => p.id === planId)) continue
        await callPet(base, `${TODOS_PATH}/${encodeURIComponent(echo.id)}`, { method: 'DELETE' })
        delete map[planId]
        touched = true
      }

      if (touched) saveStore(store)
    } finally {
      syncing = false
    }
  }

  /* ── 桌宠对话的工位记忆（petApi7340.memory）── */

  /**
   * 给桌宠对话润一句「今天工位发生了什么」。
   *
   * 桌宠的对话弹窗没有文本种子参数，插件没法往输入框里塞字；唯一能影响它的是
   * `petApi7340.memory.recall`——对话前改写 system。所以这里不是「把周报推过去」，
   * 而是让小鱼知道你今天几点到、学了什么，它自己会顺着这个聊。
   */
  function memoryDigest(now = new Date()) {
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    const stats = weekStats(store, now)
    const parts = [entry.checkin === null ? '今天还没打卡' : `今天 ${entry.checkin} 到工位`]
    if (entry.entries.length > 0) {
      parts.push(`今天学了：${entry.entries.slice(-3).map((item) => item.text).join('；')}`)
    }
    if (entry.thoughts.length > 0) {
      parts.push(`今天的感想：${entry.thoughts.slice(-2).map((item) => item.text).join('；')}`)
    }
    if (stats.avg !== null) parts.push(`本周到 ${stats.attended}/${stats.worked} 天，平均 ${fmtMin(stats.avg)}`)
    if (stats.streak.total > 0) parts.push(streakLine(stats.streak).replace(/。$/, ''))
    return parts.join('；')
  }

  /**
   * 工位档案的正文行——系统提示词段落与桌宠对话记忆共用这一份。
   *
   * 为什么要共用：这两处原本各写一套文案，改一边忘一边就会出现「DSH 里知道、
   * 桌宠里不知道」的分裂。桌宠对话的记忆本来就只有一个入口（recall 改写 system），
   * 所以它看到的事实必须和 DSH 会话里那段「## 工位打卡与学习记录」是同一份。
   */
  function memoryFacts(now = new Date()) {
    const key = dateKeyOf(now)
    const today = dayEntry(store, key)
    const stats = weekStats(store, now)
    const history = recentCheckins(store, key, 5)
    const lines = []
    // 稳定画像先放，这是用户要求长期记住、每轮都该带着的东西
    const prof = store.profile
    if (prof && (prof.assistantName || (Array.isArray(prof.lines) && prof.lines.length > 0))) {
      lines.push('### 关于用户（长期记住）')
      if (prof.assistantName) lines.push(`- 用户给助手起名「${prof.assistantName}」，对话中可用这个名字自称。`)
      for (const line of prof.lines ?? []) lines.push(`- ${line}`)
    }
    lines.push(
      `- 今天（${key}）：${today.checkin === null ? '未打卡' : today.checkin + ' 打卡'}，学习记录 ${today.entries.length} 条，感想 ${today.thoughts.length} 条`,
    )
    if (today.entries.length > 0) {
      for (const item of today.entries.slice(-3)) lines.push(`  - ${item.text}`)
    }
    if (today.thoughts.length > 0) {
      for (const item of today.thoughts.slice(-2)) lines.push(`  - 感想：${item.text}`)
    }
    if (history.length > 0) {
      lines.push(`- 最近几次打卡：${history.map((h) => `${h.key} ${fmtMin(h.minutes)}`).join('，')}`)
    } else {
      lines.push('- 还没有历史打卡。')
    }
    if (stats.streak.total > 0) lines.push(`- 连续：${streakLine(stats.streak)}`)
    lines.push(
      stats.avg === null
        ? `- 本周：应到 ${stats.worked} 天，尚无打卡数据`
        : `- 本周：到 ${stats.attended}/${stats.worked} 天，平均 ${fmtMin(stats.avg)}，记录 ${stats.entryCount} 条，感想 ${stats.thoughtCount} 条`,
    )
    // 池子只报「欠着几条 + 最上面三条」，不把清单整个塞进上下文（那是用户的素材，不是每轮都要看的）
    const openPlans = sortedPlans().filter((p) => !p.done)
    if (openPlans.length > 0) {
      lines.push(`- 想学的池子：还欠 ${openPlans.length} 条，最上面几条：`)
      for (const plan of openPlans.slice(0, 3)) lines.push(`  - ${plan.text}`)
      if (openPlans.length > 3) lines.push(`  - ……还有 ${openPlans.length - 3} 条`)
    } else if (store.plans.length > 0) {
      lines.push(`- 想学的池子：空的（已划掉 ${store.plans.length} 条）。`)
    }
    return lines
  }

  /**
   * 桌宠自己的对话流水。
   *
   * dsh-pet 原生只把最近 `chatMemoryRounds` 轮（本机 10）喂给模型，更早的直接被
   * sliceMemoryRounds 切掉——所以隔一天再聊，它就「不记得」了。这里独立存一份
   * jsonl，用 recall 主动回放最近若干轮，把原生那 10 轮的天花板绕开。
   * 只写这个文件，不写学习记录：桌宠的闲聊不该等于「今天学了什么」。
   */
  const PET_CHAT_FILE = path.join(DATA_DIR, 'pet-chat.jsonl')
  const PET_CHAT_MAX_BYTES = 512 * 1024

  function rememberPetTurn(turn) {
    const row = {
      ts: typeof turn?.ts === 'number' ? turn.ts : Date.now(),
      user: typeof turn?.userText === 'string' ? turn.userText : '',
      reply: typeof turn?.replyText === 'string' ? turn.replyText : '',
      ...(typeof turn?.action === 'string' ? { action: turn.action } : {}),
    }
    if (row.user === '' && row.reply === '') return
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.appendFileSync(PET_CHAT_FILE, `${JSON.stringify(row)}\n`)
      // 只防无限增长：超了就把前半截扔掉（保留后一半，够回放）
      const size = fs.statSync(PET_CHAT_FILE).size
      if (size > PET_CHAT_MAX_BYTES) {
        const tail = fs.readFileSync(PET_CHAT_FILE, 'utf8').slice(-Math.floor(PET_CHAT_MAX_BYTES / 2))
        const from = tail.indexOf('\n')
        fs.writeFileSync(PET_CHAT_FILE, from >= 0 ? tail.slice(from + 1) : tail)
      }
    } catch {
      // 记忆丢了不该让这一轮回复失败
    }
  }

  /** 取最近 limit 轮桌宠对话；文件坏了就当没有。 */
  function recentPetTurns(limit = 8) {
    try {
      const raw = fs.readFileSync(PET_CHAT_FILE, 'utf8')
      const rows = []
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line)
          if (row && typeof row.user === 'string') rows.push(row)
        } catch {
          // 半行（写一半断电）跳过
        }
      }
      return rows.slice(-limit)
    } catch {
      return []
    }
  }

  const MEMORY_ID = 'dsh-gongwei'

  /** 挂到桌宠的对话记忆槽上；桌宠可能比插件晚加载，所以每拍都试一次。 */
  function ensureMemoryProvider() {
    if (memoryDispose !== null) return true
    let api = null
    try {
      // ctx 是严格 getter：没有这个服务时会抛（不是返回 undefined），所以必须自己兜住
      api = ctx.get('petApi7340', true)
    } catch {
      return false
    }
    const memory = api?.memory
    if (!memory || typeof memory.register !== 'function') return false
    const listed = typeof memory.list === 'function' ? memory.list() : null
    const external = Array.isArray(listed?.external) ? listed.external : []
    if (external.includes(MEMORY_ID)) return true
    try {
      memoryDispose = memory.register({
        id: MEMORY_ID,
        recall(input) {
          // 只追加，不改人设与历史：桌宠原本怎么说话由 dsh-pet 决定，我们只补一块事实。
          // digest 用一行摘要（气泡/回复侧也需要它），facts 是全量档案 + 桌宠自己的历史回放。
          const digest = memoryDigest()
          const facts = memoryFacts()
          const turns = recentPetTurns(8)
          const blocks = []
          if (digest !== '') blocks.push(`【工位记录】${digest}。`)
          if (facts.length > 0) blocks.push(`【工位档案】\n${facts.join('\n')}`)
          if (turns.length > 0) {
            const said = turns
              .map((row) => {
                const you = row.user === '' ? '' : `用户：${row.user}`
                const me = row.reply === '' ? '' : `你：${row.reply}`
                return [you, me].filter((part) => part !== '').join('\n')
              })
              .join('\n')
            blocks.push(`【你们之前聊过（最近 ${turns.length} 轮，按时间正序）】\n${said}`)
          }
          if (blocks.length === 0) return undefined
          return {
            system: `${input.system}\n\n${blocks.join('\n\n')}\n\n（上面是 gongwei 插件维护的工位记忆，与 DSH 会话里那份是同一份数据，可以直接聊；不要编造里面没有的记录。）`,
          }
        },
        capture(turn) {
          // 桌宠聊完写一份到独立流水，下次 recall 回放；不写学习记录，避免把闲聊混进「今天学了什么」
          rememberPetTurn(turn)
        },
      })
      log('attached to pet chat memory')
      return true
    } catch (error) {
      warn(`memory attach failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /* ── 摘要：把长记录压成气泡放得下的一句话 ── */

  /**
   * 为什么需要摘要，而不是「把原文塞进气泡」：
   *
   * 气泡宽度由字体大小决定（本机约 253px、一行 14 字），高度由窗口上沿余量决定（约 9 行），
   * 所以它能装的东西是 110~120 字——一条几百字的记录，无论怎么排版都放不下。
   * 之前的实现是「取最近两条全文 + 硬截断到 220 字」，结果既超出了容量又被锯成半句，
   * 读到的是一段既不全也不像摘要的碎片。
   *
   * 所以分成两层：
   * - 气泡 = 摘要卡（每条压成一句人话 + 条数 + 总字数），回答「今天记了什么」这个问题；
   * - 设置页「今天」面板 = 全文（可滚动、可复制），回答「原文是怎么写的」。
   *
   * 摘要优先走模型（去掉口语和废话，这是用户明确要的），模型不可用时退化成
   * 「截第一句」的启发式——宁可粗糙也不报错，气泡是每日高频入口，不能靠运气。
   * 原文一个字都不改：它是周报和公众号的素材。
   */

  const SUMMARY_TIMEOUT_MS = 45_000
  /** 摘要缓存：键是「类型 + 内容指纹」。同一批记录反复点菜单，不该反复花 token。 */
  const summaryCache = new Map()
  /** 正在跑的摘要任务：同一批内容的并发请求共用一次模型调用。 */
  const summaryInFlight = new Map()
  const SUMMARY_CACHE_MAX = 200
  /** 单条摘要的字数上限。气泡总共就 120 字，一条占太多，别的就看不见了。 */
  const SUMMARY_LINE_MAX = 30

  function ready() {
    const now = new Date()
    return { now, key: dateKeyOf(now), entry: dayEntry(store, dateKeyOf(now)) }
  }

  /** 取一个可选服务：ctx 是严格 getter，服务缺失时会抛而不是返回 undefined。 */
  function softService(serviceName) {
    try {
      return ctx.get(serviceName, true) ?? null
    } catch {
      return null
    }
  }

  /** djb2：只要够散列就行，不需要抗碰撞。 */
  function fingerprint(text) {
    let hash = 5381
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
    return (hash >>> 0).toString(36)
  }

  /**
   * 一句人话：在句读处截断，不留半句。
   * 找不到句读（用户写了一段没有标点的长句）就在字数上限处收尾。
   */
  function firstClause(text, max = SUMMARY_LINE_MAX) {
    const flat = flatText(text)
    if (flat.length <= max) return flat.replace(/[。！？；，、]+$/, '')
    const head = flat.slice(0, max)
    const sentence = head.search(/[。！？；]/)
    if (sentence >= 8) return head.slice(0, sentence)
    const comma = head.search(/[，、]/)
    if (comma >= 10) return head.slice(0, comma)
    return `${head.slice(0, max - 1)}…`
  }

  /** 模型摘要：一次请求压完全部条目，按编号对回原文，对不上的单条降级。 */
  async function summarizeWithModel(items, kindLabel) {
    const llm = softService('llm')
    if (!llm || typeof llm.stream !== 'function') return null
    const modelCfg = softService('agentDefaultModel')
    let sel = null
    try {
      sel = typeof modelCfg?.currentSelection === 'function' ? modelCfg.currentSelection() : null
    } catch {
      sel = null
    }
    if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') return null

    // 只问模型它擅长的事：压缩表达。要求带编号，是因为它偶尔会把两条并成一条，
    // 那样按顺序配就全错位了；带编号至少能保住对上的那些，剩下的退回启发式。
    const system =
      '你在帮一个人整理他自己写的工位学习记录。下面每一条前面有一个编号。' +
      '把每一条压成一句中文短句，不超过 24 个字：保留具体名词、数字和结论，' +
      '删掉口头语、语气词、重复和自我安慰。' +
      '只能用原文里出现过的信息，不要补充、不要推测、不要脑补原文没提到的计划和日期。' +
      '只输出这些短句，一行一条，每行以「编号|短句」的形式开头，例如「3|把 RetNet 的 cache 机制搞明白」。' +
      '不要合并条目，不要解释，不要输出别的字。'
    const userText = items.map((item, index) => `[${index + 1}] ${flatText(item.text)}`).join('\n')

    // 不 import @deepseek-ai/dsh-llm：那个包不在插件的解析范围内。
    // messages 用纯对象手拼（RequestUserInput 的 id/source 可省略），chunk 自己收集。
    const options = {
      provider: sel.provider,
      model: sel.model,
      // 调用身份：适配器据此生成服务商载体，缺它个别路由会拒
      sessionId: 'dsh-gongwei',
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      system,
      temperature: 0.3,
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    }
    let text = ''
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
    } catch (error) {
      warn(`${kindLabel}摘要失败，用启发式兜底：${error instanceof Error ? error.message : String(error)}`)
      return null
    }

    // 「3|短句」/「[3] 短句」/「3. 短句」都认，认不出编号的行直接丢掉。
    const byIndex = new Map()
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      const matched = line.match(/^\[?(\d{1,3})\]?\s*[|｜:：.、)）-]\s*(.+)$/)
      if (matched === null) continue
      const index = Number(matched[1])
      if (!Number.isInteger(index) || index < 1 || index > items.length) continue
      if (byIndex.has(index)) continue
      const summary = firstClause(matched[2], SUMMARY_LINE_MAX)
      if (summary !== '') byIndex.set(index, summary)
    }
    // 一条都没对上，说明它没按格式来（或者压根没输出正文），整体放弃
    if (byIndex.size === 0) return null
    return items.map((item, index) => byIndex.get(index + 1) ?? firstClause(item.text))
  }

  /** 摘要缓存的键：类别 + 内容指纹。内容没变就永远命中。 */
  function summaryCacheKey(kind, items) {
    return `${kind}:${fingerprint(items.map((item) => flatText(item.text)).join('\u0001'))}`
  }

  /**
   * 用模型精修一批条目并写入缓存。成功返回短句数组，失败返回 null。
   * 刻意做成「谁需要谁调用」：写入记录后预热一次，点菜单时就能直接命中缓存。
   * 同一个 cacheKey 的并发请求会共用一次模型调用（in-flight 去重）。
   */
  async function warmSummary(kind, items) {
    if (!Array.isArray(items) || items.length === 0) return null
    const cacheKey = summaryCacheKey(kind, items)
    const cached = summaryCache.get(cacheKey)
    if (cached !== undefined) return cached
    const total = items.reduce((sum, item) => sum + flatText(item.text).length, 0)
    // 每条都很短的时候模型没什么可压的，省下这次调用
    if (total <= 60) return null
    if (summaryInFlight.has(cacheKey)) return summaryInFlight.get(cacheKey)

    const task = (async () => {
      const refined = await summarizeWithModel(items, kind)
      if (refined === null) return null
      if (summaryCache.size >= SUMMARY_CACHE_MAX) {
        // 粗暴清一半：这是个纯缓存，不需要 LRU
        for (const key of [...summaryCache.keys()].slice(0, Math.floor(SUMMARY_CACHE_MAX / 2))) summaryCache.delete(key)
      }
      summaryCache.set(cacheKey, refined)
      return refined
    })().finally(() => summaryInFlight.delete(cacheKey))
    summaryInFlight.set(cacheKey, task)
    return task
  }

  /** 后台预热：不 await、不抛错，纯粹让下次点击能命中缓存。 */
  function warmInBackground(kind, items) {
    warmSummary(kind, items).catch(() => {
      /* 预热失败不影响任何业务 */
    })
  }

  /**
   * 拼气泡文案：标题 + 若干短句 + 指路，总长压在 TEXT_MAX 以内。
   * 放不下时先砍条目（并写明还剩几条），而不是把最后一句话截断——
   * 「另 3 条」是有信息的，「…了解了机器学…」没有。
   */
  function composeBubble(head, lines, tail = '') {
    // 最多三个最近条目；给编号、换行、剩余条数和全文入口留足空间。
    const recent = lines.slice(-3)
    const kept = []
    for (const line of [...recent].reverse()) {
      const candidate = [line, ...kept]
      const rest = lines.length - candidate.length
      const text = [head, ...candidate.map((text, i) => `${i + 1}. ${text}`), rest > 0 ? `另有 ${rest} 条` : '', tail.trim()].filter(Boolean).join('\n')
      if (text.length > TEXT_MAX) break
      kept.unshift(line)
    }
    const rest = lines.length - kept.length
    return [head, ...kept.map((text, i) => `${i + 1}. ${text}`), rest > 0 ? `另有 ${rest} 条` : '', tail.trim()].filter(Boolean).join('\n')
  }

  /**
   * 气泡两步走：先把「立刻能看」的版本弹出去，模型精修好了再悄悄覆盖一次。
   * 摘要通常在写记录时就在后台预热好了，所以第一步多半已经命中缓存；
   * 命中不了就先给人看启发式首句，别让人对着空气等十几秒。
   */
  async function sayWithRefine(kind, items, head) {
    const tail = '全文：设置 → 成长手记'
    const cacheKey = summaryCacheKey(kind, items)
    const cached = summaryCache.get(cacheKey)
    if (cached !== undefined) {
      await say(composeBubble(head, cached, tail))
      return
    }
    const first = composeBubble(head, items.map((item) => firstClause(item.text)), tail)
    await say(first)
    const refined = await warmSummary(kind, items)
    if (refined === null) return
    const second = composeBubble(head, refined, tail)
    // 没变就别再弹一次，避免气泡闪动
    if (second !== first) await say(second)
  }
  /* ── 业务动作 ── */

  function doCheckin(now = new Date()) {
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    if (entry.checkin !== null) {
      const minutes = parseHm(entry.checkin)
      const comparison = minutes === null ? null : compareCheckin(store, key, minutes)
      const streak = streakInfo(store, now)
      return {
        fresh: false,
        streak,
        text: `今天 ${entry.checkin} 已经打过卡了。${comparison === null ? '' : checkinSentence(minutes, comparison, streak)}`,
      }
    }
    const minutes = now.getHours() * 60 + now.getMinutes()
    const next = { ...entry, checkin: hmOf(now), checkinTs: now.getTime() }
    store.days[key] = next
    saveStore(store)
    const comparison = compareCheckin(store, key, minutes)
    // 连续天数必须在写盘之后再算：算早了今天不计数，永远只显示到昨天
    const streak = streakInfo(store, now)
    return {
      fresh: true,
      minutes,
      comparison,
      verdict: verdictOf(comparison),
      streak,
      text: checkinSentence(minutes, comparison, streak),
    }
  }

  /**
   * 打卡气泡的「钩子」：让那句问候不只报时间。
   *
   * 优先级从「最像有人在听你说话」往下排：
   * ① 上一个工作日写下的打算（他昨天自己说要干的事）
   * ② 上一个工作日记过的内容（昨天在研究什么）
   * ③ 想学的池子里还欠的那一条（今天可以挑什么）
   * ④ 本周进度（什么都没有时的兜底）
   *
   * 全都没有就返回空串，气泡只剩到达那句——宁可短，也不要凑字数。
   */
  function checkinHook(now = new Date()) {
    const seed = keySerial(dateKeyOf(now))
    const prev = dayEntry(store, dateKeyOf(prevWorkday(now)))

    // 昨天最近的 2 条感想 + 2 条记录一起评，命中率比只看最后一条高得多
    const texts = [...prev.thoughts.slice(-2), ...prev.entries.slice(-2)].map((item) => item.text)
    const intent = bestIntent(texts)
    if (intent) {
      // 挑到明确打算就催一句；只是想法就顺着问，不硬说成「你昨天说要做」
      const frames =
        intent.score >= 2
          ? [
              `昨天你写「${intent.quote}」，今天接着来？`,
              `昨天你提到「${intent.quote}」，今天要不要先动它？`,
              `昨天你说「${intent.quote}」，今天要不要碰一下？`,
            ]
          : [`昨天你写到「${intent.quote}」，今天想从哪儿接？`, `昨天你提了一句「${intent.quote}」，今天要不要顺着往下想？`]
      return pickRotating(frames, seed)
    }

    const open = sortedPlans().filter((plan) => !plan.done)
    if (open.length > 0) {
      const pick = open[Math.abs(seed) % open.length]
      return pickRotating(
        [
          `池子里还欠 ${open.length} 条，今天挑一条？「${clip(pick.text, 20)}」`,
          `池子还有 ${open.length} 条没动，随便开个头？「${clip(pick.text, 20)}」`,
        ],
        seed,
      )
    }

    const stats = weekStats(store, now)
    if (stats.attended > 0 && stats.worked > 0) return `这周已经到 ${stats.attended}/${stats.worked} 天。`
    return ''
  }

  function doLog(text, now = new Date()) {
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    const clean = String(text ?? '').trim()
    if (clean === '') return { ok: false, text: '要记的内容是空的。' }
    entry.entries.push({ at: hmOf(now), ts: now.getTime(), text: clean })
    if (entry.checkin === null) {
      // 记录顺手补打卡：既然人已经在记了，说明今天到工位了
      entry.checkin = hmOf(now)
      entry.checkinTs = now.getTime()
    }
    store.days[key] = entry
    saveStore(store)
    // 顺手在后台把摘要算出来：点菜单时就能直接命中缓存，不用当场等模型。
    // 这是「提前花几秒」换「点下去立刻有内容」，失败也只是下次点击退回启发式。
    warmInBackground('entry', entry.entries)
    return { ok: true, text: `记下了（今天第 ${entry.entries.length} 条）：${clean}` }
  }

  /**
   * 感想：跟「学习记录」分开存。
   *
   * 学习记录是事实（今天看了什么、跑通了什么），感想是判断和情绪（烦、爽、怀疑方向）。
   * 两种东西混在一个数组里，周报就既不像复盘也不像随笔；分开以后，学习记录能进统计，
   * 感想能原样贴进公众号而不显得突兀。
   */
  function doThink(text, now = new Date()) {
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    const clean = String(text ?? '').trim()
    if (clean === '') return { ok: false, text: '要记的感想是空的。' }
    entry.thoughts.push({ at: hmOf(now), ts: now.getTime(), text: clean })
    store.days[key] = entry
    saveStore(store)
    warmInBackground('thought', entry.thoughts)
    return { ok: true, text: `感想收下了（今天第 ${entry.thoughts.length} 条）：${clean}` }
  }

  /* ── 想学的池子 ── */

  /**
   * 池子的设计取舍：
   *
   * 1. 不排期。用户明确说了要「想到什么规划什么」，所以这里没有 dueAt——它不是待办，
   *    是素材库。真到要做的时候，人会自己说「今天先看这个」。
   * 2. 划掉即记录。标完成的同时往当天 entries 里写一条，周报能直接算出「这周把几条想学的看完了」。
   *    不让用户为了留痕再打一遍字。
   * 3. 只用一个数组，不分页不分天。条目少的时候一眼看完，多了按「未完成在前、新的在前」排。
   */

  /** 未完成在前（新的在前），已完成在后（刚完成的在前）。 */
  function sortedPlans(list = store.plans) {
    const open = list.filter((p) => !p.done).sort((a, b) => b.createdAt - a.createdAt)
    const done = list.filter((p) => p.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    return [...open, ...done]
  }

  function nextPlanId() {
    const seq = Number(store.meta?.planSeq ?? 0) + 1
    store.meta = { ...(store.meta ?? {}), planSeq: seq }
    return `p${seq}-${Date.now().toString(36)}`
  }

  function addPlan(text, now = new Date(), source = 'chat', dueRaw = null) {
    const clean = String(text ?? '').trim().replace(/\s+/g, ' ')
    if (clean === '') return { ok: false, text: '要加进池子的内容是空的。' }
    if (store.plans.length >= PLAN_MAX) {
      return { ok: false, text: `池子满了（${PLAN_MAX} 条），先删几条再看要不要加。` }
    }
    const dueAt = parseDueAt(dueRaw)
    if (dueRaw !== null && dueRaw !== undefined && dueRaw !== '' && dueAt === null) {
      return { ok: false, text: '截止时间没看懂，用「2026-11-20 10:20」这种格式。' }
    }
    const plan = {
      id: nextPlanId(),
      text: clean.slice(0, PLAN_TEXT_MAX),
      note: '',
      source,
      done: false,
      createdAt: now.getTime(),
      doneAt: null,
      doneDay: null,
      dueAt,
    }
    store.plans.push(plan)
    saveStore(store)
    scheduleSync()
    const open = store.plans.filter((p) => !p.done).length
    const dueTail = dueAt === null ? '' : `，截止 ${dateKeyOf(new Date(dueAt))} ${hmOf(new Date(dueAt))}`
    return { ok: true, plan, text: `丢进池子了（现在有 ${open} 条想学的）：${plan.text}${dueTail}` }
  }

  /** 按序号或 id 或正文片段找一条未完成的计划。 */
  function findPlan(ref, { includeDone = true } = {}) {
    const raw = String(ref ?? '').trim()
    if (raw === '') return null
    const pool = includeDone ? sortedPlans() : sortedPlans().filter((p) => !p.done)
    // 纯数字 = 面板上看到的序号（1 起）
    if (/^\d+$/.test(raw)) {
      const index = Number(raw) - 1
      if (index >= 0 && index < pool.length) return pool[index]
      return null
    }
    const exact = pool.find((p) => p.id === raw)
    if (exact) return exact
    const hit = pool.filter((p) => p.text.includes(raw) || raw.includes(p.text))
    if (hit.length === 1) return hit[0]
    return hit.length > 1 ? { ambiguous: hit } : null
  }

  /**
   * 标完成。done=true 时顺手往当天学习记录里写一条，done=false 时把那条记录收回。
   *
   * 收回要认准「是这条计划自己写的那条」：条目上记 `planLogTs`，撤销时按 ts 精确删，
   * 绝不按文字匹配——用户可能自己也记过一模一样的一句。
   */
  function finishPlan(ref, now = new Date()) {
    const found = findPlan(ref)
    if (found === null) return { ok: false, text: `没找到「${ref}」这条。先看看池子里都有什么。` }
    if (found.ambiguous) {
      const list = found.ambiguous.slice(0, 5).map((p, i) => `${i + 1}. ${p.text}`).join('\n')
      return { ok: false, text: `「${ref}」对上好几条，说准一点：\n${list}` }
    }
    const plan = store.plans.find((p) => p.id === found.id)
    if (plan === undefined) return { ok: false, text: '这条已经不在池子里了。' }
    if (plan.done) return { ok: false, text: `「${plan.text}」早就划掉了（${plan.doneDay ?? '之前'}）。` }
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    const logText = `看完了想学的：${plan.text}`
    entry.entries.push({ at: hmOf(now), ts: now.getTime(), text: logText })
    if (entry.checkin === null) {
      entry.checkin = hmOf(now)
      entry.checkinTs = now.getTime()
    }
    store.days[key] = entry
    plan.done = true
    plan.doneAt = now.getTime()
    plan.doneDay = key
    plan.planLogTs = now.getTime()
    saveStore(store)
    scheduleSync()
    const open = store.plans.filter((p) => !p.done).length
    return {
      ok: true,
      plan,
      text: `划掉了：${plan.text}\n顺手记了一条学习记录（今天第 ${entry.entries.length} 条），池子还剩 ${open} 条。`,
    }
  }

  function reopenPlan(ref) {
    const found = findPlan(ref)
    if (found === null) return { ok: false, text: `没找到「${ref}」这条。` }
    if (found.ambiguous) return { ok: false, text: `「${ref}」对上好几条，说准一点。` }
    const plan = store.plans.find((p) => p.id === found.id)
    if (plan === undefined) return { ok: false, text: '这条已经不在池子里了。' }
    if (!plan.done) return { ok: false, text: `「${plan.text}」本来就没划掉。` }
    // 撤销时把那一条自动写进去的学习记录也收回，否则数据会重复计算
    if (typeof plan.planLogTs === 'number' && plan.doneDay) {
      const entry = dayEntry(store, plan.doneDay)
      const kept = entry.entries.filter((item) => item.ts !== plan.planLogTs)
      if (kept.length !== entry.entries.length) {
        entry.entries = kept
        store.days[plan.doneDay] = entry
      }
    }
    plan.done = false
    plan.doneAt = null
    plan.doneDay = null
    delete plan.planLogTs
    saveStore(store)
    scheduleSync()
    return { ok: true, plan, text: `重新放回池子了：${plan.text}` }
  }

  function dropPlan(ref) {
    const found = findPlan(ref)
    if (found === null) return { ok: false, text: `没找到「${ref}」这条。` }
    if (found.ambiguous) return { ok: false, text: `「${ref}」对上好几条，说准一点。` }
    const index = store.plans.findIndex((p) => p.id === found.id)
    if (index < 0) return { ok: false, text: '这条已经不在池子里了。' }
    const [removed] = store.plans.splice(index, 1)
    saveStore(store)
    scheduleSync()
    return { ok: true, text: `删掉了：${removed.text}（池子还剩 ${store.plans.length} 条）` }
  }

  function addPlanNote(ref, note) {
    const found = findPlan(ref)
    if (found === null) return { ok: false, text: `没找到「${ref}」这条。` }
    if (found.ambiguous) return { ok: false, text: `「${ref}」对上好几条，说准一点。` }
    const plan = store.plans.find((p) => p.id === found.id)
    const clean = String(note ?? '').trim()
    if (clean === '') return { ok: false, text: '备注是空的。' }
    plan.note = clean.slice(0, PLAN_NOTE_MAX)
    saveStore(store)
    return { ok: true, plan, text: `给「${plan.text}」记了备注：${plan.note}` }
  }

  /** 池子列表文案（工具 / 命令 / 面板共用一份）。 */
  function planListText({ limit = 0 } = {}) {
    const list = sortedPlans()
    if (list.length === 0) {
      return '池子是空的。想到什么想学的就丢进来：说「我想学 XXX」或 /gongwei 想学 <内容>。'
    }
    const open = list.filter((p) => !p.done)
    const done = list.filter((p) => p.done)
    const lines = [`想学的：${open.length} 条没做，${done.length} 条已划掉。`]
    const shown = limit > 0 ? list.slice(0, limit) : list
    shown.forEach((plan, index) => {
      const mark = plan.done ? '✓' : '○'
      let tail = plan.done && plan.doneDay ? `（${plan.doneDay} 划掉）` : ''
      if (plan.dueAt !== null && Number.isFinite(plan.dueAt)) {
        const d = new Date(plan.dueAt)
        tail += `（截止 ${dateKeyOf(d)} ${hmOf(d)}）`
      }
      lines.push(`${mark} ${index + 1}. ${plan.text}${tail}`)
      if (plan.note !== '') lines.push(`     备注：${plan.note}`)
    })
    if (shown.length < list.length) lines.push(`……还有 ${list.length - shown.length} 条`)
    return lines.join('\n')
  }

  /** 今天的计划：既是「今天挑了什么」，也是池子的推荐入口。 */
  function doPlan(now = new Date()) {
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    const doneToday = store.plans.filter((p) => p.done && p.doneDay === key)
    const open = store.plans.filter((p) => !p.done)
    const lines = [`今天是 ${key}。`]
    lines.push(doneToday.length === 0 ? '今天还没划掉任何一条。' : `今天划掉了 ${doneToday.length} 条：`)
    for (const plan of doneToday) lines.push(`  ✓ ${plan.text}`)
    if (open.length === 0) {
      lines.push('池子里没有待做的了。想到新的就说「我想学 XXX」，我丢进去。')
    } else {
      lines.push(`池子里还有 ${open.length} 条没做：`)
      const recent = sortedPlans().filter((p) => !p.done).slice(0, 8)
      recent.forEach((plan, index) => {
        const days = Math.floor((now.getTime() - plan.createdAt) / DAY_MS)
        const age = days <= 0 ? '今天加的' : days === 1 ? '昨天加的' : `${days} 天前加的`
        lines.push(`  ${index + 1}. ${plan.text}（${age}）`)
      })
      if (open.length > recent.length) lines.push(`  ……还有 ${open.length - recent.length} 条`)
      lines.push('挑中哪个就说「这个看完了：<序号或关键词>」，我划掉并记一条学习记录。')
    }
    if (entry.entries.length > 0) lines.push(`今天已经记了 ${entry.entries.length} 条学习记录。`)
    return lines.join('\n')
  }

  /**
   * 从桌宠自带的待办事项里搬一次东西。
   *
   * 为什么只做一次、不做同步：桌宠的待办是用户级单文件，我们改不了它的结构（`parseTodoRecord`
   * 一个字段不合格就整条丢），两边各写一份状态迟早对不上。所以这里只做「一次性搬迁」，
   * 搬完之后新池子就是唯一真相——旧待办留不留在那儿，是用户自己删不删的问题，不是我们的。
   *
   * 已划掉的也搬，并且保持划掉状态：那几条是真做完的事，丢掉就查不到了。
   */
  function importPetTodos() {
    const file = path.join(HOME, 'dsh-pet', 'todos.json')
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { ok: false, text: `没找到桌宠的待办文件（${file}）。` }
    }
    const todos = Array.isArray(raw?.todos) ? raw.todos : []
    if (todos.length === 0) return { ok: false, text: '桌宠的待办是空的，没什么可搬的。' }
    // 去重键必须「去标记 + 压空白」后比对：桌宠待办带 [想学] 前缀，而池子里存的是
    // 去掉标记的正文。旧代码用原始带前缀文本当键，和池子里无前缀的正文对不上，
    // 于是每次点「搬过来」都会把同一批重新导一遍，前缀还被当成正文堆进去
    // （[想学] [想学] …）。这里和 syncWithPetTodos 的 unmarkedText 口径统一。
    const normKey = (t) => unmarkedText(String(t ?? '')).trim().replace(/\s+/g, ' ').slice(0, PLAN_TEXT_MAX)
    const existing = new Set(store.plans.map((p) => normKey(p.text)).filter(Boolean))
    let added = 0
    let skipped = 0
    for (const todo of todos) {
      const text = unmarkedText(String(todo?.text ?? '')).trim().replace(/\s+/g, ' ')
      if (text === '') continue
      const key = text.slice(0, PLAN_TEXT_MAX)
      if (existing.has(key)) {
        skipped += 1
        continue
      }
      if (store.plans.length >= PLAN_MAX) break
      const created = Number(todo?.createdAt)
      const done = todo?.done === true
      const completedAt = Number(todo?.completedAt)
      store.plans.push({
        id: nextPlanId(),
        text: key,
        note: '',
        source: 'pet-todo',
        done,
        createdAt: Number.isFinite(created) ? created : Date.now(),
        doneAt: done && Number.isFinite(completedAt) ? completedAt : null,
        // 只记「哪天划掉的」，不写 planLogTs：那条学习记录当初没生成，撤销时也就无从收回
        doneDay: done && Number.isFinite(completedAt) ? dateKeyOf(new Date(completedAt)) : null,
        planLogTs: null,
      })
      existing.add(key)
      added += 1
    }
    saveStore(store)
    const open = store.plans.filter((p) => !p.done).length
    const tail = skipped > 0 ? `，${skipped} 条池子里已经有了` : ''
    return {
      ok: true,
      text: added === 0 ? `没有新东西可搬${tail}。` : `从桌宠待办搬了 ${added} 条进池子${tail}；现在 ${open} 条没做。`,
    }
  }

  function doStatus(now = new Date()) {
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    const lines = []
    lines.push(entry.checkin === null ? `今天还没打卡。` : `今天 ${entry.checkin} 打卡。`)
    lines.push(entry.entries.length === 0 ? '还没有学习记录。' : `已记 ${entry.entries.length} 条学习记录：`)
    for (const item of entry.entries) lines.push(`· ${item.text}`)
    if (entry.thoughts.length > 0) {
      lines.push(`另有 ${entry.thoughts.length} 条感想：`)
      for (const item of entry.thoughts) lines.push(`· ${item.text}`)
    }
    const stats = weekStats(store, now)
    lines.push(
      stats.avg === null
        ? '本周还没有可用数据。'
        : `本周到 ${stats.attended}/${stats.worked} 天，平均 ${fmtMin(stats.avg)}，记录 ${stats.entryCount} 条，感想 ${stats.thoughtCount} 条。`,
    )
    lines.push(streakLine(stats.streak))
    const openPlans = store.plans.filter((p) => !p.done).length
    const donePlansToday = store.plans.filter((p) => p.done && p.doneDay === key).length
    lines.push(
      openPlans === 0 && donePlansToday === 0
        ? '想学的池子是空的。'
        : `想学的池子：${openPlans} 条没做${donePlansToday > 0 ? `，今天划掉 ${donePlansToday} 条` : ''}。`,
    )
    return lines.join('\n')
  }

  /** style=stat 出统计表（自己复盘用）；style=article 出成文版（公众号用）。 */
  function doReport(now = new Date(), style = 'stat') {
    const markdown = style === 'article' ? weekArticle(store, now) : weekMarkdown(store, now)
    fs.mkdirSync(REPORT_DIR, { recursive: true })
    const suffix = style === 'article' ? '-article' : ''
    const name = `week-${dateKeyOf(weekStartOf(now))}${suffix}.md`
    const file = path.join(REPORT_DIR, name)
    fs.writeFileSync(file, markdown, 'utf8')
    // 第二份副本：放在用户自己设的目录（比如桌面/文档里），文件名带日期，找得到也一眼认得出。
    // 写副本失败不该影响周报本身——归档那份已经落盘了，这里只能吞掉错误并留日志。
    const copyDir = String(store.config.reportCopyDir ?? '').trim()
    let copyFile = null
    if (copyDir !== '') {
      try {
        fs.mkdirSync(copyDir, { recursive: true })
        copyFile = path.join(copyDir, name)
        fs.writeFileSync(copyFile, markdown, 'utf8')
      } catch (error) {
        copyFile = null
        warn(`report copy failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { markdown, file, copyFile }
  }

  function updateConfig(patch) {
    const applied = []
    if (patch.reminderTime !== undefined) {
      if (parseHm(patch.reminderTime) === null) return { ok: false, text: 'reminderTime 要写成 HH:MM。' }
      store.config.reminderTime = patch.reminderTime
      applied.push(`提醒时间 ${patch.reminderTime}`)
    }
    if (patch.baseline !== undefined) {
      if (parseHm(patch.baseline) === null) return { ok: false, text: 'baseline 要写成 HH:MM。' }
      store.config.baseline = patch.baseline
      applied.push(`基准 ${patch.baseline}`)
    }
    if (patch.weeklyTime !== undefined) {
      if (parseHm(patch.weeklyTime) === null) return { ok: false, text: 'weeklyTime 要写成 HH:MM。' }
      store.config.weeklyTime = patch.weeklyTime
      applied.push(`周报时间 ${patch.weeklyTime}`)
    }
    if (patch.weeklyDay !== undefined) {
      const n = Number(patch.weeklyDay)
      if (!Number.isInteger(n) || n < 1 || n > 7) return { ok: false, text: 'weeklyDay 取 1（周一）到 7（周日）。' }
      store.config.weeklyDay = n
      applied.push(`周报日 ${n}`)
    }
    if (patch.adoptUntimedTodos !== undefined) {
      const on = patch.adoptUntimedTodos === true || patch.adoptUntimedTodos === 'true' || patch.adoptUntimedTodos === 1
      const off = patch.adoptUntimedTodos === false || patch.adoptUntimedTodos === 'false' || patch.adoptUntimedTodos === 0
      if (!on && !off) return { ok: false, text: 'adoptUntimedTodos 只能是 true / false。' }
      store.config.adoptUntimedTodos = on
      applied.push(on ? '自动收编无期限待办：开' : '自动收编无期限待办：关')
    }
    if (patch.reportCopyDir !== undefined) {
      // 空字符串是合法的「不存副本」，所以这里不能像别的字段那样把空值当错误
      const dir = String(patch.reportCopyDir ?? '').trim()
      store.config.reportCopyDir = dir
      applied.push(dir === '' ? '周报副本：不额外存' : `周报副本目录 ${dir}`)
    }
    if (patch.stretchEvery !== undefined) {
      const n = Number(patch.stretchEvery)
      if (!Number.isInteger(n) || n < 0 || n > 480) return { ok: false, text: 'stretchEvery 取 0（关）到 480 分钟。' }
      store.config.stretchEvery = n
      applied.push(n === 0 ? '久坐提醒：关' : `久坐提醒每 ${n} 分钟`)
    }
    if (patch.stretchStart !== undefined) {
      if (parseHm(patch.stretchStart) === null) return { ok: false, text: 'stretchStart 要写成 HH:MM。' }
      store.config.stretchStart = patch.stretchStart
      applied.push(`久坐提醒起点 ${patch.stretchStart}`)
    }
    if (patch.stretchEnd !== undefined) {
      if (parseHm(patch.stretchEnd) === null) return { ok: false, text: 'stretchEnd 要写成 HH:MM。' }
      store.config.stretchEnd = patch.stretchEnd
      applied.push(`久坐提醒终点 ${patch.stretchEnd}`)
    }
    if (patch.stretchToIm !== undefined) {
      const on = patch.stretchToIm === true || patch.stretchToIm === 'true' || patch.stretchToIm === 1
      const off = patch.stretchToIm === false || patch.stretchToIm === 'false' || patch.stretchToIm === 0
      if (!on && !off) return { ok: false, text: 'stretchToIm 只能是 true / false。' }
      store.config.stretchToIm = on
      applied.push(on ? '久坐提醒推微信：开' : '久坐提醒推微信：关')
    }
    saveStore(store)
    return { ok: true, text: applied.length === 0 ? '没有要改的字段。' : `已更新：${applied.join('、')}` }
  }

  /**
   * 维护用户的稳定画像。add=追加一条、set_name=改助手名字、remove=按关键词删一条、
   * list=看当前画像。这是长期记忆，不要随手清空。
   */
  function updateProfile(action, text) {
    if (action === 'set_name') {
      const name = String(text ?? '').trim().slice(0, 40)
      if (name === '') return { ok: false, text: '名字不能是空的。' }
      store.profile.assistantName = name
      saveStore(store)
      return { ok: true, text: `记住了，以后叫自己「${name}」。` }
    }
    if (action === 'add') {
      const line = String(text ?? '').trim().slice(0, 500)
      if (line === '') return { ok: false, text: '要记的画像不能是空的。' }
      if (store.profile.lines.includes(line)) return { ok: true, text: '这条画像已经记着了。' }
      store.profile.lines.push(line)
      saveStore(store)
      return { ok: true, text: `记下了：${line}` }
    }
    if (action === 'remove') {
      const key = String(text ?? '').trim()
      const before = store.profile.lines.length
      store.profile.lines = store.profile.lines.filter((line) => !line.includes(key))
      const removed = before - store.profile.lines.length
      if (removed === 0) return { ok: false, text: `没找到含「${key}」的画像。` }
      saveStore(store)
      return { ok: true, text: `去掉了 ${removed} 条画像。` }
    }
    if (action === 'list' || action === undefined || action === '') {
      const name = store.profile.assistantName ? `助手名字：${store.profile.assistantName}\n` : ''
      const lines = store.profile.lines.length
        ? store.profile.lines.map((line, i) => `${i + 1}. ${line}`).join('\n')
        : '（还没有稳定画像）'
      return { ok: true, text: `${name}稳定画像：\n${lines}` }
    }
    return { ok: false, text: 'profile 的 action 只认 set_name / add / remove / list。' }
  }

  /* ── 设置页 API（池子的面板走这里） ── */

  /**
   * 面板为什么不直接用工具：工具是给模型用的，面板是给人点的。
   * 人在面板里点一下「划掉」，要的是立刻生效 + 立刻看到结果，不该绕一圈进对话。
   *
   * 信任栅栏跟 bili-whale 一个套路：先看 Host 是不是回环，再问 connection.requestRejection。
   * 栅栏不可用时 **fail-closed** —— 宁可面板打不开，也不能让一个裸接口把数据交出去。
   */
  const API_PREFIX = '/dsh-gongwei/api/plans'

  function json(res, status, obj) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(obj))
  }

  function hostIsLoopback(req) {
    const host = String(req.headers?.host ?? '').toLowerCase()
    const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || bare === '::1'
  }

  function rejected(req, res, { strict = true } = {}) {
    if (hostIsLoopback(req) === false) {
      let trusted = false
      try {
        const conn = ctx.get('connection', false)
        if (conn && typeof conn.isTrusted === 'function') trusted = conn.isTrusted(req) === true
      } catch {
        /* 栅栏不可用：下面按 fail-closed 处理 */
      }
      if (!trusted) {
        json(res, 403, { ok: false, error: '不受信任的访问来源' })
        return true
      }
    }
    try {
      const conn = ctx.get('connection', false)
      if (!conn || typeof conn.requestRejection !== 'function') {
        if (strict) {
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问' })
          return true
        }
        return false
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      if (strict) {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问' })
        return true
      }
      return false
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        // 池子单条正文上限 200，整包给 64KB 已经很宽松；再大就是有人在灌
        if (size > 65_536) {
          reject(new Error('请求体太大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** 面板要的条目形状：把 planLogTs 这类内部字段挡掉，前端只拿它该知道的。 */
  function publicPlan(plan) {
    return {
      id: plan.id,
      text: plan.text,
      note: plan.note,
      done: plan.done,
      createdAt: plan.createdAt,
      doneAt: plan.doneAt,
      doneDay: plan.doneDay,
      dueAt: plan.dueAt ?? null,
    }
  }

  /**
   * 面板的增删改统一走这里，跟工具/命令共用同一批函数——
   * 三条入口一套逻辑，才不会出现「面板能划掉、命令划不掉」这种分裂。
   */
  function planApiState() {
    const list = sortedPlans()
    return {
      ok: true,
      plans: list.map(publicPlan),
      stats: {
        open: store.plans.filter((p) => !p.done).length,
        done: store.plans.filter((p) => p.done).length,
        doneToday: store.plans.filter((p) => p.done && p.doneDay === dateKeyOf(new Date())).length,
      },
    }
  }

  whenService(['webServer'], 'gongwei: plans api', (web) => {
    if (typeof web.register !== 'function') {
      // 没有 webServer（无界面模式）就只是少一个面板，插件其余功能照常
      return () => {}
    }
    return web.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          const url = new URL(req.url ?? API_PREFIX, 'http://127.0.0.1')
          const tail = url.pathname.slice(API_PREFIX.length).replace(/^\//, '')
          const id = tail === '' ? '' : decodeURIComponent(tail)
          const method = String(req.method ?? 'GET').toUpperCase()

          try {
            if (method === 'GET' && id === '') {
              json(res, 200, planApiState())
              return
            }
            if (method === 'POST' && id === '') {
              const body = JSON.parse((await readBody(req)) || '{}')
              const result = addPlan(body.text, new Date(), 'panel', body.dueAt ?? null)
              if (!result.ok) {
                json(res, 200, { ok: false, error: result.text })
                return
              }
              json(res, 200, planApiState())
              return
            }
            if (method === 'POST' && id === 'import') {
              const result = importPetTodos()
              if (!result.ok) {
                json(res, 200, { ok: false, error: result.text })
                return
              }
              const state = planApiState()
              json(res, 200, { ...state, message: result.text })
              return
            }
            if (id !== '' && (method === 'PATCH' || method === 'PUT')) {
              const body = JSON.parse((await readBody(req)) || '{}')
              if (Object.prototype.hasOwnProperty.call(body, 'dueAt')) {
                const parsed = parseDueAt(body.dueAt)
                if (body.dueAt !== null && body.dueAt !== undefined && body.dueAt !== '' && parsed === null) {
                  json(res, 200, { ok: false, error: '截止时间没看懂，用「2026-11-20 10:20」这种格式。' })
                  return
                }
                const found = findPlan(id)
                if (found === null || found.ambiguous) {
                  json(res, 200, { ok: false, error: '找不到这一条。' })
                  return
                }
                const plan = store.plans.find((p) => p.id === found.id)
                plan.dueAt = parsed
                saveStore(store)
                scheduleSync()
                json(res, 200, planApiState())
                return
              }
              // done 走 finishPlan/reopenPlan：它会连带写（或收回）那条学习记录，
              // 面板里点一下勾，学习记录也得跟着动，否则周报就少算一条
              if (typeof body.done === 'boolean') {
                const result = body.done ? finishPlan(id) : reopenPlan(id)
                if (!result.ok) {
                  json(res, 200, { ok: false, error: result.text })
                  return
                }
                json(res, 200, planApiState())
                return
              }
              if (typeof body.note === 'string') {
                const result = addPlanNote(id, body.note)
                if (!result.ok) {
                  json(res, 200, { ok: false, error: result.text })
                  return
                }
                json(res, 200, planApiState())
                return
              }
              if (typeof body.text === 'string') {
                const found = findPlan(id)
                if (found === null || found.ambiguous) {
                  json(res, 200, { ok: false, error: '找不到这一条。' })
                  return
                }
                const plan = store.plans.find((p) => p.id === found.id)
                const clean = String(body.text).trim().replace(/\s+/g, ' ')
                if (clean === '') {
                  json(res, 200, { ok: false, error: '内容不能为空。' })
                  return
                }
                plan.text = clean.slice(0, PLAN_TEXT_MAX)
                saveStore(store)
                scheduleSync()
                json(res, 200, planApiState())
                return
              }
              json(res, 200, { ok: false, error: '没有要改的字段。' })
              return
            }
            if (id !== '' && method === 'DELETE') {
              const result = dropPlan(id)
              if (!result.ok) {
                json(res, 200, { ok: false, error: result.text })
                return
              }
              json(res, 200, planApiState())
              return
            }
            json(res, 405, { ok: false, error: '不支持的方法。' })
          } catch (error) {
            json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
    })
  })

  /* ── 设置页 API：「今天」面板读全文 ── */

  /**
   * 气泡只能放摘要，全文得有个地方能看：设置页的「今天」面板。
   *
   * 只读、只回当天。为什么不给「改/删」：这两件事对话和命令里都能做，
   * 而面板的主要用途是「我刚才写的那一大段，现在想完整看一遍」。
   * 万一以后要在面板里改，再加方法不迟——先把「看得全」这件事做对。
   */
  const TODAY_API_PREFIX = '/dsh-gongwei/api/today'

  whenService(['webServer'], 'gongwei: today api', (web) => {
    if (typeof web.register !== 'function') return () => {}
    return web.register({
      kind: 'prefix',
      path: TODAY_API_PREFIX,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        const method = String(req.method ?? 'GET').toUpperCase()
        if (method !== 'GET') {
          json(res, 405, { ok: false, error: '不支持的方法。' })
          return
        }
        try {
          const now = new Date()
          const key = dateKeyOf(now)
          const entry = dayEntry(store, key)
          const stats = weekStats(store, now)
          json(res, 200, {
            ok: true,
            day: key,
            checkin: entry.checkin,
            entries: entry.entries,
            thoughts: entry.thoughts,
            entrySummaries: summaryCache.get(summaryCacheKey('entry', entry.entries)) ?? null,
            thoughtSummaries: summaryCache.get(summaryCacheKey('thought', entry.thoughts)) ?? null,
            entryChars: entry.entries.reduce((sum, item) => sum + flatText(item.text).length, 0),
            thoughtChars: entry.thoughts.reduce((sum, item) => sum + flatText(item.text).length, 0),
            week: stats.avg === null ? null : { attended: stats.attended, worked: stats.worked, avg: fmtMin(stats.avg) },
            streak: stats.streak.total > 0 ? streakLine(stats.streak) : null,
            plansOpen: store.plans.filter((p) => !p.done).length,
          })
        } catch (error) {
          json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })

  // 周报正文和气泡共用同一数据源。GET 预览无写盘，POST 显式生成两份归档。
  whenService(['webServer'], 'gongwei: reports api', (web) => {
    if (typeof web.register !== 'function') return () => {}
    return web.register({ kind: 'exact', path: '/dsh-gongwei/api/reports', handler: async (req, res) => {
      if (rejected(req, res)) return
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'POST') return json(res, 405, { ok: false, error: '不支持的方法。' })
      try {
        const now = new Date()
        const stat = method === 'POST' ? doReport(now, 'stat').markdown : weekMarkdown(store, now)
        const article = method === 'POST' ? doReport(now, 'article').markdown : weekArticle(store, now)
        json(res, 200, { ok: true, week: dateKeyOf(weekStartOf(now)), stat, article, saved: method === 'POST' })
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    } })
  })

  function weeklyBubble(now, saved = false) {
    const stats = weekStats(store, now)
    return [saved ? '本周回顾已归档' : '本周回顾',
      `1. 出勤 ${stats.attended}/${stats.worked} 天${stats.avg === null ? '' : ` · 平均 ${fmtMin(stats.avg)}`}`,
      `2. 学习 ${stats.entryCount} 条 · 感想 ${stats.thoughtCount} 条`,
      `3. 连续 ${stats.streak.current} 个工作日`,
      '阅读：设置 → 成长手记 → 每周回顾'].join('\n')
  }

  /* ── 菜单 ── */

  const MENU_LABELS = ['打个卡', '今天记录', '记条感想', '想学什么', '本周战绩', '写周报']

  async function registerMenu() {
    if (base === null) base = resolveBase()
    const result = await callPet(base, MENU_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, labels: MENU_LABELS, target: 'both' }),
    })
    if (result?.ok !== true) warn(`menu register failed: ${result?.reason ?? 'unknown'} ${result?.message ?? ''}`)
  }

  async function onMenuClick(label) {
    const now = new Date()
    if (label === '打个卡') {
      const result = doCheckin(now)
      // 菜单里点打卡：用克隆音色念一句像人说的话——到达 + 连击 + 昨天那句打算 / 池子还欠什么。
      // 完整统计仍可在对话里问「打卡状态」看到。
      await sayWithVoice(checkinVoiceText(result, { hook: checkinHook(now), seed: keySerial(dateKeyOf(now)) }))
      return
    }
    if (label === '今天记录') {
      const entry = dayEntry(store, dateKeyOf(now))
      if (entry.entries.length === 0) {
        // 菜单只负责「回执 + 指路」：桌宠气泡没有输入框，写东西必须回对话里。
        await say('今天还没记。到对话里说「记一下：看了什么」，或敲 /gongwei 记 <内容>，我给你存档。')
        return
      }
      const chars = entry.entries.reduce((sum, item) => sum + flatText(item.text).length, 0)
      await sayWithRefine('entry', entry.entries, `今天 ${entry.entries.length} 条（${chars} 字）`)
      return
    }
    if (label === '记条感想') {
      const entry = dayEntry(store, dateKeyOf(now))
      if (entry.thoughts.length === 0) {
        await say('今天还没写感想。到对话里说「感想：……」，或敲 /gongwei 感想 <内容>，单独存一栏。')
        return
      }
      const chars = entry.thoughts.reduce((sum, item) => sum + flatText(item.text).length, 0)
      await sayWithRefine('thought', entry.thoughts, `今天 ${entry.thoughts.length} 条感想（${chars} 字）`)
      return
    }
    if (label === '想学什么') {
      const open = store.plans.filter((p) => !p.done)
      if (open.length === 0) {
        await say('池子还是空的。想到什么想学的，到对话里说「我想学 XXX」，或敲 /gongwei 想学 <内容>。')
      } else {
        // 气泡里只放最上面几条：桌宠播报空间有限，要的是「提醒你有欠债」，不是把清单念一遍
        const top = sortedPlans().filter((p) => !p.done).slice(0, 3).map((p) => `· ${p.text}`).join('  ')
        await say(`池子里 ${open.length} 条想学的：${top}${open.length > 3 ? '  ……' : ''}  看完了就说「这个看完了」。`)
      }
      return
    }
    if (label === '本周战绩') {
      await say(weeklyBubble(now))
      return
    }
    if (label === '写周报') {
      doReport(now, 'stat')
      doReport(now, 'article')
      await say(weeklyBubble(now, true))
      return
    }
  }

  /** 长轮询菜单点击：读取即消费，所以一条循环就够。owner 丢了（桌宠重载）就重新注册。 */
  async function pollMenuOnce() {
    const result = await callPet(base, `${MENU_EVENTS_PATH}?owner=${OWNER}&wait=8000`, { method: 'GET' })
    if (result === null) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return
    }
    if (result.ok === false) {
      if (result.reason === 'unknown-owner') await registerMenu()
      else if (result.reason === 'network') await new Promise((resolve) => setTimeout(resolve, 3000))
      return
    }
    const events = result.events && typeof result.events === 'object' ? result.events : {}
    for (const [label, pet] of Object.entries(events)) {
      if (typeof pet === 'string' && pet !== '') await onMenuClick(label)
    }
  }

  /* ── 定时：每日记录提醒 + 每周周报 ── */

  /**
   * 最近一个已经过去的「周报日 + 周报时刻」。
   *
   * 周报不能只在那一刻碰巧应用开着才生成——关着就永久丢一周。所以这里不判断「现在到点了没」，
   * 而是问「最近一次该交周报的时刻是什么时候」，再由调用方跟已完成记录比对，差了就补。
   * 往回最多找 7 天：只会补最近这一周，更早的窟窿不追（追了也是把没观察过的日子写成空表）。
   */
  function lastWeeklyDeadline(now) {
    const weeklyDay = Number(store.config.weeklyDay) || 5
    const at = parseHm(store.config.weeklyTime)
    if (at === null) return null
    for (let i = 0; i <= 7; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const weekday = d.getDay() === 0 ? 7 : d.getDay()
      if (weekday !== weeklyDay) continue
      const deadline = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(at / 60), at % 60)
      if (deadline.getTime() > now.getTime()) continue // 今天的时刻还没到，继续往回找
      return { deadline, weekStartKey: dateKeyOf(weekStartOf(d)) }
    }
    return null
  }

  /**
   * 久坐提醒：按「今天打卡时刻」起算，每 stretchEvery 分钟喊一次起来走走。
   *
   * 为什么锚在打卡而不是固定钟点：这人来得晚（周一常下午两点多），固定 09:30 起算会让
   * 「刚坐下就被催」；而且提醒必须是他真的在工位时才发，否则就是骚扰。
   * 午休时段（12:00-13:30）不提醒、也不累计——到了午休就把计时器推到现在，吃完饭重新起算，
   * 否则一回来就立刻触发一条，毫无意义。
   * 每条的 eventId 带「日期+当天第几条」，靠 im-notifier 的幂等保证同一拍不会重复推。
   */
  async function maybeStretch(now) {
    const every = Number(store.config.stretchEvery)
    if (!Number.isFinite(every) || every <= 0) return
    if (isWeekend(now)) return
    const key = dateKeyOf(now)
    const entry = dayEntry(store, key)
    if (entry.checkin === null) return
    const startAt = parseHm(store.config.stretchStart)
    const endAt = parseHm(store.config.stretchEnd)
    if (startAt === null || endAt === null) return
    const minutes = now.getHours() * 60 + now.getMinutes()
    // 午休：只把计时器推到当前，不提醒也不累计
    if (minutes >= 12 * 60 && minutes < 13 * 60 + 30) {
      const stretch = store.flags[key]?.stretch
      if (stretch && typeof stretch.lastTs === 'number') {
        store.flags[key] = { ...store.flags[key], stretch: { ...stretch, lastTs: now.getTime() } }
        saveStore(store)
      }
      return
    }
    if (minutes < startAt || minutes > endAt) return
    const checkinAt = parseHm(entry.checkin)
    const floor = checkinAt === null ? startAt : Math.max(startAt, checkinAt)
    if (minutes < floor) return
    const stretch = store.flags[key]?.stretch
    if (!stretch || typeof stretch.lastTs !== 'number') {
      // 第一次进来：以现在起算，不立刻催
      store.flags[key] = { ...store.flags[key], stretch: { lastTs: now.getTime(), count: 0 } }
      saveStore(store)
      return
    }
    if (now.getTime() - stretch.lastTs < every * 60_000) return
    const count = (Number(stretch.count) || 0) + 1
    store.flags[key] = { ...store.flags[key], stretch: { lastTs: now.getTime(), count } }
    saveStore(store)
    const text = stretchText(count, every)
    await say(text)
    if (store.config.stretchToIm === true && imOptIn()?.enabled === true) {
      await imNotifier.send(`stretch:${key}:${count}`, `小鱼提醒：${text}`)
    }
  }

  /** 久坐提醒的措辞：轮换几套，避免一天里同一句话刷八遍。 */
  function stretchText(count, every) {
    // 每条都带一个「现在就能做」的具体动作：光说「起来走走」对肩颈酸痛没用，
    // 说了做哪三下才会真的做。控制在 120 字以内（桌宠气泡上限）。
    const lines = [
      `坐了 ${every} 分钟，起来走 2 分钟：收下巴 10 次（下巴往后缩，别低头）。`,
      `该动了：靠墙站好做 10 次「靠墙天使」，肩胛骨往中间夹。`,
      `又 ${every} 分钟了。接杯水，回来双手扶门框扩胸 30 秒，两边都做。`,
      `歇 3 分钟：站起来踮脚 20 下，再抬头看远处 20 秒，别一直歪着脖子。`,
      `久坐提醒：肩膀往后绕 10 圈、再往前绕 10 圈，慢慢来不使劲。`,
      `站起来伸个懒腰，双手往上够 10 秒，重复 3 次，顺便深呼吸。`,
    ]
    return lines[(count - 1) % lines.length]
  }

  /**
   * 周报推送失败后的补发。tick 每 30 秒调一次，所以这里只做「到点了吗」的判断。
   * 正文不进 state.json：从 REPORT_DIR 里那份归档文件重新读，读不到就放弃并清掉待办。
   */
  async function retryWeeklyPush(now) {
    const pending = store.meta.weeklyPending
    if (!pending || typeof pending !== 'object') return
    if (Number(pending.nextAt) > now.getTime()) return
    if (imOptIn()?.enabled !== true) return
    const attempts = (Number(pending.attempts) || 0) + 1
    if (attempts > WEEKLY_PUSH_MAX_ATTEMPTS) {
      delete store.meta.weeklyPending
      saveStore(store)
      log('weekly push retry: giving up, user still has not messaged the bot')
      return
    }
    const suffix = pending.style === 'article' ? '-article' : ''
    const file = path.join(REPORT_DIR, `week-${pending.weekStartKey}${suffix}.md`)
    let markdown
    try { markdown = fs.readFileSync(file, 'utf8') } catch {
      delete store.meta.weeklyPending
      saveStore(store)
      return
    }
    const head = typeof pending.head === 'string' && pending.head ? pending.head : '这周的周报写好了'
    // eventId 必须每次不同：im-notifier 见过同一个 id 就直接判重复、不再发。
    const sent = await imNotifier.send(
      `weekly-retry:${pending.weekStartKey}:${attempts}`,
      `${head}。\n\n${markdown}\n\n（这条是补发的，之前没发出去。）\n\n不急着评判自己，先看看这一周做成了什么。`,
    )
    if (sent.ok === true) {
      delete store.meta.weeklyPending
      saveStore(store)
      await say('周报补发成功了。')
      return
    }
    store.meta.weeklyPending = { ...pending, attempts, nextAt: now.getTime() + WEEKLY_PUSH_RETRY_MS }
    saveStore(store)
  }

  async function tick() {
    if (disposed) return
    const now = new Date()
    // 同一分钟内只跑一次：30 秒心跳会在同一分钟里跑两遍，提醒会重复弹
    const minuteKey = `${dateKeyOf(now)} ${hmOf(now)}`
    if (minuteKey === lastTickMinute) return
    lastTickMinute = minuteKey

    const key = dateKeyOf(now)
    const minutes = now.getHours() * 60 + now.getMinutes()
    const flags = store.flags[key] ?? {}

    const im = imOptIn()
    if (im?.enabled === true && Number.isFinite(im.delayedTestAt) && now.getTime() >= im.delayedTestAt && now.getTime() - im.delayedTestAt < 10 * 60_000) {
      if (claimImTest('delayedTestClaimed')) void notifyReminder('delayed-test-v1', '小鱼延迟提醒测试：这条消息是电脑到时间后主动发出的。若 iPhone 锁屏也收到了通知，说明当前双端提醒链路跑通啦。')
    }

    // 久坐提醒：只在「当天已打卡 + 工作日 + 落在 stretchStart~stretchEnd」时才累计，
    // 用打卡时刻做锚点，每 stretchEvery 分钟提醒一次，跨过午休不补计数。
    await maybeStretch(now)

    // 上次周报没推出去的话，到这里每 10 分钟补试一次
    await retryWeeklyPush(now)

    if (!isWeekend(now)) {
      const reminderAt = parseHm(store.config.reminderTime)
      if (reminderAt !== null && minutes >= reminderAt && flags.reminder !== true) {
        const entry = dayEntry(store, key)
        store.flags[key] = { ...flags, reminder: true }
        saveStore(store)
        // 连续多天且今天还没打卡：这时候催「别断」比催「写记录」更管用
        const streak = streakInfo(store, now)
        const streakNudge = streak.current >= 2 && !streak.includesToday
          ? `连续 ${streak.current} 个工作日了，今天还没打卡——`
          : ''
        if (entry.entries.length === 0) {
          const reminder = `${streakNudge}到 ${store.config.reminderTime} 了，今天学了什么？记一句吧，周报要用。`
          await say(reminder)
          if (imOptIn()?.enabled === true) await imNotifier.send(`daily:${key}`, `小鱼提醒：${reminder}`)
        } else if (entry.checkin === null) {
          const reminder = `${streakNudge}今天还没打卡哦，顺手补一个？`
          await say(reminder)
          if (imOptIn()?.enabled === true) await imNotifier.send(`daily:${key}`, `小鱼提醒：${reminder}`)
        }
      }
    }

    const deadline = lastWeeklyDeadline(now)
    if (deadline !== null) {
      const done = store.meta.lastWeeklyReport
      if (typeof done !== 'string') {
        // 首次运行：把当前这次当作已交，避免刚装上就补发一份上周的空周报
        store.meta.lastWeeklyReport = deadline.weekStartKey
        saveStore(store)
      } else if (done < deadline.weekStartKey) {
        store.meta.lastWeeklyReport = deadline.weekStartKey
        saveStore(store)
        // 用 deadline 那天做参照：统计的是那次周报所属的那一周，不是今天所在的周
        const { markdown, file, copyFile } = doReport(deadline.deadline)
        const stats = weekStats(store, deadline.deadline)
        const head =
          stats.avg === null
            ? '这周的周报写好了'
            : `这周到 ${stats.attended}/${stats.worked} 天，平均 ${fmtMin(stats.avg)}，周报写好了`
        await say(copyFile === null ? `${head}：${file}` : `${head}：${file}；另存一份到 ${copyFile}`)
        if (imOptIn()?.enabled === true) {
          // 微信侧按 1800 字自动分片，所以直接发全文比发一句「写好了」有用得多——
          // 这人经常不在电脑前，只发通知等于没发。
          const tail = copyFile === null ? '' : `\n\n（电脑上另存了一份：${copyFile}）`
          const sent = await imNotifier.send(
            `weekly:${deadline.weekStartKey}`,
            `${head}。\n\n${markdown}${tail}\n\n不急着评判自己，先看看这一周做成了什么。`,
          )
          if (sent.ok !== true) {
            // 没发出去不能就这么算了：iLink 的 -2 多数是「目标用户最近没跟机器人说过话」，
            // 他随手发一句就恢复了。挂个重试，过十分钟再试，别指望他主动想起来。
            // 正文不存进 state.json（周报 7KB 级别，存进去会把状态文件撑脏），
            // 只记周次，到时候从 REPORT_DIR 里那份归档文件重新读。
            store.meta.weeklyPending = {
              weekStartKey: deadline.weekStartKey,
              deadlineAt: deadline.deadline.toISOString(),
              head,
              attempts: 0,
              nextAt: now.getTime() + WEEKLY_PUSH_RETRY_MS,
            }
            saveStore(store)
            log(`weekly im push failed: ${sent.code}; will retry`)
          } else {
            if (store.meta.weeklyPending) {
              delete store.meta.weeklyPending
              saveStore(store)
            }
          }
        }
      }
    }
  }

  /* ── 注册资源 ── */

  ctx.effect(() => {
    let stopped = false
    const disposers = []

    const boot = async () => {
      if (imOptIn()?.enabled === true) {
        void (async () => {
          const result = await imNotifier.setup()
          log(`IM setup: ${result.ok ? 'ready' : result.code}`)
          if (claimImTest('connectionTestClaimed')) await imNotifier.send('connection-test-v1', '小鱼提醒通道测试：这是一条主动发送的消息，不是对你刚才聊天的回复。后续只发提醒，不转发日记或全部聊天。')
        })().catch(() => warn('IM: SETUP_FAILED'))
      }
      await ensurePet()
      await registerMenu()
      ensureMemoryProvider()
      // 菜单轮询循环
      const loop = async () => {
        while (!stopped) await pollMenuOnce()
      }
      void loop().catch((error) => warn(`menu loop: ${error instanceof Error ? error.message : String(error)}`))
      // 30 秒心跳：定时提醒 + 基址兜底重算
      const heartbeat = setInterval(() => {
        if (stopped) return
        if (base === null) base = resolveBase()
        // 桌宠重载会清空记忆槽：每拍补挂一次，挂上了就是个空操作
        if (memoryDispose === null) ensureMemoryProvider()
        void tick().catch((error) => warn(`tick: ${error instanceof Error ? error.message : String(error)}`))
        // 每 30 秒心跳里补一次合并同步：桌宠端被直接改动/删掉、或重启期间的改动都能收回来
        void syncWithPetTodos().catch((error) => warn(`sync: ${error instanceof Error ? error.message : String(error)}`))
      }, 30_000)
      heartbeat.unref?.()
      disposers.push(() => clearInterval(heartbeat))
      void tick()
      // 启动时把今天已有的记录/感想预热一次摘要：走到这一步说明 DSH 刚起，
      // 用户多半还没点菜单，正好用这段空窗把模型调用跑掉。
      const today = dayEntry(store, dateKeyOf(new Date()))
      warmInBackground('entry', today.entries)
      warmInBackground('thought', today.thoughts)
      // 启动先做一次合并：把已有 plan 投影成带日期待办，不必等到第一个心跳
      void syncWithPetTodos().catch((error) => warn(`initial sync: ${error instanceof Error ? error.message : String(error)}`))
    }

    void boot().catch((error) => warn(`boot: ${error instanceof Error ? error.message : String(error)}`))

    return () => {
      stopped = true
      disposed = true
      for (const dispose of disposers) dispose()
      if (typeof memoryDispose === 'function') {
        try {
          memoryDispose()
        } catch {
          /* 注销失败不影响卸载 */
        }
        memoryDispose = null
      }
      void callPet(base, `${MENU_PATH}?owner=${OWNER}`, { method: 'DELETE' })
      return undefined
    }
  }, 'gongwei: pet menu + scheduler')

  // 工具：让对话能打卡、记录、查状态、出周报
  whenService(['tools'], 'gongwei: tool', (tools) => {
    if (typeof tools.register !== 'function') return () => {}
    return tools.register({
          name: 'gongwei',
          description:
            '工位打卡、每日学习记录、想学的池子（挂在桌宠上的那套数据）。' +
            'action=checkin 打卡（记录今天到工位的时间，并与固定基准、个人近期平均、连续出勤天数一起说明）；' +
            'action=log 追加一条今天的学习记录，text 是要记的内容（事实：看了什么、跑通了什么）；' +
            'action=think 追加一条今天的感想，text 是想说的话（判断、情绪、怀疑方向，单独一栏）；' +
            'action=status 查看今天打卡、今天记录、本周概况、连续出勤；' +
            'action=week 输出本周可复盘的详细统计并写出周报文件，style=stat 出统计表（默认），style=article 出成文版（可直接发公众号）；' +
            'action=week_send 不但生成周报，还把正文直接推到用户微信（长文自动分片），用于「现在就把周报发我」；' +
            'action=config 修改配置，可选 reminder_time / baseline / weekly_time / weekly_day / adopt_untimed_todos / report_copy_dir / stretch_every / stretch_start / stretch_end / stretch_to_im；adopt_untimed_todos=true 表示把桌宠待办里没设截止时间的条目自动收进「想学的」池子（默认开），带截止时间的限期任务不动；report_copy_dir 设了之后每份周报除了插件归档，还会往那个目录（如桌面）另存一份；stretch_every=久坐提醒间隔分钟数（0 关，默认 50），stretch_start/stretch_end 是提醒时段（默认 09:30-18:00，12:00-13:30 午休自动跳过），stretch_to_im=久坐提醒是否也推微信（默认 false，只弹桌宠气泡）；' +
            'action=plan_add 往「想学的池子」里丢一条，text 是想学的东西（想到什么丢什么），可选 due_at 给个截止时间（"2026-11-20 10:20" 或毫秒时间戳）；这条清单已和桌宠「待办事项」合并，带截止时间的会投影成带日期待办，到点桌宠会分档提醒；' +
            'action=plan_list 看池子里有什么（未完成的在前）；' +
            'action=plan_today 看今天划掉了几条、池子里还剩什么；' +
            'action=plan_done 把一条标成做完了，ref 是序号或关键词（序号取自 plan_list 的输出）；会自动往当天学习记录里写一条「看完了想学的：…」；' +
            'action=plan_undo 把划掉的放回池子（同时收回那条自动写的学习记录），ref 同上；' +
            'action=plan_drop 彻底删掉一条，ref 同上；' +
            'action=plan_note 给一条加备注，text 是备注内容。' +
            'action=profile 维护用户的稳定画像（长期记住、每轮生效）：action=profile + profile_action=set_name + text=名字 记住用户给助手起的名字；profile_action=add + text=要记的话 追加一条画像；profile_action=remove + text=关键词 删一条；profile_action=list 查看。' +
            '用户说「打卡」「记一下今天学了什么」「这周怎么样」「连续几天了」「我想学…」「把 X 标成看完了」「池子里还剩什么」，或说「记住xxx」「以后叫你xxx」这类要长期记住的话时用这个工具。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'checkin',
                  'log',
                  'think',
                  'status',
                  'week',
                  'week_send',
                  'config',
                  'profile',
                  'plan_add',
                  'plan_list',
                  'plan_today',
                  'plan_done',
                  'plan_undo',
                  'plan_drop',
                  'plan_note',
                  'plan_import',
                ],
                description: '要执行的动作。',
              },
              text: { type: 'string', description: 'action=log / think / plan_add / plan_note 时的内容；action=profile 时是要记的画像内容或助手名字。' },
              profile_action: {
                type: 'string',
                enum: ['set_name', 'add', 'remove', 'list'],
                description: 'action=profile 时怎么维护画像：set_name 改助手名字 / add 追加一条 / remove 按关键词删 / list 查看。',
              },
              due_at: {
                type: 'string',
                description: 'action=plan_add：可选的截止时间，「2026-11-20 10:20」（本地时区）或毫秒时间戳；不填就是池子里无期限的一条。',
              },
              ref: {
                type: 'string',
                description: 'action=plan_done / plan_undo / plan_drop / plan_note 时指哪一条：序号（1 起，取自 plan_list）或正文关键词。',
              },
              style: {
                type: 'string',
                enum: ['stat', 'article'],
                description: 'action=week：stat 统计表，article 成文版（公众号用）。',
              },
              reminder_time: { type: 'string', description: 'action=config：每日提醒时间 HH:MM。' },
              baseline: { type: 'string', description: 'action=config：打卡基准时间 HH:MM。' },
              weekly_time: { type: 'string', description: 'action=config：周报生成时间 HH:MM。' },
              weekly_day: { type: 'number', description: 'action=config：周报日，1=周一 … 7=周日。' },
              adopt_untimed_todos: {
                type: 'boolean',
                description: 'action=config：是否把桌宠待办里没有截止时间的原生条目自动收进「想学的」池子并补上 [想学] 标记（默认 true；带截止时间的限期任务不动）。',
              },
              report_copy_dir: {
                type: 'string',
                description: 'action=config：周报副本目录（绝对路径，如 D:\\周报备份）。设了就每份周报额外往这里存一份，空字符串取消。',
              },
              stretch_every: {
                type: 'number',
                description: 'action=config：久坐提醒间隔分钟数，0 关闭（默认 50）。按当天打卡时刻起算，工作日且 12:00-13:30 午休跳过。',
              },
              stretch_start: { type: 'string', description: 'action=config：久坐提醒最早时刻 HH:MM（默认 09:30）。' },
              stretch_end: { type: 'string', description: 'action=config：久坐提醒最晚时刻 HH:MM（默认 18:00）。' },
              stretch_to_im: {
                type: 'boolean',
                description: 'action=config：久坐提醒是否同时推到微信（默认 false，只弹桌宠气泡，免得一天十几条）。',
              },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
          },
          execute: async (args) => {
            const action = String(args?.action ?? '')
            if (action === 'checkin') {
              const result = doCheckin()
              await say(result.text)
              return result.text
            }
            if (action === 'log') {
              const result = doLog(args?.text)
              if (result.ok) await say(`记下了：${String(args?.text ?? '').slice(0, 60)}`)
              return result.text
            }
            if (action === 'think') {
              const result = doThink(args?.text)
              if (result.ok) await say(`感想收下了：${String(args?.text ?? '').slice(0, 60)}`)
              return result.text
            }
            if (action === 'status') return doStatus()
            if (action === 'week') {
              const style = args?.style === 'article' ? 'article' : 'stat'
              const { markdown, file, copyFile } = doReport(new Date(), style)
              const tail = copyFile === null ? '' : `；另存一份到 ${copyFile}`
              return `${markdown}\n\n（已写入 ${file}${tail}）`
            }
            if (action === 'week_send') {
              const style = args?.style === 'article' ? 'article' : 'stat'
              const { markdown, file, copyFile } = doReport(new Date(), style)
              const tail = copyFile === null ? '' : `；另存一份到 ${copyFile}`
              if (imOptIn()?.enabled !== true) {
                return `${markdown}\n\n（已写入 ${file}${tail}）\n\n微信提醒通道还没开启，所以没推微信。`
              }
              const sent = await imNotifier.send(`weekly-manual:${Date.now()}`, `小鱼提醒：这周的周报。\n\n${markdown}`)
              if (sent.ok === true) await say('周报已经发到你微信了。')
              else {
                // 手动推也失败：同样挂上补发，别让人再点一遍
                store.meta.weeklyPending = {
                  weekStartKey: dateKeyOf(weekStartOf(new Date())),
                  deadlineAt: new Date().toISOString(),
                  head: '这周的周报',
                  style,
                  attempts: 0,
                  nextAt: Date.now() + WEEKLY_PUSH_RETRY_MS,
                }
                saveStore(store)
              }
              return `${markdown}\n\n（已写入 ${file}${tail}；微信${sent.ok === true ? '已推送' : `推送失败：${sent.code}`}）`
            }
            if (action === 'config') {
              return updateConfig({
                reminderTime: args?.reminder_time,
                baseline: args?.baseline,
                weeklyTime: args?.weekly_time,
                weeklyDay: args?.weekly_day,
                adoptUntimedTodos: args?.adopt_untimed_todos,
                reportCopyDir: args?.report_copy_dir,
                stretchEvery: args?.stretch_every,
                stretchStart: args?.stretch_start,
                stretchEnd: args?.stretch_end,
                stretchToIm: args?.stretch_to_im,
              }).text
            }
            if (action === 'profile') return updateProfile(args?.profile_action, args?.text).text
            if (action === 'plan_add') {
              const result = addPlan(args?.text, new Date(), 'chat', args?.due_at ?? null)
              if (result.ok) await say(`丢进池子了：${String(args?.text ?? '').slice(0, 60)}`)
              return result.text
            }
            if (action === 'plan_list') return planListText()
            if (action === 'plan_today') return doPlan()
            if (action === 'plan_done') {
              const result = finishPlan(args?.ref)
              if (result.ok) await say(`划掉了：${String(args?.ref ?? '').slice(0, 40)}`)
              return result.text
            }
            if (action === 'plan_undo') {
              const result = reopenPlan(args?.ref)
              if (result.ok) await say(`放回池子了：${String(args?.ref ?? '').slice(0, 40)}`)
              return result.text
            }
            if (action === 'plan_drop') return dropPlan(args?.ref).text
            if (action === 'plan_note') return addPlanNote(args?.ref, args?.text).text
            if (action === 'plan_import') return importPetTodos().text
            return `不认识的 action「${action}」。可用：checkin / log / think / status / week / config / profile / plan_add / plan_list / plan_today / plan_done / plan_undo / plan_drop / plan_note。`
          },
        })
  })

  /**
   * 把一行 `/gongwei ...` 拆成动词 + 内容。
   *
   * 不能只按空白切：中文打字的习惯是「想学：把 RetNet 搞明白」，冒号后面不加空格，
   * 整串就会被当成一个不认识的动词。所以这里按「已知动词表 + 最长匹配 + 可选分隔符」来拆，
   * 分隔符接受空格、半角/全角冒号、逗号、顿号，以及中文句式的「一下」。
   *
   * SYNONYMS 里的顺序即优先级：'想学' 必须排在 '想' 前面，否则「想学 X」会被当成「想 学 X」。
   */
  const VERB_TABLE = [
    ['想学', ['想学', '想学习', '学', 'learn', 'plan', 'add', '添加', '加', '新增', '记到池子', '丢进池子']],
    ['记', ['记', '记录', 'log', '记一下', '记一笔', '记一条', '记下']],
    ['感想', ['感想', '想', 'think', '想法']],
    ['打卡', ['打卡', 'checkin', '签到', '到了']],
    ['池子', ['池子', '计划', 'plan-list', 'list', '清单']],
    ['今天', ['今天', 'today']],
    ['完了', ['完了', '做完', 'done', 'finish', '划掉']],
    ['撤销', ['撤销', '放回', 'undo', '恢复']],
    ['删', ['删', '删掉', 'drop', 'rm', '删除']],
    ['搬', ['搬', '导入', 'import', '搬过来']],
    ['状态', ['状态', 'status', '战绩']],
    ['周报', ['周报', 'week', '统计']],
    ['公众号', ['公众号', 'article', '成文']],
  ]

  /** 动词别名 → 规范动词，长的在前，保证最长匹配。 */
  const VERB_ALIASES = VERB_TABLE.flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [alias.toLowerCase(), canonical]),
  ).sort((a, b) => b[0].length - a[0].length)

  /** 动词后面可能跟着的分隔符：空白、冒号（半角/全角）、逗号、顿号、破折号。 */
  const SEPARATOR = /^[\s:：,，、\-—]+/

  function parseCommand(raw) {
    let rest = String(raw ?? '').trim()
    // 「我想学 xxx」「帮我记 xxx」这种：去掉开头的口头主语，不影响后面匹配
    rest = rest.replace(/^(?:请|帮我|麻烦|我要|我想|我想要|我)\s*/, '')
    const lower = rest.toLowerCase()
    for (const [alias, canonical] of VERB_ALIASES) {
      if (!lower.startsWith(alias)) continue
      const tail = rest.slice(alias.length)
      // 别名后面必须紧跟分隔符或到结尾，否则「想学习」不会被误当成「想学 习」
      if (tail !== '' && !SEPARATOR.test(tail)) continue
      return { verb: canonical, text: tail.replace(SEPARATOR, '').trim() }
    }
    // 认不出来就是认不出来：绝不回落到某个默认动作。
    // （早先 verb === '' 走的是打卡，结果「胡说八道」这种打错的东西会静默变成一次打卡，
    //   把打卡时间也一并改掉。宁可报错让人重打一遍。）
    return { verb: '', text: rest, unknown: rest !== '' }
  }

  // 斜杠命令：/gongwei 打卡 | /gongwei 记 <内容> | /gongwei 状态 | /gongwei 周报
  whenService(['commands'], 'gongwei: command', (commands) => {
    if (typeof commands.register !== 'function') return () => {}
    return commands.register({
          name: 'gongwei',
          description:
            '工位打卡与学习记录：/gongwei 打卡｜记 <内容>｜感想 <内容>｜想学 <内容>｜池子｜完了 <序号>｜状态｜周报｜公众号',
          input: { hint: '打卡 / 记 <内容> / 感想 <内容> / 想学 <内容> / 池子 / 完了 <序号> / 状态 / 周报 / 公众号' },
          handler: async (invocation) => {
            const { verb, text, unknown } = parseCommand(invocation?.rawInput)
            if (verb === '' && unknown) {
              return {
                kind: 'error',
                text: `不认识「${text.slice(0, 20)}」这个说法。用法：/gongwei 打卡｜记 <内容>｜感想 <内容>｜想学 <内容>｜池子｜今天｜完了 <序号>｜撤销 <序号>｜删 <序号>｜搬｜状态｜周报｜公众号`,
              }
            }
            if (verb === '' || verb === '打卡') {
              const result = doCheckin()
              await say(result.text)
              return { kind: 'success', text: result.text }
            }
            if (verb === '记') {
              const result = doLog(text)
              if (result.ok) await say(`记下了：${text.slice(0, 60)}`)
              return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
            }
            if (verb === '感想') {
              const result = doThink(text)
              if (result.ok) await say(`感想收下了：${text.slice(0, 60)}`)
              return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
            }
            if (verb === '想学') {
              const { text: clean, dueRaw } = extractDue(text)
              const result = addPlan(clean, new Date(), 'chat', dueRaw)
              if (result.ok) await say(`丢进池子了：${clean.slice(0, 60)}`)
              return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
            }
            if (verb === '池子') {
              return { kind: 'success', text: planListText() }
            }
            if (verb === '今天') return { kind: 'success', text: doPlan() }
            if (verb === '完了') {
              const result = finishPlan(text)
              if (result.ok) await say(`划掉了：${text.slice(0, 40)}`)
              return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
            }
            if (verb === '撤销') {
              const result = reopenPlan(text)
              return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
            }
            if (verb === '删') {
              const result = dropPlan(text)
              return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
            }
            if (verb === '搬') {
              const result = importPetTodos()
              return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text }
            }
            if (verb === '状态') return { kind: 'success', text: doStatus() }
            if (verb === '周报') {
              const { markdown, file } = doReport(new Date(), 'stat')
              return { kind: 'success', text: `${markdown}\n\n（已写入 ${file}）` }
            }
            if (verb === '公众号') {
              const { markdown, file } = doReport(new Date(), 'article')
              return { kind: 'success', text: `${markdown}\n\n（已写入 ${file}）` }
            }
            return {
              kind: 'error',
              text: '用法：/gongwei 打卡｜记 <内容>｜感想 <内容>｜想学 <内容>｜池子｜今天｜完了 <序号>｜撤销 <序号>｜删 <序号>｜搬（从桌宠待办导入）｜状态｜周报｜公众号',
            }
          },
        })
  })

  // 持久记忆：每轮对话都能看到最近的打卡与记录摘要
  whenService(['systemPrompt'], 'gongwei: memory section', (systemPrompt) => {
    if (typeof systemPrompt.section !== 'function') return () => {}
    return systemPrompt.section({
          name: 'gongwei-memory',
          order: 73,
          text: () => {
            const lines = ['## 工位打卡与学习记录（gongwei 插件的持久记忆）']
            lines.push(...memoryFacts())
            lines.push(
              '- 用户说「打卡」「记一下今天学了什么」「这周怎么样」「我想学 XXX」「这个看完了」时，调用 gongwei 工具，不要自己编造。',
            )
            return lines.join('\n')
          },
        })
  })

  log(`ready; data at ${STATE_FILE}`)
}

/**
 * 只给冒烟测试用的内部函数出口。
 *
 * 这几件事（截断在哪断、气泡停多久）都靠肉眼看气泡是验不准的，
 * 必须能在测试里直接拿数字断言。它们本身是纯函数，导出没有副作用。
 */
export const __test = { clip, bubbleDuration, flatText }

