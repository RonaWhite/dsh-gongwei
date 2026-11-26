/**
 * 给 dsh-pet 桌面 Helper 的「点击穿透 / 键盘焦点」链路加诊断日志。
 *
 * 背景：用户在 DSH 跑对话时右键桌宠 →「待办事项」→ 点输入框打字，打不进去。
 * 屏幕级复现发现：
 *   - 右键菜单能弹出、待办面板能弹出、列表能加载（前半段是通的）；
 *   - 点面板输入框后，前台窗口有时仍是 DSH，于是键盘落到 DSH；
 *   - 再点一次宠物身体又能拿到焦点，输入框才能打字。
 * 说明「窗口穿透翻转」与「键盘焦点」这两条链在特定时刻没对上。
 *
 * 这个补丁只加日志、不改行为，用来一次抓齐：
 *   setWindowIgnore 的每次翻转（唯一出口）、
 *   渲染端上报的控件矩形（input-regions）、
 *   主进程算出的 ignoring 及其输入（set-interactive）、
 *   键盘焦点请求前后 win.isFocused()。
 *
 * 日志前缀 `[dsh-pet-input-diag]`，进 C:\Users\<你>\.dsh\dsh-pet\logs.txt。
 *
 * 用法：
 *   node tools/patch-pet-input-diag.mjs --check
 *   node tools/patch-pet-input-diag.mjs
 *   node tools/patch-pet-input-diag.mjs --restore
 *   node tools/patch-pet-input-diag.mjs --pkg <dsh-pet 目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MARKER = '/* dsh-pet-input-diag v1 */';
const BACKUP_SUFFIX = '.pre-inputdiag.orig';
const TAG = '[dsh-pet-input-diag]';

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

/* ---------- ipc.js：set-interactive 的裁定输入 ---------- */

const IPC_ANCHOR_INTERACTIVE = `        : !interactive;
    petWindows.setWindowIgnore(win, ignoring);
  });`;

const IPC_PATCHED_INTERACTIVE = `        : !interactive;
    ${MARKER}
    console.error(
      '${TAG} set-interactive=' + interactive +
        ' busy=' + (petWindows.state.inputBusy.get(win.id) === true) +
        ' ignoring=' + ignoring +
        ' rects=' + ((input && input.rects && input.rects.length) || 0) +
        ' margins=' + JSON.stringify(petWindows.state.winMargins.get(win.id) || null) +
        ' bounds=' + JSON.stringify(win.getContentBounds()) +
        ' cursor=' + JSON.stringify(screen.getCursorScreenPoint()),
    );
    petWindows.setWindowIgnore(win, ignoring);
  });`;

const IPC_ANCHOR_REGIONS = `    petWindows.state.inputRegions.set(win.id, { dragging: input.dragging === true, rects });
  });`;

const IPC_PATCHED_REGIONS = `    petWindows.state.inputRegions.set(win.id, { dragging: input.dragging === true, rects });
    ${MARKER}
    console.error(
      '${TAG} input-regions busy=' + (petWindows.state.inputBusy.get(win.id) === true) +
        ' dragging=' + (input.dragging === true) +
        ' n=' + rects.length +
        ' rects=' + JSON.stringify(rects),
    );
  });`;

const IPC_ANCHOR_FOCUS = `    if (!win || win.isDestroyed() || win.isFocused()) return;
    win.focus();
    win.webContents.focus();
  });`;

const IPC_PATCHED_FOCUS = `    ${MARKER}
    console.error(
      '${TAG} keyboard-focus requested focusedBefore=' +
        (!!win && !win.isDestroyed() && win.isFocused()),
    );
    if (!win || win.isDestroyed() || win.isFocused()) return;
    win.focus();
    win.webContents.focus();
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) console.error('${TAG} keyboard-focus focusedAfter=' + win.isFocused());
      } catch {
        /* 窗口已销毁：忽略 */
      }
    }, 300);
  });`;

/* ---------- windows.js：穿透翻转的唯一出口 ---------- */

const WIN_ANCHOR = `  function setWindowIgnore(win, ignore) {
    win.setIgnoreMouseEvents(ignore, { forward: true });
    windowIgnore.set(win.id, ignore);
  }`;

const WIN_PATCHED = `  function setWindowIgnore(win, ignore) {
    ${MARKER}
    console.error(
      '${TAG} setWindowIgnore=' + ignore + ' win=' + win.id + ' same=' + (windowIgnore.get(win.id) === ignore),
    );
    win.setIgnoreMouseEvents(ignore, { forward: true });
    windowIgnore.set(win.id, ignore);
  }`;

const TARGETS = [
  {
    rel: path.join('runtime', 'electron-helper', 'main', 'ipc.js'),
    pairs: [
      [IPC_ANCHOR_INTERACTIVE, IPC_PATCHED_INTERACTIVE],
      [IPC_ANCHOR_REGIONS, IPC_PATCHED_REGIONS],
      [IPC_ANCHOR_FOCUS, IPC_PATCHED_FOCUS],
    ],
  },
  {
    rel: path.join('runtime', 'electron-helper', 'main', 'windows.js'),
    pairs: [[WIN_ANCHOR, WIN_PATCHED]],
  },
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
    console.log('用法: node tools/patch-pet-input-diag.mjs [--check|--restore] [--pkg <dsh-pet 目录>]');
    return;
  }
  const pkg = args.pkg ? path.resolve(args.pkg) : defaultPkg();
  if (!fs.existsSync(pkg)) {
    console.error(`找不到 ${pkg}`);
    process.exitCode = 1;
    return;
  }

  const plan = TARGETS.map((t) => {
    const file = path.join(pkg, t.rel);
    return { ...t, file };
  });

  const missing = plan.filter((p) => !fs.existsSync(p.file));
  if (missing.length > 0) {
    console.error('找不到这些文件，dsh-pet 可能升级改了结构：');
    for (const m of missing) console.error(`  ${m.file}`);
    process.exitCode = 1;
    return;
  }

  if (args.restore) {
    for (const p of plan) {
      const backup = p.file + BACKUP_SUFFIX;
      if (!fs.existsSync(backup)) {
        console.log(`（无备份，跳过）${p.file}`);
        continue;
      }
      fs.copyFileSync(backup, p.file);
      console.log(`已还原 ${p.file}`);
    }
    return;
  }

  for (const p of plan) {
    const src = fs.readFileSync(p.file, 'utf8');
    const patched = src.includes(MARKER);
    if (args.check) {
      console.log(`${patched ? 'patched  ' : 'clean    '} ${p.rel}`);
      continue;
    }
    if (patched) {
      console.log(`（已打过，跳过）${p.rel}`);
      continue;
    }

    // 统一按 LF 匹配，写回时保持原文件的换行风格
    const crlf = src.includes('\r\n');
    const norm = crlf ? src.replace(/\r\n/g, '\n') : src;

    let out = norm;
    const bad = [];
    for (const [from, to] of p.pairs) {
      const n = countOccur(out, from);
      if (n !== 1) bad.push(`锚点出现 ${n} 次（期望 1）`);
      else out = out.replace(from, to);
    }
    if (bad.length > 0) {
      console.error(`放弃改 ${p.rel}（dsh-pet 可能升级改了代码）：`);
      for (const b of bad) console.error(`  ${b}`);
      process.exitCode = 1;
      continue;
    }

    if (!fs.existsSync(p.file + BACKUP_SUFFIX)) fs.copyFileSync(p.file, p.file + BACKUP_SUFFIX);
    fs.writeFileSync(p.file, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
    console.log(`已打补丁 ${p.rel}`);
  }

  if (!args.check) console.log('记得 reload Helper：POST /dsh-pet-7340/reload');
}

main();
