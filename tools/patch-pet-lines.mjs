#!/usr/bin/env node
// 让桌宠的纯文本气泡保留换行（纯 CSS，不改内容、不执行 Markdown）。
//
// 用法：
//   node tools/patch-pet-lines.mjs             打补丁（幂等）
//   node tools/patch-pet-lines.mjs --check     只看状态
//   node tools/patch-pet-lines.mjs --restore   从 *.pre-lines.orig 还原成上游原样
//   node tools/patch-pet-lines.mjs --pkg <dsh-pet 目录>
//
// 打之前会把原文件备份成 <文件>.pre-lines.orig（已存在则不覆盖）。
// 锚点找不到时直接报错退出，不会写坏文件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (flag(name) ? args[args.indexOf(name) + 1] : undefined)

const root =
  option('--pkg') ??
  path.join(
    process.env.DSH_PROFILE_DIR ??
      path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'desktop'),
    'node_modules',
    'dsh-pet',
  )

const marker = '/* gongwei-numbered-lines */'
const desktop = path.join(root, 'runtime/electron-helper/index.html')
const web = path.join(root, 'lib/client.js')

const webAnchor =
  '".dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--f)*0.6593);flex-wrap:wrap}",'
const rule = '.pet-bubble.is-whisper .pet-bub-row{display:block;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow-y:auto;pointer-events:auto;}'

function statusOf(file) {
  if (!fs.existsSync(file)) return 'missing'
  return fs.readFileSync(file, 'utf8').includes(marker) ? 'patched' : 'pristine'
}

function restoreOne(file, label) {
  const backup = `${file}.pre-lines.orig`
  if (!fs.existsSync(backup)) {
    console.log(`  跳过 ${label}：没有备份 ${path.basename(backup)}`)
    return
  }
  fs.copyFileSync(backup, file)
  console.log(`  已还原 ${label}`)
}

function patchOne(file, label) {
  if (!fs.existsSync(file)) {
    console.log(`  跳过 ${label}：文件不存在 ${file}`)
    return false
  }
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(marker)) {
    console.log(`  已经是打过的状态 ${label}`)
    return true
  }
  let next
  if (file === desktop) {
    if (!text.includes('</style>')) {
      throw new Error(`${label}: 找不到 </style> 锚点，dsh-pet 版本可能变了`)
    }
    next = text.replace('</style>', `${marker}\n${rule}\n</style>`)
  } else {
    if (!text.includes(webAnchor)) {
      throw new Error(`${label}: 找不到 .pet-bub-row 样式锚点，dsh-pet 版本可能变了`)
    }
    next = text.replace(webAnchor, `${webAnchor}\n${JSON.stringify(`${marker}.dsh-pet-bubble.is-whisper .pet-bub-row${rule.slice(rule.indexOf('{'))}`)},`)
  }
  if (!fs.existsSync(`${file}.pre-lines.orig`)) fs.copyFileSync(file, `${file}.pre-lines.orig`)
  fs.writeFileSync(file, next, 'utf8')
  console.log(`  已打补丁 ${label}`)
  return true
}

if (!fs.existsSync(root)) {
  console.error(`找不到 dsh-pet 目录：${root}`)
  console.error('用 --pkg 指定，或先装 dsh-pet（它是可选依赖）。')
  process.exit(1)
}

console.log(`dsh-pet: ${root}`)

if (flag('--check')) {
  console.log(`  桌面端 ${statusOf(desktop)}   ${desktop}`)
  console.log(`  网页端 ${statusOf(web)}   ${web}`)
  process.exit(0)
}

if (flag('--restore')) {
  restoreOne(desktop, '桌面端')
  restoreOne(web, '网页端')
  console.log('还原完成。重载桌面 Helper（POST /dsh-pet-7340/reload）并刷新网页后生效。')
  process.exit(0)
}

patchOne(desktop, '桌面端')
patchOne(web, '网页端')
console.log('完成。重载桌面 Helper（POST /dsh-pet-7340/reload），网页端刷新页面。')
