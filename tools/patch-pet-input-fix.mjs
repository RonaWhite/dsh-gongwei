/**
 * 修「DSH 跑对话时，右键桌宠 → 待办事项 → 打字/提交点不动」。
 *
 * 屏幕级复现 + 诊断日志（tools/patch-pet-input-diag.mjs）得出的链路：
 *   1. 渲染端把菜单/面板的矩形异步上报给主进程（syncInputRegions → IPC）；
 *      面板刚弹出的一两百毫秒里矩形还没到，主进程按「光标没命中控件矩形」把整窗翻成穿透，
 *      于是紧接着的那次点击落到下层窗口（DSH / Edge）——用户看到的就是「点了没反应」。
 *   2. DSH 窗口抢回前台时宠物窗口收到 blur，渲染端调用 setInteractive(false)，
 *      主进程无条件照办（ignoring = !interactive），绕过了 busy 判定 → 菜单还在屏幕上却点不动。
 *   3. blur 处理器还会直接 closeMenu()，光标正压在菜单上时菜单会自己消失。
 *
 * 三处改动（都是「按光标是否还在窗口里」判，不引入新的状态）：
 *   A. pointer-target.js：busy 期间只按「光标在不在窗口内」决定穿透，
 *      不再依赖异步上报的控件矩形；拖拽租约（input.dragging）照旧强制可交互。
 *   B. ipc.js：busy 时 setInteractive(false) 不再直接翻穿透，仍走同一条 busy 判定。
 *   C. sprite/init.js：blur 时若光标还在窗口里（1.5s 内有过 mousemove）就不收菜单。
 *
 * dsh-pet 升级后需要重跑本补丁，然后 POST /dsh-pet-7340/reload。
 *
 * 用法：
 *   node tools/patch-pet-input-fix.mjs --check
 *   node tools/patch-pet-input-fix.mjs
 *   node tools/patch-pet-input-fix.mjs --restore
 *   node tools/patch-pet-input-fix.mjs --pkg <dsh-pet 目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MARKER = '/* dsh-pet-input-fix v1 */';
const BACKUP_SUFFIX = '.pre-inputfix.orig';

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

/* ---------- A. pointer-target.js ---------- */

const ZONE_ANCHOR = `  if (busy) {
    if (!input || input.dragging) return false; // 兼容旧渲染端；拖拽租约绝不被位置判定打断
    const inControl = input.rects.some(
      (r) =>
        point.x >= bounds.x + r.x &&
        point.x < bounds.x + r.x + r.width &&
        point.y >= bounds.y + r.y &&
        point.y < bounds.y + r.y + r.height,
    );
    return !inControl && pointerZone(bounds, point, margins) !== 'body';
  }`;

const ZONE_PATCHED = `  if (busy) {
    if (!input || input.dragging) return false; // 兼容旧渲染端；拖拽租约绝不被位置判定打断
    ${MARKER}
    // 菜单/对话/待办面板打开期间，只按「光标还在不在窗口里」判：在窗内就保持可交互。
    // 原来要求命中渲染端上报的控件矩形，而上报是异步的（渲染端 → IPC → 这里），
    // 面板刚弹出那一两百毫秒里矩形还没到，判定会把整窗翻成穿透，用户随后的点击全落到下层窗口。
    return pointerZone(bounds, point, margins) === 'outside';
  }`;

/* ---------- B. ipc.js ---------- */

const IPC_ANCHOR = `    const ignoring =
      interactive && input && petWindows.state.inputBusy.get(win.id)
        ? decideWindowIgnore(
            win.getContentBounds(),
            screen.getCursorScreenPoint(),
            false,
            true,
            0,
            input,
            petWindows.state.winMargins.get(win.id),
          )
        : !interactive;`;

const IPC_PATCHED = `    ${MARKER}
    // busy（菜单/对话/待办面板开着）时不让渲染端的 setInteractive(false) 直接翻成穿透：
    // DSH 窗口抢回前台会触发宠物窗口 blur，渲染端随即 setInteractive(false)，
    // 那一刻光标常常正压在菜单/面板上，翻穿透就点不动了。
    const busyNow = petWindows.state.inputBusy.get(win.id) === true;
    const ignoring =
      busyNow && input
        ? decideWindowIgnore(
            win.getContentBounds(),
            screen.getCursorScreenPoint(),
            false,
            true,
            0,
            input,
            petWindows.state.winMargins.get(win.id),
          )
        : !interactive;`;

/* ---------- C. sprite/init.js ---------- */

const MOVE_ANCHOR = `    window.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal: ac.signal });`;

const MOVE_PATCHED = `    window.addEventListener(
      'mousemove',
      (e) => {
        this._lastPointerAt = Date.now();
        this.onMouseMove(e);
      },
      { signal: ac.signal },
    );`;

const BLUR_ANCHOR = `        // 切到其它应用后旧菜单不该继续占着透明窗口；丢失松手时也释放拖拽。
        this.closeMenu();`;

const BLUR_PATCHED = `        // 切到其它应用后旧菜单不该继续占着透明窗口；丢失松手时也释放拖拽。
        ${MARKER}
        // 但光标还在窗口里时不要收：DSH 窗口抢回前台也会触发 blur，那时用户正要点菜单。
        if (Date.now() - (this._lastPointerAt || 0) > 1500) this.closeMenu();`;

const TARGETS = [
  {
    rel: path.join('runtime', 'electron-helper', 'pointer-target.js'),
    pairs: [[ZONE_ANCHOR, ZONE_PATCHED]],
  },
  {
    rel: path.join('runtime', 'electron-helper', 'main', 'ipc.js'),
    pairs: [[IPC_ANCHOR, IPC_PATCHED]],
  },
  {
    rel: path.join('runtime', 'electron-helper', 'sprite', 'init.js'),
    pairs: [
      [MOVE_ANCHOR, MOVE_PATCHED],
      [BLUR_ANCHOR, BLUR_PATCHED],
    ],
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
    console.log('用法: node tools/patch-pet-input-fix.mjs [--check|--restore] [--pkg <dsh-pet 目录>]');
    return;
  }
  const pkg = args.pkg ? path.resolve(args.pkg) : defaultPkg();
  if (!fs.existsSync(pkg)) {
    console.error(`找不到 ${pkg}`);
    process.exitCode = 1;
    return;
  }

  const plan = TARGETS.map((t) => ({ ...t, file: path.join(pkg, t.rel) }));
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
        console.log(`（无备份，跳过）${p.rel}`);
        continue;
      }
      fs.copyFileSync(backup, p.file);
      console.log(`已还原 ${p.rel}`);
    }
    return;
  }

  let failed = false;
  for (const p of plan) {
    let src = fs.readFileSync(p.file, 'utf8');
    if (args.check) {
      console.log(`${src.includes(MARKER) ? 'patched  ' : 'clean    '} ${p.rel}`);
      continue;
    }
    if (src.includes(MARKER)) {
      console.log(`（已打过，跳过）${p.rel}`);
      continue;
    }

    const crlf = src.includes('\r\n');
    let out = crlf ? src.replace(/\r\n/g, '\n') : src;
    const bad = [];
    for (const [from, to] of p.pairs) {
      const n = countOccur(out, from);
      if (n !== 1) bad.push(`锚点出现 ${n} 次（期望 1）：${from.split('\n')[0].trim()}`);
      else out = out.replace(from, to);
    }
    if (bad.length > 0) {
      console.error(`放弃改 ${p.rel}（dsh-pet 可能升级改了代码）：`);
      for (const b of bad) console.error(`  ${b}`);
      failed = true;
      continue;
    }

    if (!fs.existsSync(p.file + BACKUP_SUFFIX)) fs.copyFileSync(p.file, p.file + BACKUP_SUFFIX);
    fs.writeFileSync(p.file, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
    console.log(`已打补丁 ${p.rel}`);
  }

  if (!args.check) {
    console.log('记得 reload Helper：POST /dsh-pet-7340/reload');
    if (failed) process.exitCode = 1;
  }
}

main();
