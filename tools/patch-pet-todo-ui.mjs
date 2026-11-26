#!/usr/bin/env node
/**
 * 待办面板的一组小改动（本地补丁，作用在已安装的 dsh-pet 上）。
 *
 * 五点：
 *   1. 排序：没有截止时间的待办按「新添加的在前」（原来旧的在前，用户说搞反了）——宿主侧那份才是 /todos 的顺序来源
 *   2. 右侧三个图标收窄，把宽度还给正文
 *   3. 清单从 6 行降到 5 行，避免面板压到桌宠身上
 *   4. 保存请求超时 20s → 8s
 *   5. 忙碌态一定有提示、一定复位（对话进行中不会像死了一样）
 *
 * 用法：
 *   node tools/patch-pet-todo-ui.mjs            打补丁（幂等）
 *   node tools/patch-pet-todo-ui.mjs --check    只看状态
 *   node tools/patch-pet-todo-ui.mjs --restore  从 .orig 还原
 *   node tools/patch-pet-todo-ui.mjs --pkg <dir> 指定 dsh-pet 包目录
 *
 * 每个文件要求改动集合完全命中，任何一处锚点缺失或重复都整体放弃（不写坏文件）。
 * 备份后缀 .pre-todoui.orig。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 幂等标记：出现在改过的排序行与忙碌态注释里。 */
const MARKER = '/* dsh-pet-todo-ui v1 */';
/** 备份后缀。 */
const BACKUP_SUFFIX = '.pre-todoui.orig';

/** 宿主包里的待办排序：`/todos` 返回的顺序由它决定，桌面端与网页端都吃这份。 */
const HOST_INDEX = 'lib/index.js';
/** 桌面端（Electron Helper）的共享核心，含待办面板的渲染与状态。 */
const DESKTOP_CORE = 'runtime/electron-helper/shared-core.js';
/** 网页端的客户端 bundle。 */
const WEB_CLIENT = 'lib/client.js';

/** 每个文件要做的改动名。 */
const PLAN = {
  [HOST_INDEX]: ['sort'],
  [DESKTOP_CORE]: ['sort', 'rows', 'icons', 'timeout', 'mutate'],
  [WEB_CLIENT]: ['rows', 'icons', 'timeout', 'mutate'],
};

/** 全部改动的定义：名称 → [锚点, 替换文本]。 */
const EDITS = {
  sort: [
    'return a.createdAt - b.createdAt;',
    `return b.createdAt - a.createdAt; ${MARKER} // 没有截止时间的按新添加的在前（原来旧的在前）`,
  ],
  rows: [
    'const LIST_ROWS = 6; /* dsh-pet-todo-tall v1 */ // 原来写死 2，一次只露两行，十几条待办根本翻不过来',
    `const LIST_ROWS = 5; /* dsh-pet-todo-tall v1 */ // 原来写死 2；先提到 6 又压到桌宠，现在 5 行 ${MARKER}`,
  ],
  icons: [
    [
      'padding:calc(var(--t)*0.308) calc(var(--t)*0.28);border-radius:.462em;cursor:pointer;flex:0 0 auto;min-width:calc(var(--t)*1.1)}',
      `padding:calc(var(--t)*0.18) calc(var(--t)*0.14);border-radius:.462em;cursor:pointer;flex:0 0 auto;min-width:calc(var(--t)*0.85)} ${MARKER}`,
    ],
    [
      'padding:calc(var(--t)*0.308) calc(var(--t)*0.385);border-radius:.462em;cursor:pointer;flex:0 0 auto;',
      `padding:calc(var(--t)*0.18) calc(var(--t)*0.18);border-radius:.462em;cursor:pointer;flex:0 0 auto; ${MARKER}`,
    ],
    ['"min-width:calc(var(--t)*1.692)}"', '"min-width:calc(var(--t)*1.05)}"'],
    [
      '.dsh-pet-todo-row{display:flex;align-items:center;gap:.462em}',
      '.dsh-pet-todo-row{display:flex;align-items:center;gap:.3em}',
    ],
  ],
  timeout: ['signal: AbortSignal.timeout(20000),', `signal: AbortSignal.timeout(8000), ${MARKER}`],
  mutate: [
    `	async function mutate(task) {
		if (disposed || busy) return;
		busy = true;
		setTodoBusy(parts, true);
		setTodoError(parts, null);
		const result = await task();
		busy = false;
		if (disposed) return;
		setTodoBusy(parts, false);
		if (!result.ok) {
			setTodoError(parts, result.message);
			return;
		}
		await reload();
	}`,
    `	async function mutate(task) {
		// ${MARKER} 正在存上一条时说清楚，别把点击静默吞掉；无论如何都要把忙碌态复位。
		if (disposed) return;
		if (busy) {
			setTodoError(parts, "正在保存上一条，稍等一下再试。");
			return;
		}
		busy = true;
		setTodoBusy(parts, true);
		setTodoError(parts, null);
		try {
			const result = await task();
			if (disposed) return;
			if (!result.ok) {
				setTodoError(parts, result.message);
				return;
			}
			await reload();
		} catch (error) {
			if (!disposed) setTodoError(parts, "保存失败：" + (error instanceof Error ? error.message : String(error)));
		} finally {
			busy = false;
			if (!disposed) setTodoBusy(parts, false);
		}
	}`,
  ],
};

/**
 * 把一段文本替换成另一段，要求原文恰好出现一次。
 * @param {string} source 原文件内容
 * @param {string} needle 要被替换的原文
 * @param {string} replacement 替换后的文本
 * @param {string} label 出错时用于指路的名字
 * @returns {string} 替换后的内容
 */
function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`找不到锚点：${label}`);
  const second = source.indexOf(needle, first + 1);
  if (second >= 0) throw new Error(`锚点出现不止一次：${label}`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

/**
 * 对一份文件内容按其改动计划做替换。
 * @param {string} source 原内容
 * @param {readonly string[]} names 该文件要做的改动名
 * @returns {string} 改完的内容
 */
function patchSource(source, names) {
  let out = source;
  for (const name of names) {
    const spec = EDITS[name];
    if (spec === undefined) throw new Error(`未知改动 ${name}`);
    const pairs = Array.isArray(spec[0]) ? spec : [spec];
    for (const [needle, replacement] of pairs) out = replaceOnce(out, needle, replacement, `${name}`);
  }
  return out;
}

/** 解析包目录：显式 --pkg 优先，否则按环境变量探测。 */
function resolvePkgDir(argv) {
  const at = argv.indexOf('--pkg');
  if (at >= 0 && argv[at + 1]) return path.resolve(argv[at + 1]);
  const candidates = [
    process.env.DSH_PROFILE_DIR && path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'dsh-pet'),
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-pet'),
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  throw new Error('找不到 dsh-pet 包目录，用 --pkg <dir> 指定。');
}

const argv = process.argv.slice(2);
const mode = argv.includes('--check') ? 'check' : argv.includes('--restore') ? 'restore' : 'patch';
const pkgDir = resolvePkgDir(argv);

for (const [rel, names] of Object.entries(PLAN)) {
  const file = path.join(pkgDir, rel);
  if (!fs.existsSync(file)) {
    console.log(`[skip] ${rel} 不存在`);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  const patched = source.includes(MARKER) || source.includes('dsh-pet-todo-tall v1 */ // 原来写死 2；先提到 6');

  if (mode === 'check') {
    console.log(`${patched ? 'patched  ' : 'pristine '} ${rel}`);
    continue;
  }

  if (mode === 'restore') {
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) {
      console.log(`[skip] ${rel} 没有备份 ${path.basename(backup)}`);
      continue;
    }
    fs.copyFileSync(backup, file);
    console.log(`restored ${rel}`);
    continue;
  }

  if (source.includes(MARKER)) {
    console.log(`[skip] ${rel} 已经是打过的状态`);
    continue;
  }

  let next;
  try {
    next = patchSource(source, names);
  } catch (error) {
    console.error(`[abort] ${rel}: ${error.message}（文件未改动）`);
    process.exitCode = 1;
    continue;
  }

  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, next);
  console.log(`patched ${rel}（备份 ${path.basename(backup)}）`);
}

if (mode === 'patch') {
  console.log('\n改完要重启桌宠 Helper 才生效，网页端还要刷新页面：');
  console.log('  node -e "fetch(\'http://127.0.0.1:<端口>/dsh-pet-7340/reload\',{method:\'POST\',headers:{\'content-type\':\'application/json\'},body:\'{}\'}).then(r=>r.text()).then(console.log)"');
}
