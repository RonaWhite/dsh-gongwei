/**
 * 修「待办面板探到屏幕外，输入框和『添加』看不见/点不到」。
 *
 * 现象：DSH 跑对话时（其实任何时候都可能）右键桌宠 →「待办事项」，面板能弹出、列表也能加载，
 * 但面板是挂在宠物头顶上的气泡，宠物贴屏幕顶边时整块面板会探到屏幕外——
 * 标题、输入框、「添加」按钮全在最上面，用户在屏幕上只能看到下面几行列表，
 * 于是「加不了待办」。
 *
 * 实测（2026-11-25，桌宠默认右上角、marginY=100）：
 *   窗口本地 rect = {x:293, y:100, w:337, h:293}，窗口 top = -243
 *   → 面板屏幕顶边 = -143，只有最下面 150px 在屏幕内。
 *
 * 改法：给面板根节点加一个「夹回可视区」的位移（transform: translateY），
 * 顶边不够就整体下移、底边不够就上移；用 ResizeObserver 跟随每次重载后的高度变化。
 * 偏移量只作用于面板自己，宠物位置、窗口位置都不动；
 * 渲染端上报的控件矩形走 getBoundingClientRect（含 transform），所以命中区会自动跟上。
 *
 * 桌面 Helper（runtime/electron-helper/shared-core.js）与网页端（lib/client.js）各一份，都要打。
 * dsh-pet 升级后需要重跑本补丁，然后 POST /dsh-pet-7340/reload（网页端刷新页面）。
 *
 * 用法：
 *   node tools/patch-pet-todo-onscreen.mjs --check
 *   node tools/patch-pet-todo-onscreen.mjs
 *   node tools/patch-pet-todo-onscreen.mjs --restore
 *   node tools/patch-pet-todo-onscreen.mjs --pkg <dsh-pet 目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MARKER = '/* dsh-pet-todo-onscreen v1 */';
const BACKUP_SUFFIX = '.pre-todoonscreen.orig';

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

const ANCHOR_CALL = `\tparts.empty.textContent = "加载中…";
\tparts.empty.hidden = false;
\treload();
\treturn {
\t\tel: parts.root,`;

const PATCHED_CALL = `\tparts.empty.textContent = "加载中…";
\tparts.empty.hidden = false;
\treload();
\t${MARKER}
\t// 面板挂在宠物头顶上：宠物贴屏幕顶边时整块会探到屏幕外（输入框和「添加」都在最上面），
\t// 用户只能看到下面几行列表，于是"加不了待办"。这里把面板夹回可视区，只位移面板自己。
\tconst keepOnScreen = () => {
\t\tif (disposed) return;
\t\tparts.root.style.transform = "";
\t\tconst rect = parts.root.getBoundingClientRect();
\t\tif (rect.height <= 0) return;
\t\tconst pad = 8;
\t\tlet dy = 0;
\t\tif (rect.top < pad) dy = pad - rect.top;
\t\telse if (rect.bottom > window.innerHeight - pad) dy = window.innerHeight - pad - rect.bottom;
\t\tif (dy !== 0) parts.root.style.transform = "translateY(" + dy + "px)";
\t};
\tconst onScreenWatch = typeof ResizeObserver === "function" ? new ResizeObserver(() => keepOnScreen()) : null;
\tonScreenWatch?.observe(parts.root);
\twindow.addEventListener("resize", keepOnScreen);
\tkeepOnScreen();
\treturn {
\t\tel: parts.root,`;

const ANCHOR_DISPOSE = `\t\t\tdocument.removeEventListener("mousedown", onDocMouseDown, true);
\t\t\tparts.duePicker.dispose();
\t\t\tparts.root.remove();`;

const PATCHED_DISPOSE = `\t\t\tdocument.removeEventListener("mousedown", onDocMouseDown, true);
\t\t\t${MARKER}
\t\t\tonScreenWatch?.disconnect();
\t\t\twindow.removeEventListener("resize", keepOnScreen);
\t\t\tparts.duePicker.dispose();
\t\t\tparts.root.remove();`;

const TARGETS = [
  path.join('runtime', 'electron-helper', 'shared-core.js'),
  path.join('lib', 'client.js'),
];

function countOccur(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node tools/patch-pet-todo-onscreen.mjs [--check|--restore] [--pkg <dsh-pet 目录>]');
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
    for (const [from, to] of [
      [ANCHOR_CALL, PATCHED_CALL],
      [ANCHOR_DISPOSE, PATCHED_DISPOSE],
    ]) {
      const n = countOccur(out, from);
      if (n !== 1) bad.push(`锚点出现 ${n} 次（期望 1）：${from.split('\n')[0].trim()}`);
      else out = out.replace(from, to);
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
