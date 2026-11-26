/**
 * 修「待办面板输入框能点、能拿到光标，但打字进不去（字符跑到别的窗口的输入法里）」。
 *
 * 诊断（tools/patch-pet-input-diag.mjs 的日志）：
 *   [dsh-pet-input-diag] keyboard-focus requested focusedBefore=true
 *   —— 渲染端 focusin 触发请求时，主进程看到 win.isFocused() 已经是 true，于是直接 return；
 *      但窗口"看起来已聚焦"不等于 webContents 拿到键盘输入焦点：宠物窗是 showInactive
 *      显示的、又常被 DSH 抢过前台，这时打字会落到上一个窗口（连同它的输入法）。
 *   屏幕实测：输入框有蓝色焦点环、光标在闪，敲键盘却弹出别的应用的输入法候选条，
 *   输入框始终是空的。
 *
 * 改法：已聚焦时也补一次 webContents.focus()；win.focus() 只在没聚焦时调用（不抢别家焦点）。
 * 已聚焦时 webContents.focus() 是幂等空操作，没有副作用。
 *
 * dsh-pet 升级后需要重跑本补丁，然后 POST /dsh-pet-7340/reload。
 *
 * 用法：
 *   node tools/patch-pet-input-focus.mjs --check
 *   node tools/patch-pet-input-focus.mjs
 *   node tools/patch-pet-input-focus.mjs --restore
 *   node tools/patch-pet-input-focus.mjs --pkg <dsh-pet 目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MARKER = '/* dsh-pet-input-focus v1 */';
const BACKUP_SUFFIX = '.pre-inputfocus.orig';

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

const ANCHOR = `    if (!win || win.isDestroyed() || win.isFocused()) return;
    win.focus();
    win.webContents.focus();`;

const PATCHED = `    ${MARKER}
    // 窗口"看起来已聚焦"不代表 webContents 拿到键盘输入焦点：宠物窗 showInactive 显示、又常被
    // 其它窗口抢过前台，此时打字会落到上一个窗口（连同它的输入法）。已聚焦时也补一次
    // webContents.focus()（幂等空操作）；win.focus() 只在真没聚焦时用，避免抢别家焦点。
    if (!win || win.isDestroyed()) return;
    if (!win.isFocused()) win.focus();
    win.webContents.focus();`;

const REL = path.join('runtime', 'electron-helper', 'main', 'ipc.js');

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
    console.log('用法: node tools/patch-pet-input-focus.mjs [--check|--restore] [--pkg <dsh-pet 目录>]');
    return;
  }
  const pkg = args.pkg ? path.resolve(args.pkg) : defaultPkg();
  const file = path.join(pkg, REL);
  const backup = file + BACKUP_SUFFIX;

  if (!fs.existsSync(file)) {
    console.error(`找不到 ${file}`);
    process.exitCode = 1;
    return;
  }

  if (args.restore) {
    if (!fs.existsSync(backup)) {
      console.log('没有备份，无需还原。');
      return;
    }
    fs.copyFileSync(backup, file);
    console.log(`已还原 ${REL}`);
    return;
  }

  const src = fs.readFileSync(file, 'utf8');
  if (args.check) {
    console.log(`${src.includes(MARKER) ? 'patched  ' : 'clean    '} ${REL}`);
    return;
  }
  if (src.includes(MARKER)) {
    console.log('已经打过了，跳过。');
    return;
  }

  const crlf = src.includes('\r\n');
  let out = crlf ? src.replace(/\r\n/g, '\n') : src;
  const n = countOccur(out, ANCHOR);
  if (n !== 1) {
    console.error(`锚点出现 ${n} 次（期望 1），放弃（dsh-pet 可能升级改了代码）。`);
    process.exitCode = 1;
    return;
  }
  out = out.replace(ANCHOR, PATCHED);

  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
  console.log(`已打补丁 ${REL}`);
  console.log(`备份: ${backup}`);
  console.log('记得 reload Helper：POST /dsh-pet-7340/reload');
}

main();
