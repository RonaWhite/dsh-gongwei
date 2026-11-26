#!/usr/bin/env node
/**
 * 重排 dsh-pet 右键菜单（本地定制补丁）。
 *
 * 为什么需要这个脚本：dsh-pet 没有向第三方插件暴露「菜单位置」的 API——菜单树完全由客户端
 * 硬编码拼出来，第三方注册的项只能落在 buildMoreBranch() 产生的「更多」里。想让 dsh-gongwei
 * 的几项出现在第一层（待办事项下面），只能改已安装产物：
 *   1. 桌面端 runtime/electron-helper/sprite/menu.js   （改完要重启桌面 Helper）
 *   2. 网页端 lib/client.js                            （改完要刷新浏览器页面）
 *
 * 这两个文件都在 npm 包 dsh-pet 里，**升级/重装 dsh-pet 会被覆盖**，届时重跑本脚本即可。
 *
 * 目标顺序：
 *   打开软件(仅桌面) / 待办事项 / 【dsh-gongwei 的第三方项】 / 对话 / 碎碎念 / 睡觉
 *   → 更多（查看余额、查询天气、配图、动作、显示位置、重载配置(仅桌面)、回到初始位置、其余第三方项）
 *
 * 用法：
 *   node patch-pet-menu.mjs            打补丁（幂等，已打过就跳过）
 *   node patch-pet-menu.mjs --check    只检查当前状态，不改文件
 *   node patch-pet-menu.mjs --restore  用 *.orig 备份还原成上游原样
 *   node patch-pet-menu.mjs --pkg <dir> 指定 dsh-pet 包目录（默认自动探测）
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const PINNED_OWNER = 'dsh-gongwei';
const MARK_DESKTOP = `const PINNED_OWNER = '${PINNED_OWNER}';`;
const MARK_WEB = `const PINNED_OWNER = "${PINNED_OWNER}";`;

const REL_DESKTOP = path.join('runtime', 'electron-helper', 'sprite', 'menu.js');
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

// ---------------------------------------------------------------- 桌面端

const DESKTOP_START = "    // 顺序：打开软件 / 余额 / 待办 / 碎碎念 / 对话 / 配图 / 睡觉 → 动作树 → 显示位置 / 重载配置 / 回到初始位置。\n";
// 结束锚点取「树拼完之后的那一行」：中间那段（含上游自己的 const tree = ...）整体被替换掉。
const DESKTOP_END = '    if (!tree.length) return;\n';

const DESKTOP_NEW = `    // 本地定制过的顺序（与上游 dsh-pet 不同；升级/重装 dsh-pet 后重跑
    // plugins/dsh-gongwei/tools/patch-pet-menu.mjs 才能恢复）：
    //   打开软件 / 待办事项 / 【${PINNED_OWNER} 的第三方项】 / 对话 / 碎碎念 / 睡觉
    //   → 更多（查看余额、查询天气、配图、动作、显示位置、重载配置、回到初始位置、其余第三方项）
    // 理由：日常最常点的几项留在第一层，偶发用的查询类与维护类收进「更多」，避免第一层过长。
    // 「对话」是内置项，用户要求挪回第一层、排在碎碎念前面。
    // 固定第三方项：这个 owner 的菜单项出现在待办事项下面，不进「更多」。
    ${MARK_DESKTOP}
    const pinnedItems = this.menuItems.filter((it) => it && it.owner === PINNED_OWNER);
    const otherItems = this.menuItems.filter((it) => !it || it.owner !== PINNED_OWNER);
    const tools = [
      {
        label: OPEN_LABEL[OPEN_TARGET],
        action: 'open-site',
        hint: OPEN_SHORTCUT_HINT,
      },
      // 「待办事项」是待办面板的唯一入口（单击宠物不再弹面板），排在首项之后。
      { label: '待办事项', action: 'todo', hint: S.TODO_HOTKEY_HINT },
    ];
    // 固定第三方项：复用「更多」那套层级规则（label 唯一则平铺，重名按 owner 分子菜单），
    // 只取 children——容器文案换成父级，所以不要它返回的「更多」节点。
    const pinnedBranch = S.buildMoreBranch(pinnedItems);
    if (pinnedBranch) tools.push(...pinnedBranch.children);
    // 对话/碎碎念/睡觉留在第一层：都是高频动作，收进二级菜单反而多一次悬停。
    tools.push({ label: '对话', action: 'chat', hint: S.CHAT_HOTKEY_HINT });
    tools.push({ label: '碎碎念', action: 'whisper' });
    // 睡觉/起来：睡着时这一项是「起来」（点它等于叫醒），醒着时是「睡觉」。两种文案共用一个位置。
    // 该条目没配 animations.sleep 就整项不出现——与配置注释「不写 = 没有睡觉功能」一致。
    if (Array.isArray(this.animations.sleep) && this.animations.sleep.length > 0) {
      if (this.sleeping) tools.push({ label: '起来', action: 'wake', hint: S.SLEEP_HOTKEY_HINT });
      else tools.push({ label: '睡觉', action: 'sleep', hint: S.SLEEP_HOTKEY_HINT });
    }
    // 「配图」：与浏览器端同一份分支（纳入对话的配图 / 其他），点一张就用它说一句；没有可用图时
    // 返回 null，整项不出现。现在它跟着「对话」一起进「更多」。
    const memeBranch = S.buildMemeBranch(this.pet, (name) => S.memeThumbUrl(BASE, this.pet.assetRoot, name));
    // 「更多」现在也装宿主自己的偶发项与维护项，不再只装第三方项——所以它恒存在。
    const moreThird = S.buildMoreBranch(otherItems);
    const moreChildren = [
      // 「查看余额」无条件显示：关了 balanceEnabled 的宠物也能点，手动请求不受开关限制，点了一定给答复。
      { label: '查看余额', action: 'show-balance' },
      // 「查询天气」与余额同一类：宿主强制刷新并写 sections.env，气泡由 /state 驱动。
      { label: '查询天气', action: 'show-environment' },
      ...(memeBranch ? [memeBranch] : []),
      // 动作树（动作 → 分类 → 动画名）：点播用，属偶发操作。
      ...S.buildMenuTree(this.animations),
      // 显示位置（仅网页/仅桌面/两者/都不）：改这只宠物的 display 配置，由宿主重载生效。
      S.displayMenuBranch(),
      // 重载配置：请宿主重启桌面 Helper，全部窗口按最新配置重建。
      { label: '重载配置', action: 'reload' },
      { label: '回到初始位置', action: 'home' },
      // 其余第三方项（不属于 PINNED_OWNER 的）：label 唯一的直接平铺，重名按 owner 分子菜单。
      ...(moreThird ? moreThird.children : []),
    ];
    const tree = tools.concat([{ label: S.MORE_MENU_LABEL, children: moreChildren }]);
`;

// ---------------------------------------------------------------- 网页端

const WEB_START = 'const more = buildMoreBranch(menuItemsRef.current);';
const WEB_END = 'if (!tree.length) return;';

const T = '\t';
const L = (n, s) => T.repeat(n) + s;

const WEB_NEW =
  [
    L(3, '// 本地定制过的菜单顺序（与上游 dsh-pet 不同；升级/重装 dsh-pet 后重跑'),
    L(3, '// plugins/dsh-gongwei/tools/patch-pet-menu.mjs 才能恢复）：'),
    L(3, `// 待办事项 → 【${PINNED_OWNER} 的第三方项】 → 对话 → 碎碎念 → 睡觉 → 更多（查看余额/查询天气/配图/动作/显示位置/回到初始位置/其余第三方项）。`),
    L(3, '// 网页端没有「打开软件」与「重载配置」：前者只在桌面端，后者会让整个 Helper 重启。'),
    L(3, MARK_WEB),
    L(3, 'const pinnedItems = menuItemsRef.current.filter((it) => it && it.owner === PINNED_OWNER);'),
    L(3, 'const otherItems = menuItemsRef.current.filter((it) => !it || it.owner !== PINNED_OWNER);'),
    L(3, 'const pic = cfgRef.current;'),
    L(3, 'const memes = buildMemeBranch(pic, (name) => memeThumbUrl(ROUTE_PATH, pic.assetRoot, name));'),
    L(3, 'const asleep = live.current.flow?.sleeping() ?? false;'),
    L(3, 'const canSleep = (cfgRef.current.animations.sleep ?? []).length > 0;'),
    L(3, 'const sleepItem = asleep ? {'),
    L(4, 'label: "起来",'),
    L(4, 'action: "wake",'),
    L(4, 'hint: SLEEP_HOTKEY_HINT'),
    L(3, '} : {'),
    L(4, 'label: "睡觉",'),
    L(4, 'action: "sleep",'),
    L(4, 'hint: SLEEP_HOTKEY_HINT'),
    L(3, '};'),
    L(3, 'const tools = [{'),
    L(4, 'label: "待办事项",'),
    L(4, 'action: "todo",'),
    L(4, 'hint: TODO_HOTKEY_HINT'),
    L(3, '}];'),
    L(3, '// 固定第三方项：复用「更多」的层级规则（label 唯一则平铺，重名按 owner 分子菜单），只取 children。'),
    L(3, 'const pinnedBranch = buildMoreBranch(pinnedItems);'),
    L(3, 'if (pinnedBranch) tools.push(...pinnedBranch.children);'),
    L(3, 'tools.push({'),
    L(4, 'label: "对话",'),
    L(4, 'action: "chat",'),
    L(4, 'hint: CHAT_HOTKEY_HINT'),
    L(3, '});'),
    L(3, 'tools.push({'),
    L(4, 'label: "碎碎念",'),
    L(4, 'action: "whisper"'),
    L(3, '});'),
    L(3, 'if (canSleep) tools.push(sleepItem);'),
    L(3, '// 「更多」现在也装宿主自己的偶发项与维护项，不再只装第三方项——所以它恒存在。'),
    L(3, 'const moreThird = buildMoreBranch(otherItems);'),
    L(3, 'const moreChildren = [{'),
    L(4, 'label: "查看余额",'),
    L(4, 'action: "show-balance"'),
    L(3, '}, {'),
    L(4, 'label: "查询天气",'),
    L(4, 'action: "show-environment"'),
    L(3, '}, ...memes ? [memes] : [], ...buildMenuTree(cfgRef.current.animations), displayMenuBranch(), {'),
    L(4, 'label: "回到初始位置",'),
    L(4, 'action: "home"'),
    L(3, '}, ...moreThird ? moreThird.children : []];'),
    L(3, 'const tree = [...tools, {'),
    L(4, 'label: MORE_MENU_LABEL,'),
    L(4, 'children: moreChildren'),
    L(3, '}];'),
    '',
  ].join('\n');

// ---------------------------------------------------------------- 通用

function statusOf(file, mark) {
  if (!existsSync(file)) return 'missing';
  return readFileSync(file, 'utf8').includes(mark) ? 'patched' : 'pristine';
}

function patchOne(file, mark, startMarker, endMarker, replacer, label) {
  const src = readFileSync(file, 'utf8');
  if (src.includes(mark)) {
    console.log(`  ${label}: 已经是打过的状态，跳过`);
    return 'patched';
  }
  const i = src.indexOf(startMarker);
  if (i < 0) {
    console.error(`  ${label}: 找不到起始锚点，dsh-pet 版本可能变了，需要人工确认`);
    return 'failed';
  }
  const j = src.indexOf(endMarker, i);
  if (j < 0) {
    console.error(`  ${label}: 找不到结束锚点（起点 ${i}），dsh-pet 版本可能变了`);
    return 'failed';
  }
  const backup = file + '.orig';
  if (!existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, src.slice(0, i) + replacer() + src.slice(j), 'utf8');
  console.log(`  ${label}: 已打补丁（原 ${j - i} 字符 → ${replacer().length} 字符，备份 ${path.basename(backup)}）`);
  return 'patched';
}

function restoreOne(file, label) {
  const backup = file + '.orig';
  if (!existsSync(backup)) {
    console.log(`  ${label}: 没有 .orig 备份，无法还原（可重装 dsh-pet）`);
    return 'skipped';
  }
  copyFileSync(backup, file);
  console.log(`  ${label}: 已还原成上游原样`);
  return 'restored';
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const mode = argv.includes('--check') ? 'check' : argv.includes('--restore') ? 'restore' : 'patch';
const pkgFlag = argv.indexOf('--pkg');
const pkgDir = findPkgDir(pkgFlag >= 0 ? argv[pkgFlag + 1] : undefined);

const desktopFile = path.join(pkgDir, REL_DESKTOP);
const webFile = path.join(pkgDir, REL_WEB);

console.log(`dsh-pet 包目录：${pkgDir}`);
console.log(`模式：${mode}${mode === 'patch' ? `（固定 owner = ${PINNED_OWNER}）` : ''}`);

let ok = true;
if (mode === 'check') {
  console.log(`  桌面端 ${REL_DESKTOP}: ${statusOf(desktopFile, MARK_DESKTOP)}`);
  console.log(`  网页端 ${REL_WEB}: ${statusOf(webFile, MARK_WEB)}`);
} else if (mode === 'restore') {
  restoreOne(desktopFile, '桌面端');
  restoreOne(webFile, '网页端');
} else {
  ok = patchOne(desktopFile, MARK_DESKTOP, DESKTOP_START, DESKTOP_END, () => DESKTOP_NEW, '桌面端') === 'patched' && ok;
  ok = patchOne(webFile, MARK_WEB, WEB_START, WEB_END, () => WEB_NEW, '网页端') === 'patched' && ok;
  if (ok) {
    console.log('');
    console.log('生效方式：');
    console.log('  桌面端：POST /dsh-pet-7340/reload（或右键菜单 → 更多 → 重载配置），重启桌面 Helper');
    console.log('  网页端：刷新浏览器页面');
  }
}

process.exit(ok ? 0 : 1);
