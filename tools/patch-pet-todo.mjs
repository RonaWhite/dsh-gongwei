#!/usr/bin/env node
/**
 * 增强 dsh-pet 原生「待办事项」面板：每条待办就地改名 + 改到期时间（本地定制补丁）。
 *
 * 为什么改编译产物：dsh-pet 没有暴露面板 UI 的扩展点，后端 PATCH /todos/:id 已经接受
 *   { text, dueAt, done } 三个字段（src/host/routes/todos.ts:40-57 的 readPatch），
 *   所以「改名 / 改到期」纯 UI 就能做到，不用动数据结构；而备注/分类这类字段会被
 *   parseTodoRecord 剥掉，存不进去，故不在本补丁范围内。
 *
 * 改的是两个已安装产物（都未 minify，字符串锚点稳定）：
 *   1. 网页端 lib/client.js                            （改完刷新浏览器页面）
 *   2. 桌面端 runtime/electron-helper/shared-core.js   （改完 POST /dsh-pet-7340/reload 重启 Helper）
 * 这两个文件都在 npm 包 dsh-pet 里，**升级/重装 dsh-pet 会被覆盖**，届时重跑本脚本即可。
 *
 * 与 patch-pet-menu.mjs 的关系：两个补丁各用不同备份名（*.pre-todo.orig vs *.orig）
 *   和不同 marker，互不干扰；--restore 只还原本补丁，不会动菜单补丁。
 *
 * 用法：
 *   node patch-pet-todo.mjs            打补丁（幂等，已打过就跳过）
 *   node patch-pet-todo.mjs --check    只检查当前状态与锚点，不改文件
 *   node patch-pet-todo.mjs --restore  用 *.pre-todo.orig 还原成打补丁前的状态
 *   node patch-pet-todo.mjs --pkg <dir> 指定 dsh-pet 包目录（默认自动探测）
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const MARKER = '/* dsh-todo-edit v1 */';
const BACKUP_SUFFIX = '.pre-todo.orig';

const REL_DESKTOP = path.join('runtime', 'electron-helper', 'shared-core.js');
const REL_WEB = path.join('lib', 'client.js');

// ---------------------------------------------------------------- 找包目录

function candidates() {
  const list = [];
  if (process.env.DSH_PROFILE_DIR) {
    list.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'dsh-pet'));
  }
  const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
  list.push(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-pet'));
  return list;
}

function findPkgDir(explicit) {
  const tried = explicit ? [explicit] : candidates();
  for (const dir of tried) {
    if (existsSync(path.join(dir, REL_WEB)) && existsSync(path.join(dir, REL_DESKTOP))) return dir;
  }
  console.error('找不到 dsh-pet 包目录，试过：');
  for (const dir of tried) console.error('  ' + dir);
  console.error('用 --pkg <dir> 指定。');
  process.exit(1);
}

// ---------------------------------------------------------------- 补丁文本

const T = '\t';
const L = (n, s) => T.repeat(n) + s;
const block = (...lines) => lines.join('\n');

// A. handlers 增加 onEdit（改名）与 onEditDue（改到期），并插入 marker。
const A_OLD = block(
  L(1, 'const handlers = {'),
  L(2, 'onToggle: (todo, done) => void mutate(() => patchTodo(todo.id, { done }, baseUrl)),'),
  L(2, 'onDelete: (todo) => void mutate(() => removeTodo(todo.id, baseUrl))'),
  L(1, '};'),
);
const A_NEW = block(
  L(1, 'const handlers = {'),
  L(2, MARKER),
  L(2, 'onToggle: (todo, done) => void mutate(() => patchTodo(todo.id, { done }, baseUrl)),'),
  L(2, 'onDelete: (todo) => void mutate(() => removeTodo(todo.id, baseUrl)),'),
  L(2, 'onEdit: (todo, text) => void mutate(() => patchTodo(todo.id, { text }, baseUrl)),'),
  L(2, 'onEditDue: (todo, dueAt) => void mutate(() => patchTodo(todo.id, { dueAt }, baseUrl))'),
  L(1, '};'),
);

// B. renderItem 里在删除按钮前插入 ✎（改名）与 ⏰（改到期）两个按钮和行内编辑器。
//    删除块本身逐字保留，只把最后的 item.append 多带两个按钮。
const DELETE_BLOCK = block(
  L(1, 'const remove = element("button", "dsh-pet-todo-del", "✕");'),
  L(1, 'remove.type = "button";'),
  L(1, 'remove.setAttribute("aria-label", "删除：" + todo.text);'),
  L(1, 'remove.addEventListener("click", () => {'),
  L(2, 'if (remove.dataset.armed !== "1") {'),
  L(3, 'remove.dataset.armed = "1";'),
  L(3, 'remove.classList.add("is-armed");'),
  L(3, 'remove.textContent = "确认";'),
  L(3, 'window.setTimeout(() => {'),
  L(4, 'if (!remove.isConnected) return;'),
  L(4, 'delete remove.dataset.armed;'),
  L(4, 'remove.classList.remove("is-armed");'),
  L(4, 'remove.textContent = "✕";'),
  L(3, '}, DELETE_ARM_MS);'),
  L(3, 'return;'),
  L(2, '}'),
  L(2, 'handlers.onDelete(todo);'),
  L(1, '});'),
);
const B_OLD = DELETE_BLOCK + '\n' + L(1, 'item.append(check, main, remove);');

const EDIT_BLOCK = block(
  L(1, 'const edit = element("button", "dsh-pet-todo-edit", "✎");'),
  L(1, 'edit.type = "button";'),
  L(1, 'edit.setAttribute("aria-label", "改名：" + todo.text);'),
  L(1, 'edit.addEventListener("click", () => {'),
  L(2, 'if (main.querySelector(".dsh-pet-todo-editInput")) return;'),
  L(2, 'const editor = document.createElement("input");'),
  L(2, 'editor.type = "text";'),
  L(2, 'editor.className = "dsh-pet-todo-editInput";'),
  L(2, 'editor.maxLength = 200;'),
  L(2, 'editor.value = todo.text;'),
  L(2, 'text.hidden = true;'),
  L(2, 'meta.hidden = true;'),
  L(2, 'main.insertBefore(editor, text);'),
  L(2, 'editor.focus();'),
  L(2, 'editor.select();'),
  L(2, 'let done = false;'),
  L(2, 'const finish = (save) => {'),
  L(3, 'if (done) return;'),
  L(3, 'done = true;'),
  L(3, 'const next = editor.value.trim();'),
  L(3, 'editor.remove();'),
  L(3, 'text.hidden = false;'),
  L(3, 'meta.hidden = false;'),
  L(3, 'if (save && next !== "" && next !== todo.text) handlers.onEdit(todo, next);'),
  L(2, '};'),
  L(2, 'editor.addEventListener("keydown", (e) => {'),
  L(3, 'if (e.key === "Enter") { e.preventDefault(); finish(true); }'),
  L(3, 'else if (e.key === "Escape") { e.preventDefault(); finish(false); }'),
  L(2, '});'),
  L(2, 'editor.addEventListener("blur", () => finish(true));'),
  L(1, '});'),
);

const DUE_BLOCK = block(
  L(1, 'const due = element("button", "dsh-pet-todo-due-edit", "⏰");'),
  L(1, 'due.type = "button";'),
  L(1, 'due.setAttribute("aria-label", "改到期时间：" + todo.text);'),
  L(1, 'due.addEventListener("click", () => {'),
  L(2, 'if (main.querySelector(".dsh-pet-todo-dueInput")) return;'),
  L(2, 'const editor = document.createElement("input");'),
  L(2, 'editor.type = "datetime-local";'),
  L(2, 'editor.className = "dsh-pet-todo-dueInput";'),
  L(2, 'editor.value = todo.dueAt === null ? "" : formatDateTimeLocal(todo.dueAt);'),
  L(2, 'meta.hidden = true;'),
  L(2, 'main.appendChild(editor);'),
  L(2, 'editor.focus();'),
  L(2, 'let done = false;'),
  L(2, 'const finish = (save) => {'),
  L(3, 'if (done) return;'),
  L(3, 'done = true;'),
  L(3, 'const value = editor.value;'),
  L(3, 'editor.remove();'),
  L(3, 'meta.hidden = false;'),
  L(3, 'if (!save) return;'),
  L(3, 'const next = value === "" ? null : parseDateTimeLocal(value);'),
  L(3, 'if (value !== "" && next === null) return;'),
  L(3, 'if (next === todo.dueAt) return;'),
  L(3, 'handlers.onEditDue(todo, next);'),
  L(2, '};'),
  L(2, 'editor.addEventListener("keydown", (e) => {'),
  L(3, 'if (e.key === "Enter") { e.preventDefault(); finish(true); }'),
  L(3, 'else if (e.key === "Escape") { e.preventDefault(); finish(false); }'),
  L(2, '});'),
  L(2, 'editor.addEventListener("blur", () => finish(true));'),
  L(1, '});'),
);
const B_NEW = EDIT_BLOCK + '\n' + DUE_BLOCK + '\n' + DELETE_BLOCK + '\n' + L(1, 'item.append(check, main, edit, due, remove);');

// C. 新按钮与行内输入框的样式，插在 .dsh-pet-todo-text 规则之后。
const C_OLD = L(1, '".dsh-pet-todo-text{overflow-wrap:anywhere;white-space:pre-wrap}",');
const C_NEW = block(
  C_OLD,
  L(1, '".dsh-pet-todo-edit,.dsh-pet-todo-due-edit{border:none;background:transparent;color:rgba(43,43,43,.34);font-size:.923em;line-height:1;padding:calc(var(--t)*0.308) calc(var(--t)*0.28);border-radius:.462em;cursor:pointer;flex:0 0 auto;min-width:calc(var(--t)*1.1)}",'),
  L(1, '".dsh-pet-todo-edit:hover,.dsh-pet-todo-due-edit:hover{background:rgba(0,0,0,.07);color:rgba(43,43,43,.8)}",'),
  L(1, '".dsh-pet-todo-editInput,.dsh-pet-todo-dueInput{width:100%;font:inherit;color:inherit;background:#fff;border:1px solid rgba(43,43,43,.25);border-radius:.3em;padding:calc(var(--t)*0.2) calc(var(--t)*0.3);margin-bottom:calc(var(--t)*0.154)}",'),
);

const PATCHES = [
  { name: 'A/handlers', old: A_OLD, new: A_NEW },
  { name: 'B/renderItem', old: B_OLD, new: B_NEW },
  { name: 'C/styles', old: C_OLD, new: C_NEW },
];

// ---------------------------------------------------------------- 通用

function occurrences(src, needle) {
  let n = 0;
  let i = src.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = src.indexOf(needle, i + needle.length);
  }
  return n;
}

function statusOf(file) {
  if (!existsSync(file)) return 'missing';
  return readFileSync(file, 'utf8').includes(MARKER) ? 'patched' : 'pristine';
}

function checkAnchors(file, label) {
  const src = readFileSync(file, 'utf8');
  let ok = true;
  for (const { name, old } of PATCHES) {
    const count = occurrences(src, old);
    if (count !== 1) {
      console.error(`  ${label} ${name}: 锚点出现 ${count} 次（应为 1），dsh-pet 版本可能变了`);
      ok = false;
    } else {
      console.log(`  ${label} ${name}: 锚点 OK`);
    }
  }
  return ok;
}

function patchOne(file, label) {
  const src = readFileSync(file, 'utf8');
  if (src.includes(MARKER)) {
    console.log(`  ${label}: 已打过，跳过`);
    return true;
  }
  // 三处锚点都唯一才写，避免打一半。
  if (!checkAnchors(file, label)) return false;
  let out = src;
  for (const { name, old, new: replacement } of PATCHES) {
    out = out.replace(old, replacement);
    console.log(`  ${label} ${name}: 已替换`);
  }
  const backup = file + BACKUP_SUFFIX;
  if (!existsSync(backup)) {
    copyFileSync(file, backup);
    console.log(`  ${label}: 备份 -> ${path.basename(backup)}`);
  }
  writeFileSync(file, out, 'utf8');
  return true;
}

function restoreOne(file, label) {
  const backup = file + BACKUP_SUFFIX;
  if (!existsSync(backup)) {
    console.log(`  ${label}: 没有 ${path.basename(backup)}，无法还原`);
    return;
  }
  copyFileSync(backup, file);
  console.log(`  ${label}: 已还原成打补丁前状态`);
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const mode = argv.includes('--check') ? 'check' : argv.includes('--restore') ? 'restore' : 'patch';
const pkgFlag = argv.indexOf('--pkg');
const pkgDir = findPkgDir(pkgFlag >= 0 ? argv[pkgFlag + 1] : undefined);

const desktopFile = path.join(pkgDir, REL_DESKTOP);
const webFile = path.join(pkgDir, REL_WEB);

console.log(`dsh-pet 包目录：${pkgDir}`);
console.log(`模式：${mode}`);

let ok = true;
if (mode === 'check') {
  console.log(`  桌面端 ${REL_DESKTOP}: ${statusOf(desktopFile)}`);
  console.log(`  网页端 ${REL_WEB}: ${statusOf(webFile)}`);
  if (statusOf(desktopFile) === 'pristine') ok = checkAnchors(desktopFile, '桌面端') && ok;
  if (statusOf(webFile) === 'pristine') ok = checkAnchors(webFile, '网页端') && ok;
} else if (mode === 'restore') {
  restoreOne(desktopFile, '桌面端');
  restoreOne(webFile, '网页端');
} else {
  ok = patchOne(desktopFile, '桌面端') && ok;
  ok = patchOne(webFile, '网页端') && ok;
  if (ok) {
    console.log('');
    console.log('新增能力：每条待办右侧 ✎ = 改名（回车/失焦保存，Esc 取消），⏰ = 改到期时间（datetime-local，回车/失焦保存，Esc 取消，清空 = 无期限）');
    console.log('生效方式：');
    console.log('  网页端：刷新浏览器页面');
    console.log('  桌面端：POST /dsh-pet-7340/reload（或右键菜单 → 更多 → 重载配置），重启桌面 Helper');
  }
}

process.exit(ok ? 0 : 1);
