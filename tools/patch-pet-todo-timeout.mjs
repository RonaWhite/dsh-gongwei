#!/usr/bin/env node
/**
 * dsh-pet 待办面板超时补丁（dsh-todo-timeout v1）
 *
 * 为什么需要：待办面板的请求层 `send()` 用裸 fetch，既没有 AbortController 也没有超时；
 * 面板本身的 `mutate()` 又用一个 `busy` 闸门串行化所有修改（busy 期间增删改一律静默 return）。
 * 桌面端桌宠走 bridge 通道（渲染进程 → stdout 协议行 → 宿主 → 本地回调端口），
 * 宿主忙的时候一条请求可能迟迟不回；此时面板会永久停在 busy：
 * 按钮能点、输入框能打字，但回车/添加没反应 —— 看起来就是「待办填不进去，得等对话跑完」。
 *
 * 本补丁只做一件事：给两份 `send()` 的 fetch 挂 `AbortSignal.timeout(20s)`，并把超时归一成
 * 一句人话的失败，让面板回到可重试状态。不改协议、不改面板逻辑、不碰其它请求。
 *
 * 两个目标（各自独立打，任一已是最新就跳过）：
 *   - runtime/electron-helper/shared-core.js  桌面 Helper 用的那份
 *   - lib/client.js                           网页 overlay 用的那份
 *
 * 用法：
 *   node tools/patch-pet-todo-timeout.mjs            # 打补丁
 *   node tools/patch-pet-todo-timeout.mjs --check     # 只看状态
 *   node tools/patch-pet-todo-timeout.mjs --restore   # 还原
 *   node tools/patch-pet-todo-timeout.mjs --pkg <dsh-pet 目录>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '/* dsh-todo-timeout v1 */';
const BACKUP_SUFFIX = '.pre-todottl.orig';
const TIMEOUT_MS = 20000;

const PKG_DEFAULT = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'profiles',
  'desktop',
  'node_modules',
  'dsh-pet',
);

const TARGETS = [path.join('runtime', 'electron-helper', 'shared-core.js'), path.join('lib', 'client.js')];

// 锚点一：send() 里的 fetch 调用（两个 tab 缩进，属性三个 tab）。必须恰好出现一次。
const ANCHOR = '\t\tconst response = await fetch(url, {\n';
const ANCHOR_REPLACEMENT =
  '\t\t/* dsh-todo-timeout v1 */\n' +
  `\t\tconst response = await fetch(url, {\n` +
  `\t\t\tsignal: AbortSignal.timeout(${TIMEOUT_MS}),\n`;

// 锚点二：send() 的 catch 分支——把超时归一成可读失败。
const CATCH_ANCHOR = '\t} catch (error) {\n\t\treturn {\n\t\t\tfailed: true,\n\t\t\tmessage: ';
const CATCH_REPLACEMENT =
  '\t} catch (error) {\n' +
  '\t\t/* dsh-todo-timeout v1 */\n' +
  '\t\tconst timedOut =\n' +
  "\t\t\terror instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');\n" +
  '\t\treturn {\n' +
  '\t\t\tfailed: true,\n' +
  `\t\t\tmessage: timedOut\n` +
  `\t\t\t\t? '桌宠服务这次没回话，过一会儿再试一次（${TIMEOUT_MS / 1000}s 超时）'\n` +
  '\t\t\t\t: ';

function parseArgs(argv) {
  const opts = { check: false, restore: false, pkg: PKG_DEFAULT };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--restore') opts.restore = true;
    else if (a === '--pkg') opts.pkg = path.resolve(argv[++i] ?? '');
  }
  return opts;
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) return n;
    n += 1;
    i = at + needle.length;
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const results = [];
  for (const rel of TARGETS) {
    const file = path.join(opts.pkg, rel);
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(file)) {
      results.push({ rel, status: 'missing' });
      continue;
    }
    if (opts.restore) {
      if (!fs.existsSync(backup)) {
        results.push({ rel, status: 'no-backup' });
        continue;
      }
      fs.copyFileSync(backup, file);
      fs.rmSync(backup, { force: true });
      results.push({ rel, status: 'restored' });
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    if (opts.check) {
      results.push({ rel, status: src.includes(MARKER) ? 'patched' : 'clean' });
      continue;
    }
    if (src.includes(MARKER)) {
      results.push({ rel, status: 'already' });
      continue;
    }
    const nFetch = countOccurrences(src, ANCHOR);
    const nCatch = countOccurrences(src, CATCH_ANCHOR);
    if (nFetch !== 1) {
      results.push({ rel, status: 'anchor-miss', which: `fetch x${nFetch}` });
      continue;
    }
    if (nCatch !== 1) {
      results.push({ rel, status: 'anchor-miss', which: `catch x${nCatch}` });
      continue;
    }
    let out = src.replace(ANCHOR, ANCHOR_REPLACEMENT);
    out = out.replace(CATCH_ANCHOR, CATCH_REPLACEMENT);
    if (!out.includes(MARKER)) {
      results.push({ rel, status: 'anchor-miss', which: 'marker' });
      continue;
    }
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, out, 'utf8');
    results.push({ rel, status: 'patched' });
  }
  for (const r of results) {
    const extra = r.which ? ` (${r.which})` : '';
    console.log(`${r.status.padEnd(12)} ${r.rel}${extra}`);
  }
  const bad = results.filter((r) => !['patched', 'already', 'restored', 'clean'].includes(r.status));
  if (bad.length > 0) process.exitCode = 1;
}

main();
