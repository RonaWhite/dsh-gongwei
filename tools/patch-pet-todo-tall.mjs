/**
 * 让「待办事项」面板能一次看到更多条目。
 *
 * 现象（用户 2026-11-26 反馈）：待办有十几条，但面板一次只露出两行，往下翻也不顺手。
 * 根因在 dsh-pet 客户端：`const LIST_ROWS = 2;` —— 清单高度被硬编码成「量一次行高 × 2」，
 * 而且每条未完成项下面都固定压一行「无期限」副标题，明明没截止时间也占一整行，
 * 于是 2 行只装得下 2 条，翻起来像挤牙膏。
 *
 * 改法三步，都只在渲染层，不碰数据：
 *   1. `LIST_ROWS` 2 → 6，并按可视高度再夹一次（最少保留 2 行），高窗口能多看、矮窗口不顶出屏幕。
 *   2. 「无期限」这类纯噪声副标题不再占行——只有带截止时间（或已完成）的条目才显示副标题，
 *      大多数条目因此从两行变一行，同样高度能装的条目翻倍。
 *   3. 给清单加一条常驻的细滚动条样式，让人一眼看出「下面还有」。
 *
 * 面板整体高度由 `TODO_PANEL_METRICS` 里的日历尺寸兜底，清单涨到 6 行仍在预算内，
 * 所以桌宠窗口的上边距不用跟着改（`todoPanelTopMarginPx` 取的是 max(清单+提示, 日历)）。
 *
 * 桌面 Helper（runtime/electron-helper/shared-core.js）与网页端（lib/client.js）各一份，都要打。
 * dsh-pet 升级后需要重跑本补丁，然后 POST /dsh-pet-7340/reload（网页端刷新页面）。
 *
 * 用法：
 *   node tools/patch-pet-todo-tall.mjs --check
 *   node tools/patch-pet-todo-tall.mjs
 *   node tools/patch-pet-todo-tall.mjs --restore
 *   node tools/patch-pet-todo-tall.mjs --pkg <dsh-pet 目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MARKER = '/* dsh-pet-todo-tall v1 */';
const BACKUP_SUFFIX = '.pre-todotall.orig';
const ROWS = 6;

const TARGETS = [path.join('runtime', 'electron-helper', 'shared-core.js'), path.join('lib', 'client.js')];

function defaultPkg() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-pet');
}

function parseArgs(argv) {
  const out = { check: false, restore: false, pkg: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--restore') out.restore = true;
    else if (a === '--pkg') out.pkg = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function countMatches(haystack, re) {
  const all = haystack.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  return all === null ? 0 : all.length;
}

/** 三个替换点；每个都是「恰好命中一次」才算安全，否则整体放弃这个文件。 */
function buildEdits() {
  return [
    {
      name: 'LIST_ROWS',
      from: /const LIST_ROWS = 2;/,
      to: `const LIST_ROWS = ${ROWS}; ${MARKER} // 原来写死 2，一次只露两行，十几条待办根本翻不过来`,
    },
    {
      name: 'capListHeight',
      // 网页端 bundle 里 pad 被重命名成 pad$1，所以变量名要回填
      from: /^(\t)list\.style\.maxHeight = rowHeight \* LIST_ROWS \+ (pad(?:\$1)?) \* 2 \+ "px";$/m,
      to: (m) => {
        const pad = m[2];
        return [
          `\tlet px = rowHeight * LIST_ROWS + ${pad} * 2;`,
          `\t${MARKER}`,
          '\t// 面板挂在宠物头顶，清单太高会顶出屏幕：既给「最多 N 行」，也按当前可视高度夹一次，最少保留 2 行。',
          '\tconst panelRoot = list.closest(".dsh-pet-todo");',
          '\tconst panelRect = (panelRoot ?? list).getBoundingClientRect();',
          '\tconst others = Math.max(0, panelRect.height - list.getBoundingClientRect().height);',
          '\tconst room = typeof window === "undefined" ? 0 : window.innerHeight - 16 - others;',
          `\tif (room > 0) px = Math.min(px, Math.max(rowHeight * 2 + ${pad} * 2, room));`,
          '\tlist.style.maxHeight = px + "px";',
        ].join('\n');
      },
    },
    {
      name: 'renderItem',
      from: /^(\t)const text = element\("div", "dsh-pet-todo-text", todo\.text\);\n\tconst meta = element\("div", "dsh-pet-todo-meta", metaLabel\(todo, now\)\);\n\tmain\.append\(text, meta\);$/m,
      to: () =>
        [
          `\t${MARKER}`,
          '\t// [想学] 是 gongwei 写进文本里的内部标记，直接当正文显示既丑又占宽度：渲染时换成一个小徽章。',
          '\tconst wantLearn = todo.text.startsWith("[想学] ");',
          '\tconst shown = wantLearn ? todo.text.slice("[想学] ".length) : todo.text;',
          '\tconst text = element("div", "dsh-pet-todo-text");',
          '\tif (wantLearn) {',
          '\t\ttext.append(element("span", "dsh-pet-todo-badge", "想学"), document.createTextNode(shown));',
          '\t} else {',
          '\t\ttext.textContent = shown;',
          '\t}',
          '\tconst meta = element("div", "dsh-pet-todo-meta", metaLabel(todo, now));',
          '\t// 「无期限」占一整行纯属噪声：只有真的有截止时间（或已完成要标一下）才挂副标题，',
          '\t// 大多数条目因此从两行变一行，同样高度能装的条目翻倍。',
          '\tmain.append(text);',
          '\tif (todo.done || todo.dueAt !== null) main.append(meta);',
        ].join('\n'),
    },
    {
      name: 'badgeCss',
      from: /^(\t)"\.dsh-pet-todo-text\{overflow-wrap:anywhere;white-space:pre-wrap\}",$/m,
      to: () =>
        [
          '\t".dsh-pet-todo-text{overflow-wrap:anywhere;white-space:pre-wrap}",',
          '\t".dsh-pet-todo-badge{display:inline-block;margin-right:.385em;padding:0 .462em;border-radius:.385em;",',
          '\t"background:rgba(74,125,255,.13);color:#3f6fd8;font-size:.846em;line-height:1.55;vertical-align:.077em}",',
        ].join('\n'),
    },
    {
      name: 'scrollbar',
      from: /^(\t)"flex:0 1 auto;min-height:0;scrollbar-width:thin}",$/m,
      to: (m) =>
        [
          `\t${MARKER}`,
          '\t"flex:0 1 auto;min-height:0;scrollbar-width:thin;border-radius:.615em}",',
          '\t".dsh-pet-todo-list::-webkit-scrollbar{width:6px}",',
          '\t".dsh-pet-todo-list::-webkit-scrollbar-thumb{background:rgba(43,43,43,.2);border-radius:3px}",',
          '\t".dsh-pet-todo-list::-webkit-scrollbar-thumb:hover{background:rgba(43,43,43,.36)}",',
          '\t".dsh-pet-todo-list::-webkit-scrollbar-track{background:transparent}",',
        ].join('\n'),
    },
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node tools/patch-pet-todo-tall.mjs [--check|--restore] [--pkg <dsh-pet 目录>]');
    return;
  }
  const pkg = args.pkg ? path.resolve(args.pkg) : defaultPkg();
  const files = TARGETS.map((rel) => ({ rel, file: path.join(pkg, rel) }));

  const missing = files.filter((f) => !fs.existsSync(f.file));
  if (missing.length > 0) {
    console.error('找不到这些文件，dsh-pet 可能升级改了结构：');
    for (const m of missing) console.error(`  ${m.file}`);
    process.exitCode = 1;
    return;
  }

  if (args.restore) {
    for (const f of files) {
      const backup = f.file + BACKUP_SUFFIX;
      if (!fs.existsSync(backup)) {
        console.log(`（无备份，跳过）${f.rel}`);
        continue;
      }
      fs.copyFileSync(backup, f.file);
      console.log(`已还原 ${f.rel}`);
    }
    return;
  }

  let failed = false;
  for (const f of files) {
    const src = fs.readFileSync(f.file, 'utf8');
    if (args.check) {
      console.log(`${src.includes(MARKER) ? 'patched  ' : 'clean    '} ${f.rel}`);
      continue;
    }
    if (src.includes(MARKER)) {
      console.log(`（已打过，跳过）${f.rel}`);
      continue;
    }

    const crlf = src.includes('\r\n');
    let out = crlf ? src.replace(/\r\n/g, '\n') : src;
    const bad = [];
    for (const edit of buildEdits()) {
      const n = countMatches(out, edit.from);
      if (n !== 1) {
        bad.push(`${edit.name}：命中 ${n} 次（期望 1）`);
        continue;
      }
      const replaced = out.replace(edit.from, typeof edit.to === 'function' ? (...m) => edit.to(m) : edit.to);
      out = replaced;
    }
    if (bad.length > 0) {
      console.error(`放弃改 ${f.rel}（dsh-pet 可能升级改了代码）：`);
      for (const b of bad) console.error(`  ${b}`);
      failed = true;
      continue;
    }

    if (!fs.existsSync(f.file + BACKUP_SUFFIX)) fs.copyFileSync(f.file, f.file + BACKUP_SUFFIX);
    fs.writeFileSync(f.file, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
    console.log(`已打补丁 ${f.rel}`);
  }

  if (!args.check) {
    console.log('记得 reload Helper：POST /dsh-pet-7340/reload（网页端还要刷新页面）');
    if (failed) process.exitCode = 1;
  }
}

main();
