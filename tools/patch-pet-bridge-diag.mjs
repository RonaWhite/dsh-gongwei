/**
 * 给 dsh-pet 的桌面 Helper bridge 加"慢/超时诊断"。
 *
 * 背景：桌宠在 DSH 跑对话时，右键填待办会卡住，日志里只留一句
 *   [dsh-pet-desktop-helper] bridge handler error: bridge request timeout
 * 这句话是 Electron 主进程打出来的，只知道"45s 了没回包"，不知道是哪个请求。
 * 加日志就能定位：超时的是 method + url、当时还有几个请求在飞；
 * "回了但很慢（>3s）"的请求也记一笔，能看出宿主卡顿的节奏与涉及的端点。
 *
 * v2：pending 表里一并记下 method/url，慢响应日志也能打出请求是什么
 *     （v1 只打了 id，看不出端点）。
 *
 * 这个补丁只加日志，不改任何行为。dsh-pet 升级后需要重跑，然后
 *   curl -X POST http://127.0.0.1:<port>/dsh-pet-7340/reload
 * 让 Helper 重新加载。
 *
 * 用法：
 *   node tools/patch-pet-bridge-diag.mjs --check     # 只看状态
 *   node tools/patch-pet-bridge-diag.mjs            # 打补丁
 *   node tools/patch-pet-bridge-diag.mjs --restore  # 还原
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MARKER = '/* dsh-pet-bridge-diag v2 */';
const OLD_MARKERS = ['/* dsh-pet-bridge-diag v1 */'];
const BACKUP_SUFFIX = '.pre-bridgediag.orig';

/** 慢到多少毫秒就记一笔 */
const SLOW_MS = 3000;

const here = path.dirname(fileURLToPath(import.meta.url));

/** 默认的 dsh-pet 安装位置（desktop profile 里的 node_modules） */
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

const ANCHOR_TIMEOUT = `      const id = ++bridgeSeq;
      bridgePending.set(id, { resolve, reject });
      process.stdout.write(prefix + JSON.stringify({ id, method, url, body, cb: bridgeCallbackUrl }) + '\\n');
      // 宿主若长期不应答（进程退出/宿主动作挂起）不无限挂起：45s 兜底（LLM 生成最长 30-60s）
      setTimeout(() => {
        const p = bridgePending.get(id);
        if (!p) return;
        bridgePending.delete(id);
        p.reject(new Error('bridge request timeout'));
      }, 45000).unref?.();`;

const PATCHED_TIMEOUT = `      const id = ++bridgeSeq;
      const startedAt = Date.now();
      bridgePending.set(id, { resolve, reject, at: startedAt, method, url });
      process.stdout.write(prefix + JSON.stringify({ id, method, url, body, cb: bridgeCallbackUrl }) + '\\n');
      // 宿主若长期不应答（进程退出/宿主动作挂起）不无限挂起：45s 兜底（LLM 生成最长 30-60s）
      setTimeout(() => {
        const p = bridgePending.get(id);
        if (!p) return;
        bridgePending.delete(id);
        ${MARKER}
        console.error(
          '[dsh-pet-desktop-helper] bridge request timeout: ' +
            method + ' ' + url + ' waited=' + (Date.now() - startedAt) + 'ms pending=' + bridgePending.size,
        );
        p.reject(new Error('bridge request timeout'));
      }, 45000).unref?.();`;

const ANCHOR_RESOLVE = `  function bridgeResolve(resp) {
    const p = resp && bridgePending.get(resp.id);
    if (!p) return;
    bridgePending.delete(resp.id);
    p.resolve(resp);
  }`;

const PATCHED_RESOLVE = `  function bridgeResolve(resp) {
    const p = resp && bridgePending.get(resp.id);
    if (!p) return;
    bridgePending.delete(resp.id);
    ${MARKER}
    if (typeof p.at === 'number') {
      const waited = Date.now() - p.at;
      if (waited > ${SLOW_MS}) {
        console.error(
          '[dsh-pet-desktop-helper] bridge slow response ' +
            p.method + ' ' + p.url + ' id=' + resp.id + ' waited=' + waited + 'ms pending=' + bridgePending.size,
        );
      }
    }
    p.resolve(resp);
  }`;

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
    console.log('用法: node tools/patch-pet-bridge-diag.mjs [--check|--restore] [--pkg <dsh-pet 目录>]');
    return;
  }
  const pkg = args.pkg ? path.resolve(args.pkg) : defaultPkg();
  const target = path.join(pkg, 'runtime', 'electron-helper', 'main', 'bridge.js');
  const backup = target + BACKUP_SUFFIX;

  if (!fs.existsSync(target)) {
    console.error(`找不到 ${target}`);
    console.error('dsh-pet 没装在这里就加 --pkg <dsh-pet 目录>');
    process.exitCode = 1;
    return;
  }

  if (args.restore) {
    if (!fs.existsSync(backup)) {
      console.log('没有备份，无需还原。');
      return;
    }
    fs.copyFileSync(backup, target);
    console.log(`已还原 ${target}`);
    return;
  }

  let src = fs.readFileSync(target, 'utf8');
  const patched = src.includes(MARKER);

  if (args.check) {
    console.log(`目标: ${target}`);
    console.log(`状态: ${patched ? '已打补丁(v2)' : '未打补丁'}`);
    console.log(`备份: ${fs.existsSync(backup) ? backup : '（无）'}`);
    return;
  }

  if (patched) {
    console.log('已经打过 v2 补丁了，跳过。');
    return;
  }

  // 老版本补丁先还原，回到原始文件再打新版
  if (OLD_MARKERS.some((m) => src.includes(m))) {
    if (!fs.existsSync(backup)) {
      console.error('检测到旧补丁但没有备份文件，无法安全升级。请先手动还原 bridge.js。');
      process.exitCode = 1;
      return;
    }
    fs.copyFileSync(backup, target);
    src = fs.readFileSync(target, 'utf8');
    console.log('已先还原旧补丁，准备打 v2。');
  }

  const n1 = countOccur(src, ANCHOR_TIMEOUT);
  const n2 = countOccur(src, ANCHOR_RESOLVE);
  if (n1 !== 1 || n2 !== 1) {
    console.error('锚点不唯一或不存在，放弃（dsh-pet 可能升级改了代码）：');
    console.error(`  bridgeRequest 锚点出现 ${n1} 次（期望 1）`);
    console.error(`  bridgeResolve 锚点出现 ${n2} 次（期望 1）`);
    process.exitCode = 1;
    return;
  }

  const out = src.replace(ANCHOR_TIMEOUT, PATCHED_TIMEOUT).replace(ANCHOR_RESOLVE, PATCHED_RESOLVE);
  if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
  fs.writeFileSync(target, out, 'utf8');
  console.log(`已打补丁: ${target}`);
  console.log(`备份: ${backup}`);
  console.log('记得让 Helper 重新加载，否则跑的还是旧代码。');
}

main();
