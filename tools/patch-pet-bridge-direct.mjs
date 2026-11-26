#!/usr/bin/env node
/**
 * 让桌面 Helper 的请求优先走「本机 HTTP 直连」，bridge（stdout 协议行 + 宿主回调）只做兜底。
 *
 * 为什么：bridge 的回包链是 helper 写 stdout → 宿主 child.ts 读行 → 宿主 fetch 回调端口。
 * 这条链在 DSH 宿主忙时会被拖到几十秒（日志实证：`bridge slow response GET /state ...
 * waited=28973ms`，而同一端点本机 HTTP 直连稳定 1ms 级），表现就是「DSH 一忙，右键菜单 /
 * 待办面板点了没反应」。
 *
 * 改法：协议回调在 Electron 主进程里跑，那里 fetch 本机 origin 不受 file:// 的 CORS 限制，
 * 所以普通接口先直连，连不上（ECONNREFUSED 之类）再退回 bridge。素材 / 头像 / 角色 / 语音
 * 这些要宿主解析文件路径并支持 Range 分片的端点仍走 bridge（保持原样）。
 *
 * 用法：
 *   node tools/patch-pet-bridge-direct.mjs            # 打补丁（幂等）
 *   node tools/patch-pet-bridge-direct.mjs --check    # 只看状态
 *   node tools/patch-pet-bridge-direct.mjs --restore  # 还原
 *   node tools/patch-pet-bridge-direct.mjs --pkg <dir>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '/* dsh-pet-bridge-direct v1 */';
const BACKUP_SUFFIX = '.pre-bridgedirect.orig';

const HELPER_BLOCK = `  ${MARKER}
  /** 需要宿主解析文件路径 / 支持 Range 分片的端点，只能走 bridge（直连拿不到 file 语义） */
  const DIRECT_SKIP = /^\\/dsh-pet-7340\\/(assets|avatar|character|voice)\\b/;

  /**
   * 本机 HTTP 直连宿主（Electron 主进程里 fetch，不受渲染端 CORS 限制）。
   * 连不上就返回 null，让调用方退回 bridge；只有「连不上」才回退，避免把已经生效的写操作做两遍。
   */
  async function directRequest(request, method, url, body) {
    if (!origin) return null;
    const headers = {};
    const contentType = request.headers.get('content-type');
    if (contentType) headers['content-type'] = contentType;
    const range = request.headers.get('range');
    if (range) headers['range'] = range;
    if (token) headers['X-DSH-Pet-Token'] = token;
    let resp;
    try {
      resp = await fetch(origin + url.pathname + url.search, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      return null;
    }
    const out = { 'content-type': resp.headers.get('content-type') || 'application/json; charset=utf-8' };
    for (const name of ['content-range', 'accept-ranges', 'content-length', 'cache-control']) {
      const value = resp.headers.get(name);
      if (value) out[name] = value;
    }
    out['access-control-allow-origin'] = '*';
    const buffer = Buffer.from(await resp.arrayBuffer());
    return new Response(new Uint8Array(buffer), { status: resp.status, headers: out });
  }

`;

const ANCHOR = `  async function handleBridgeRequest(request) {
    const url = new URL(request.url); // dsh-pet-bridge://dsh-pet/dsh-pet-7340/...
    const method = request.method || 'GET';
    let body;
    // PATCH 也带体（待办的部分更新）：漏读会让宿主收到空体，把一次正常修改当成坏 JSON。
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      body = await request.text();
    }
    const resp = await bridgeRequest(method, url.pathname + url.search, body);`;

const REPLACED = `  async function handleBridgeRequest(request) {
    const url = new URL(request.url); // dsh-pet-bridge://dsh-pet/dsh-pet-7340/...
    const method = request.method || 'GET';
    let body;
    // PATCH 也带体（待办的部分更新）：漏读会让宿主收到空体，把一次正常修改当成坏 JSON。
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      body = await request.text();
    }
    ${MARKER}
    if (!DIRECT_SKIP.test(url.pathname)) {
      const direct = await directRequest(request, method, url, body);
      if (direct) return direct;
    }
    const resp = await bridgeRequest(method, url.pathname + url.search, body);`;

function defaultPkg() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-pet');
}

function parseArgs(argv) {
  const out = { mode: 'patch', pkg: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check' || a === '--restore') out.mode = a.slice(2);
    else if (a === '--pkg') {
      i += 1;
      out.pkg = argv[i] ?? '';
    }
  }
  if (!out.pkg) out.pkg = defaultPkg();
  return out;
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeUtf8(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function main() {
  const { mode, pkg } = parseArgs(process.argv.slice(2));
  const target = path.join(pkg, 'runtime', 'electron-helper', 'main', 'bridge.js');
  const backup = target + BACKUP_SUFFIX;

  if (!fs.existsSync(target)) {
    console.error(`找不到 ${target}`);
    process.exit(1);
  }

  const text = readUtf8(target);
  const patched = text.includes(MARKER);

  if (mode === 'check') {
    console.log(`${patched ? '已打补丁(v1)' : '未打补丁'} ${target}`);
    if (fs.existsSync(backup)) console.log(`备份存在 ${backup}`);
    return;
  }

  if (mode === 'restore') {
    if (!fs.existsSync(backup)) {
      console.error(`没有备份，无法还原：${backup}`);
      process.exit(1);
    }
    fs.copyFileSync(backup, target);
    console.log(`已还原 ${target}`);
    return;
  }

  if (patched) {
    console.log(`已打过补丁，跳过：${target}`);
    return;
  }

  const anchorCount = text.split(ANCHOR).length - 1;
  if (anchorCount !== 1) {
    console.error(`锚点出现 ${anchorCount} 次（应为 1 次），放弃改动。dsh-pet 可能改版了，要人工看。`);
    process.exit(1);
  }

  if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);

  let next = text.replace(ANCHOR, REPLACED);
  // 直连辅助函数插在 handleBridgeRequest 的文档注释之前（锚点在这个注释处唯一）
  const comment = '  /** 处理一个渲染端请求：拼宿主请求行 → 等应答 → 组装 Response（素材读盘） */';
  const commentCount = next.split(comment).length - 1;
  if (commentCount !== 1) {
    console.error(`辅助函数锚点出现 ${commentCount} 次（应为 1 次），放弃改动。`);
    process.exit(1);
  }
  next = next.replace(comment, HELPER_BLOCK + comment);

  writeUtf8(target, next);
  console.log(`已打补丁 ${target}`);
  console.log(`备份 ${backup}`);
}

main();
