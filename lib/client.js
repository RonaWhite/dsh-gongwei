/**
 * dsh-gongwei —— 客户端半边：DSH「设置」里的两个 section
 *
 *   1. **想学的**（id `gongwei`）   —— 池子：往裡加东西、勾完成、改正文/备注。
 *   2. **成长手记**（id `gongwei-today`）—— 今天写的完整原文 + 本周回顾。
 *
 * id `gongwei-today` 是从上一版「今天」面板延续下来的，刻意不改：
 * 它只是 slot 的键，改了会让已经挂在旧 id 上的入口失联。
 *
 * 数据流：section ⇄ `/dsh-gongwei/api/{plans,today,reports}`（同源 fetch）
 *   ⇄ `<DSH_HOME>/dsh-gongwei/state.json`
 *   —— 与工具/命令/桌宠菜单读**同一份数据、走同一批函数**，不存在两套账。
 *
 * 约束（DSH 插件 UI 规范）：
 *   - 客户端是惰性 factory，id 必须等于包名；React 从浏览器模块表取，不另外装。
 *   - 不替换 app root、不往 document.body 追加第二个应用、不读别的插件的 DOM/CSS。
 *   - 颜色全走 `--dsw-alias-*` 主题 token，深色/浅色自动跟随。
 *   - 不引任何 `@deepseek-ai/dsh-client-*` 包；Markdown 自己按子集渲染成 React 节点，
 *     **绝不使用 dangerouslySetInnerHTML**——周报正文来自模型/用户输入，不能当 HTML 信任。
 */
window.__ModuleLoader__.load({
  id: "dsh-gongwei",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = "/dsh-gongwei/api/plans";

    const CSS = [
      /* ── 想学的（池子） ── */
      ".gw{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px}",
      ".gw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".gw-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}",
      ".gw-count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".gw-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      ".gw-input{flex:1;min-width:220px;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:13px;height:32px;padding:0 10px;outline:none}",
      ".gw-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".gw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:32px;padding:0 14px;cursor:pointer}",
      ".gw-btn:disabled{opacity:.5;cursor:default}",
      ".gw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".gw-list{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".gw-item{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".gw-item:last-child{border-bottom:none}",
      ".gw-check{margin-top:2px;width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none}",
      ".gw-body{flex:1;min-width:0}",
      ".gw-text{font-size:13px;line-height:20px;word-break:break-word}",
      ".gw-text.gw-done{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}",
      ".gw-meta{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;margin-top:2px}",
      ".gw-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:3px;white-space:pre-wrap;word-break:break-word}",
      ".gw-item-actions{display:flex;gap:6px;flex:none;opacity:0;transition:opacity .12s}",
      ".gw-item:hover .gw-item-actions,.gw-item:focus-within .gw-item-actions{opacity:1}",
      ".gw-mini{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:5px;font-size:11.5px;height:24px;padding:0 8px;cursor:pointer;white-space:nowrap}",
      ".gw-mini:hover{color:var(--dsw-alias-label-primary)}",
      ".gw-mini.gw-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".gw-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:18px 0;text-align:center}",
      ".gw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-line}",
      ".gw-ok{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".gw-section{display:flex;flex-direction:column;gap:6px;margin-top:6px}",
      ".gw-section-h{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:8px}",

      /* ── 成长手记：整体节奏放宽，卡片之间留白，读长文不挤 ── */
      ".gw-j{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px}",
      ".gw-j-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}",
      ".gw-j-date{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}",
      ".gw-j-tabs{display:flex;gap:18px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".gw-j-tab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:6px 0 7px;margin-bottom:-.5px;cursor:pointer}",
      ".gw-j-tab:hover{color:var(--dsw-alias-label-secondary)}",
      ".gw-j-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}",
      ".gw-j-panel{display:flex;flex-direction:column;gap:16px}",

      /* 概览行：一组统计，用 · 分开，不抢正文的注意力 */
      ".gw-j-sum{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}",

      /* 分组：标题 + 若干卡片 */
      ".gw-j-group{display:flex;flex-direction:column;gap:10px}",
      ".gw-j-group-h{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0}",
      ".gw-j-group-h span{font-weight:400;color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-left:8px}",

      /* 卡片：细边 + 大内边距 + 时间标记 */
      ".gw-j-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px 12px;display:flex;flex-direction:column;gap:9px;background:transparent}",
      ".gw-j-card-h{display:flex;align-items:center;gap:10px}",
      ".gw-j-time{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;letter-spacing:.03em;flex:none}",
      ".gw-j-tick{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:.5;flex:none}",
      ".gw-j-lead{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:20px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px}",
      ".gw-j-orig{display:flex;flex-direction:column;gap:6px}",
      ".gw-j-orig-p{margin:0;font-size:13px;line-height:22px;word-break:break-word;user-select:text;color:var(--dsw-alias-label-primary)}",
      ".gw-j-more{align-self:flex-start;background:transparent;border:none;color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;padding:0;cursor:pointer}",
      ".gw-j-actions{display:flex;gap:8px;flex-wrap:wrap}",
      ".gw-j-mini{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:5px;font-size:11.5px;height:26px;padding:0 10px;cursor:pointer;white-space:nowrap}",
      ".gw-j-mini:hover{color:var(--dsw-alias-label-primary)}",
      ".gw-j-mini:disabled{opacity:.5;cursor:default}",
      ".gw-j-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:22px 0;text-align:center;border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px}",

      /* 周报预览：文档式排版，标题/列表/引用都从 Markdown 子集来 */
      ".gw-j-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      ".gw-j-seg{display:flex;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}",
      ".gw-j-seg button{background:transparent;border:none;color:var(--dsw-alias-label-tertiary);font-size:12px;height:28px;padding:0 12px;cursor:pointer}",
      ".gw-j-seg button+button{border-left:1px solid var(--dsw-alias-border-l2)}",
      ".gw-j-seg button[aria-pressed=true]{background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}",
      ".gw-j-doc{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:20px 22px;display:flex;flex-direction:column;gap:9px}",
      ".gw-j-h{margin:6px 0 0;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".gw-j-h:first-child{margin-top:0}",
      ".gw-j-h1{font-size:15px;line-height:24px}",
      ".gw-j-h2{font-size:13.5px;line-height:22px}",
      ".gw-j-h3{font-size:13px;line-height:20px}",
      ".gw-j-p{margin:0;font-size:13px;line-height:22px;word-break:break-word;user-select:text;white-space:pre-wrap}",
      ".gw-j-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}",
      ".gw-j-list li{font-size:13px;line-height:22px;word-break:break-word;user-select:text}",
      ".gw-j-quote{margin:0;padding:2px 0 2px 12px;border-left:2px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:6px}",
      ".gw-j-quote p{margin:0;font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary);user-select:text;white-space:pre-wrap}",
    ].join("");

    const CSS_TAG = "dsh-gongwei/section.css";
    function injectCss() {
      if (document.querySelector(`style[data-tag="${CSS_TAG}"]`)) return;
      const el = document.createElement("style");
      el.setAttribute("data-tag", CSS_TAG);
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /** 一条相对时间：面板上不该出现 2026-11-18T07:12:33.123Z 这种东西。 */
    function ago(ts, now) {
      if (typeof ts !== "number") return "";
      const diff = now - ts;
      const day = 86_400_000;
      if (diff < 60_000) return "刚刚";
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
      const days = Math.floor(diff / day);
      if (days === 1) return "昨天";
      if (days < 30) return `${days} 天前`;
      return new Date(ts).toLocaleDateString();
    }

    /** 今天的日期，写成 2026-11-18 周三。 */
    function todayLabel() {
      const d = new Date();
      const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${names[d.getDay()]}`;
    }

    /** 统一的错误文案：401/403 是信任栅栏，别让人以为是自己网络坏了。 */
    function httpErrorText(status) {
      if (status === 401 || status === 403) {
        return "这个页面没有权限访问插件数据（信任栅栏拒绝了）。请在 DSH 的界面里打开设置。";
      }
      return `服务端返回了非 JSON（HTTP ${status}）。`;
    }

    async function request(method, id, body) {
      const url = id ? `${API}/${encodeURIComponent(id)}` : API;
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: httpErrorText(res.status) };
      const data = await res.json().catch(() => null);
      if (data === null) return { ok: false, error: httpErrorText(res.status) };
      if (data.ok === false) return { ok: false, error: data.error ?? "操作失败。" };
      return data;
    }

    /* ────────────────────────── 想学的（池子） ────────────────────────── */

    function GongweiSection() {
      const [plans, setPlans] = useState([]);
      const [stats, setStats] = useState({ open: 0, done: 0, doneToday: 0 });
      const [text, setText] = useState("");
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState(false);
      const [loading, setLoading] = useState(true);
      const [editing, setEditing] = useState(null);
      const [editText, setEditText] = useState("");
      const [noting, setNoting] = useState(null);
      const [noteText, setNoteText] = useState("");
      const [confirmId, setConfirmId] = useState(null);
      const [notice, setNotice] = useState("");
      const [now, setNow] = useState(Date.now());
      const inputRef = useRef(null);
      const cssDone = useRef(false);

      if (!cssDone.current) {
        cssDone.current = true;
        if (typeof document !== "undefined") injectCss();
      }

      const apply = useCallback((data) => {
        if (Array.isArray(data.plans)) setPlans(data.plans);
        if (data.stats) setStats(data.stats);
      }, []);

      const load = useCallback(async () => {
        setLoading(true);
        const data = await request("GET");
        if (data.ok === false) setErr(data.error);
        else {
          setErr("");
          apply(data);
        }
        setLoading(false);
      }, [apply]);

      useEffect(() => {
        void load();
      }, [load]);

      // 相对时间每分钟重算一次：不改数据，只让「3 天前」别停在打开那一刻
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
      }, []);

      // 删除是两段确认，2.5 秒没再点就收回，避免误删（跟桌宠面板一个手感）
      useEffect(() => {
        if (confirmId === null) return undefined;
        const timer = setTimeout(() => setConfirmId(null), 2500);
        return () => clearTimeout(timer);
      }, [confirmId]);

      const mutate = useCallback(
        async (method, id, body) => {
          if (busy) return false;
          setBusy(true);
          const data = await request(method, id, body);
          if (data.ok === false) {
            setErr(data.error);
            setBusy(false);
            return false;
          }
          setErr("");
          apply(data);
          setBusy(false);
          return true;
        },
        [apply, busy],
      );

      const add = useCallback(async () => {
        const clean = text.trim();
        if (clean === "") {
          inputRef.current?.focus();
          return;
        }
        const ok = await mutate("POST", "", { text: clean });
        if (ok) {
          setText("");
          inputRef.current?.focus();
        }
      }, [mutate, text]);

      const toggle = useCallback(
        (plan) => mutate("PATCH", plan.id, { done: !plan.done }),
        [mutate],
      );

      const startEdit = useCallback((plan) => {
        setEditing(plan.id);
        setEditText(plan.text);
        setNoting(null);
      }, []);

      const commitEdit = useCallback(
        async (plan) => {
          const clean = editText.trim();
          if (clean === "" || clean === plan.text) {
            setEditing(null);
            return;
          }
          const ok = await mutate("PATCH", plan.id, { text: clean });
          if (ok) setEditing(null);
        },
        [editText, mutate],
      );

      const startNote = useCallback((plan) => {
        setNoting(plan.id);
        setNoteText(plan.note ?? "");
        setEditing(null);
      }, []);

      const commitNote = useCallback(
        async (plan) => {
          const clean = noteText.trim();
          if (clean === (plan.note ?? "")) {
            setNoting(null);
            return;
          }
          const ok = await mutate("PATCH", plan.id, { note: clean });
          if (ok) setNoting(null);
        },
        [mutate, noteText],
      );

      const remove = useCallback(
        async (plan) => {
          if (confirmId !== plan.id) {
            setConfirmId(plan.id);
            return;
          }
          setConfirmId(null);
          await mutate("DELETE", plan.id);
        },
        [confirmId, mutate],
      );

      // 从桌宠自带待办搬一次。搬完只报条数——具体搬了哪几条，看列表就知道了
      const importTodos = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        const data = await request("POST", "import");
        if (data.ok === false) {
          setErr(data.error);
          setNotice("");
        } else {
          setErr("");
          apply(data);
          setNotice(data.message ?? "");
        }
        setBusy(false);
      }, [apply, busy]);

      const open = plans.filter((p) => !p.done);
      const done = plans.filter((p) => p.done);

      const item = (plan) =>
        h(
          "div",
          { className: "gw-item", key: plan.id },
          h("input", {
            className: "gw-check",
            type: "checkbox",
            checked: plan.done,
            disabled: busy,
            onChange: () => toggle(plan),
            title: plan.done ? "取消划掉（会收回自动写的那条学习记录）" : "标成看完了（顺手记一条学习记录）",
          }),
          h(
            "div",
            { className: "gw-body" },
            editing === plan.id
              ? h("input", {
                  className: "gw-input",
                  value: editText,
                  autoFocus: true,
                  maxLength: 200,
                  onChange: (e) => setEditText(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Enter") void commitEdit(plan);
                    if (e.key === "Escape") setEditing(null);
                  },
                  onBlur: () => void commitEdit(plan),
                })
              : h(
                  "div",
                  { className: plan.done ? "gw-text gw-done" : "gw-text" },
                  plan.text,
                ),
            h(
              "div",
              { className: "gw-meta" },
              plan.done
                ? plan.doneDay
                  ? `${plan.doneDay} 划掉`
                  : "已划掉"
                : `加于 ${ago(plan.createdAt, now)}`,
            ),
            noting === plan.id
              ? h("input", {
                  className: "gw-input",
                  value: noteText,
                  autoFocus: true,
                  maxLength: 500,
                  placeholder: "记一句备注，比如「先看第三章」",
                  onChange: (e) => setNoteText(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Enter") void commitNote(plan);
                    if (e.key === "Escape") setNoting(null);
                  },
                  onBlur: () => void commitNote(plan),
                  style: { marginTop: "6px", width: "100%" },
                })
              : plan.note
                ? h("div", { className: "gw-note" }, plan.note)
                : null,
          ),
          h(
            "div",
            { className: "gw-item-actions" },
            editing === plan.id || noting === plan.id
              ? null
              : h(
                  "button",
                  { className: "gw-mini", onClick: () => startNote(plan), disabled: busy },
                  plan.note ? "改备注" : "备注",
                ),
            editing === plan.id || noting === plan.id
              ? null
              : h("button", { className: "gw-mini", onClick: () => startEdit(plan), disabled: busy }, "改"),
            h(
              "button",
              {
                className: confirmId === plan.id ? "gw-mini gw-danger" : "gw-mini",
                onClick: () => remove(plan),
                disabled: busy,
              },
              confirmId === plan.id ? "确认删" : "删",
            ),
          ),
        );

      return h(
        "div",
        { className: "gw" },
        h("h3", { className: "gw-title" }, "想学的"),
        h(
          "p",
          { className: "gw-intro" },
          "想到什么就往这儿丢，不用排日期。每天从池子里挑几样做，做完了打勾——打勾会顺手往当天学习记录里写一条，周报能算出这周划掉了几条。",
        ),
        h(
          "div",
          { className: "gw-form" },
          h("input", {
            ref: inputRef,
            className: "gw-input",
            placeholder: "想学点什么？比如「把 RetNet 的 cache 机制搞明白」",
            value: text,
            maxLength: 200,
            disabled: busy,
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void add();
            },
          }),
          h(
            "button",
            { className: "gw-btn", onClick: () => void add(), disabled: busy || text.trim() === "" },
            "丢进池子",
          ),
          h("button", { className: "gw-btn gw-btn2", onClick: () => void load(), disabled: busy }, "刷新"),
          h(
            "button",
            {
              className: "gw-btn gw-btn2",
              onClick: () => void importTodos(),
              disabled: busy || loading,
              title: "把桌宠「待办事项」里已有的条目一次性搬进这个池子（不会删掉原待办）",
            },
            "从待办搬过来",
          ),
        ),
        h(
          "div",
          { className: "gw-count" },
          loading
            ? "读取中…"
            : stats.open === 0 && stats.done === 0
              ? "池子是空的。"
              : `还欠 ${stats.open} 条；已划掉 ${stats.done} 条${stats.doneToday > 0 ? `，今天 ${stats.doneToday} 条` : ""}。`,
        ),
        err ? h("div", { className: "gw-err" }, err) : null,
        notice && !err ? h("div", { className: "gw-ok" }, notice) : null,
        loading
          ? null
          : plans.length === 0
            ? h("div", { className: "gw-empty" }, "还没有想学的。上面写一条，回车。")
            : h(
                "div",
                { className: "gw-section" },
                h("div", { className: "gw-list" }, open.map(item)),
                done.length > 0
                  ? h(
                      "details",
                      { open: false },
                      h("summary", { className: "gw-section-h", style: { cursor: "pointer" } }, `划掉的（${done.length}）`),
                      h("div", { className: "gw-list" }, done.map(item)),
                    )
                  : null,
              ),
        h(
          "div",
          { className: "gw-ok" },
          "也可以在对话里说「我想学 XXX」「这个看完了」，或者敲 /gongwei 想学 <内容>、/gongwei 池子。",
        ),
      );
    }

    /* ────────────────────────── 剪贴板 ────────────────────────── */

    /**
     * 复制一段文本。
     *
     * 先试 Clipboard API（设置页是 https/localhost 上下文，通常可用），
     * 失败再回退到隐藏 textarea + execCommand——不这么兜一层，
     * 某些环境下按钮点了会「什么都没发生」，用户只会觉得坏了。
     */
    async function copyText(value) {
      const text = String(value ?? "");
      if (text === "") return false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* 落到下面的回退 */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    /* ────────────────────────── 安全 Markdown 子集 ────────────────────────── */

    /**
     * 只认标题、列表、引用、加粗、段落——够把周报读舒服，又不用引入渲染器。
     *
     * 为什么不用现成库、也不用 dangerouslySetInnerHTML：周报正文里有模型生成的文字，
     * 一旦按 HTML 信任，模型（或未来的某次提示词注入）就能往设置页里塞标签。
     * 这里一律走 React 节点，文本永远是文本。
     */
    function parseMarkdown(source) {
      const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
      const blocks = [];
      let i = 0;
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed === "") {
          i += 1;
          continue;
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
        if (heading !== null) {
          blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
          i += 1;
          continue;
        }
        if (trimmed.startsWith(">")) {
          const quoted = [];
          while (i < lines.length && lines[i].trim().startsWith(">")) {
            quoted.push(lines[i].trim().replace(/^>\s?/, ""));
            i += 1;
          }
          blocks.push({ kind: "quote", lines: quoted });
          continue;
        }
        const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
        const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
        if (bullet !== null || numbered !== null) {
          const ordered = bullet === null;
          const items = [];
          while (i < lines.length) {
            const line = lines[i].trim();
            const nextBullet = /^[-*+]\s+(.*)$/.exec(line);
            const nextNumbered = /^\d+[.)]\s+(.*)$/.exec(line);
            if (nextBullet !== null && !ordered) {
              items.push(nextBullet[1]);
              i += 1;
              continue;
            }
            if (nextNumbered !== null && ordered) {
              items.push(nextNumbered[1]);
              i += 1;
              continue;
            }
            break;
          }
          blocks.push({ kind: "list", ordered, items });
          continue;
        }
        const para = [];
        while (i < lines.length) {
          const line = lines[i].trim();
          if (
            line === "" ||
            /^#{1,4}\s+/.test(line) ||
            line.startsWith(">") ||
            /^[-*+]\s+/.test(line) ||
            /^\d+[.)]\s+/.test(line)
          ) {
            break;
          }
          para.push(line);
          i += 1;
        }
        if (para.length === 0) {
          i += 1;
          continue;
        }
        // 段落内部保留用户自己的换行：用 \n 连接，渲染时配 white-space:pre-wrap。
        // 绝不压平成空格——用户写记录时按行分段是有意义的。
        blocks.push({ kind: "paragraph", text: para.join("\n") });
      }
      return blocks;
    }

    /** 行内只处理 **加粗**：其余字符原样保留成文本节点。 */
    function inline(text, keyBase) {
      const source = String(text ?? "");
      const out = [];
      let cursor = 0;
      let index = 0;
      const pattern = /\*\*([^*]+)\*\*/g;
      let match = pattern.exec(source);
      while (match !== null) {
        if (match.index > cursor) out.push(source.slice(cursor, match.index));
        out.push(h("strong", { key: `${keyBase}-b${index}` }, match[1]));
        index += 1;
        cursor = match.index + match[0].length;
        match = pattern.exec(source);
      }
      if (cursor < source.length) out.push(source.slice(cursor));
      return out;
    }

    /**
     * 把解析好的块渲染成 React 节点。
     *
     * MarkdownView（周报）和 OriginalText（日记录原文）共用同一个渲染器：
     * 用户日记录里也会写 `- 看的什么` / `## 计划`，两处必须表现一致。
     *
     * `segmented: true` 只给日记录原文用：没有 Markdown 结构的长口语，
     * 也要按句读切成 2~3 句一段，而不是整坨堆一个 <p> 里。
     * 周报是已经排好版的，不需要也不该被重切。
     */
    function renderBlocks(blocks, keyBase = "b", segmented = false) {
      const out = [];
      blocks.forEach((block, bi) => {
        const key = `${keyBase}${bi}`;
        if (block.kind === "heading") {
          const tag = block.level <= 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          const size = block.level <= 1 ? "gw-j-h gw-j-h1" : block.level === 2 ? "gw-j-h gw-j-h2" : "gw-j-h gw-j-h3";
          out.push(h(tag, { key, className: size }, inline(block.text, key)));
          return;
        }
        if (block.kind === "quote") {
          out.push(
            h(
              "blockquote",
              { key, className: "gw-j-quote" },
              block.lines.map((line, li) => h("p", { key: `${key}-q${li}` }, inline(line, `${key}-q${li}`))),
            ),
          );
          return;
        }
        if (block.kind === "list") {
          const tag = block.ordered ? "ol" : "ul";
          out.push(
            h(
              tag,
              { key, className: "gw-j-list" },
              block.items.map((item, li) => h("li", { key: `${key}-l${li}` }, inline(item, `${key}-l${li}`))),
            ),
          );
          return;
        }
        if (!segmented) {
          out.push(h("p", { key, className: "gw-j-p" }, inline(block.text, key)));
          return;
        }
        // 分段：先按原文换行保行，再把过长的行按句读切成若干段。
        segmentParagraph(block.text).forEach((chunk, ci) => {
          out.push(h("p", { key: `${key}-p${ci}`, className: "gw-j-p" }, inline(chunk, `${key}-p${ci}`)));
        });
      });
      return out;
    }

    function MarkdownView({ source, className }) {
      const blocks = parseMarkdown(source);
      if (blocks.length === 0) return h("div", { className: "gw-j-empty" }, "还没有内容。");
      return h("div", { className }, renderBlocks(blocks));
    }

    /* ────────────────────────── 原文分段 ────────────────────────── */

    const COLLAPSE_OVER = 120;
    const SENTENCE_END = new Set(["。", "！", "？", "；", "…", "\n"]);

    /**
     * 按句子切开一段口语原文。
     *
     * 用户写记录时是一口气写下来的（「看B站…了解了机器学习…开始看鱼皮的…打算以后…」），
     * 一坨堆在一起很难读。按句读切成段落后，扫一眼就知道今天干了几件事。
     * 只切不改字：拼回去和原文完全一样。
     */
    function splitSentences(text) {
      const flat = String(text ?? "").replace(/\s+/g, " ").trim();
      if (flat === "") return [];
      const out = [];
      let buffer = "";
      for (const char of flat) {
        if (SENTENCE_END.has(char)) {
          if (char !== "\n") buffer += char;
          if (buffer.trim() !== "") out.push(buffer.trim());
          buffer = "";
          continue;
        }
        buffer += char;
      }
      if (buffer.trim() !== "") out.push(buffer.trim());
      return out.length > 0 ? out : [flat];
    }

    /**
     * 把一行（不含换行）按句读切开，一个字都不改。
     * 和 splitSentences 的区别：这里不 flatten 空白，因为调用方已经按 \n 切好行了。
     */
    function splitLineSentences(line) {
      const out = [];
      let buffer = "";
      for (const char of line) {
        buffer += char;
        if (SENTENCE_END.has(char) && char !== "\n") {
          out.push(buffer);
          buffer = "";
        }
      }
      if (buffer !== "") out.push(buffer);
      return out;
    }

    /** 一段口语最多塞这么多字就换下一段（约两三句），再长就变成一堵墙。 */
    const SEGMENT_MAX = 60;

    /**
     * 把一段原文切成若干可读的小段。
     *
     * 两条规矩：
     * 1. **先按用户自己的换行分**——他按行分段是故意的，不能压成一行；
     * 2. 单行太长再按句读贪心合并到 60 字左右，让「一口气写下来」的长句断在句号处。
     * 只切不改字，拼回去和原文一致（除行首尾空白）。
     */
    function segmentParagraph(text) {
      const chunks = [];
      const lines = String(text ?? "").split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line === "") continue;
        if (line.length <= SEGMENT_MAX) {
          chunks.push(line);
          continue;
        }
        let buffer = "";
        for (const sentence of splitLineSentences(line)) {
          if (buffer !== "" && buffer.length + sentence.length > SEGMENT_MAX) {
            chunks.push(buffer.trim());
            buffer = sentence;
          } else {
            buffer += sentence;
          }
        }
        if (buffer.trim() !== "") chunks.push(buffer.trim());
      }
      if (chunks.length > 0) return chunks;
      const fallback = String(text ?? "").trim();
      return fallback === "" ? [] : [fallback];
    }

    /**
     * 折叠态只留第一块：段落就再收窄到它自己的第一小段。
     * 标题/列表/引用原样保留——它们是结构，砍掉反而看不出这段在讲什么。
     */
    function collapseFirstBlock(blocks) {
      if (blocks.length === 0) return [];
      const first = blocks[0];
      if (first.kind !== "paragraph") return [first];
      const chunks = segmentParagraph(first.text);
      if (chunks.length <= 1) return [first];
      return [{ kind: "paragraph", text: chunks[0] }];
    }

    /**
     * 日记录/感想的原文渲染。
     *
     * 用户写的时候本来就会用 Markdown（`- 看了什么`、`## 下周`、`> 想法`），
     * 所以这里跟周报走**同一个** parseMarkdown + renderBlocks：
     * 只按句号切纯文本是不够的，那会把用户排好的结构压成一坨。
     *
     * 折叠仍然保留：长文先只露第一块（用户自己分的段）或第一句（纯散文），
     * 点「展开全文」看完整原文。**复制原文永远复制未经处理的原文**，与展开状态无关。
     */
    function OriginalText({ text }) {
      const [expanded, setExpanded] = useState(false);
      const source = String(text ?? "");
      const flat = source.replace(/\s+/g, " ").trim();
      if (flat === "") {
        return h("div", { className: "gw-j-orig" }, h("p", { className: "gw-j-p" }, "（空）"));
      }
      const blocks = parseMarkdown(source);
      const chunks = segmentParagraph(source);
      // 折叠判据：够长，且展开后确实会多出内容——否则按钮点了没变化，纯噪音。
      const collapsible = flat.length > COLLAPSE_OVER && (blocks.length > 1 || chunks.length > 1);
      let body;
      if (!collapsible || expanded) {
        body = renderBlocks(blocks, "s", true);
      } else {
        // 折叠态：只露第一块；第一块若是长段落，就再只露它的第一小段。
        body = renderBlocks(collapseFirstBlock(blocks), "s", true);
      }
      return h(
        "div",
        { className: "gw-j-orig" },
        body,
        collapsible
          ? h(
              "button",
              { className: "gw-j-more", onClick: () => setExpanded(!expanded), type: "button" },
              expanded ? "收起" : `展开全文（${flat.length} 字）`,
            )
          : null,
      );
    }

    /** 一条记录/感想：时间标记 + 概览 + 原文 + 复制。 */
    function DiaryCard({ at, summary, text, onCopy }) {
      return h(
        "article",
        { className: "gw-j-card" },
        h(
          "div",
          { className: "gw-j-card-h" },
          h("span", { className: "gw-j-tick" }),
          h("span", { className: "gw-j-time" }, at || "—"),
        ),
        typeof summary === "string" && summary !== "" ? h("p", { className: "gw-j-lead" }, summary) : null,
        h(OriginalText, { text }),
        h(
          "div",
          { className: "gw-j-actions" },
          h(
            "button",
            { className: "gw-j-mini", type: "button", onClick: () => void onCopy(text) },
            "复制原文",
          ),
        ),
      );
    }

    /* ────────────────────────── 数据请求 ────────────────────────── */

    const TODAY_API = "/dsh-gongwei/api/today";
    const REPORTS_API = "/dsh-gongwei/api/reports";

    async function fetchJson(url, init) {
      const res = await fetch(url, { credentials: "same-origin", ...init });
      if (res.status === 401 || res.status === 403) return { ok: false, error: httpErrorText(res.status) };
      const data = await res.json().catch(() => null);
      if (data === null) return { ok: false, error: httpErrorText(res.status) };
      if (data.ok === false) return { ok: false, error: data.error ?? "读取失败。" };
      return data;
    }

    /* ────────────────────────── 成长手记 ────────────────────────── */

    const REPORT_KINDS = [
      { id: "stat", label: "统计表" },
      { id: "article", label: "成文版" },
    ];

    /**
     * 成长手记：日记（今天写的原文）+ 每周回顾（两份周报）。
     *
     * 气泡里只放得下摘要，长原文在这里读。之所以和「想学的」分成两个 section：
     * 一个的动作是「往里加东西」，一个是「把写过的完整读一遍」，混在一起会长到没人想滚。
     */
    function JournalSection() {
      const [tab, setTab] = useState("diary");
      const [data, setData] = useState(null);
      const [loadErr, setLoadErr] = useState("");
      const [loading, setLoading] = useState(true);
      const [notice, setNotice] = useState("");
      const [report, setReport] = useState(null);
      const [reportSaved, setReportSaved] = useState(false);
      const [reportErr, setReportErr] = useState("");
      const [reportBusy, setReportBusy] = useState(false);
      const [reportKind, setReportKind] = useState("stat");
      const cssDone = useRef(false);

      // 每次请求带一个序号：晚到的旧响应直接丢掉，绝不覆盖新数据。
      const diarySeq = useRef(0);
      const reportSeq = useRef(0);
      const reportTried = useRef(false);

      if (!cssDone.current) {
        cssDone.current = true;
        if (typeof document !== "undefined") injectCss();
      }

      const loadDiary = useCallback(async () => {
        const seq = diarySeq.current + 1;
        diarySeq.current = seq;
        setLoading(true);
        setLoadErr("");
        try {
          const result = await fetchJson(TODAY_API);
          if (diarySeq.current !== seq) return;
          if (result.ok === false) {
            setLoadErr(result.error);
            setData(null);
          } else {
            setData(result);
          }
        } catch (error) {
          if (diarySeq.current !== seq) return;
          setLoadErr(`读取失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (diarySeq.current === seq) setLoading(false);
        }
      }, []);

      const loadReport = useCallback(async (method) => {
        const seq = reportSeq.current + 1;
        reportSeq.current = seq;
        setReportBusy(true);
        setReportErr("");
        setNotice("");
        try {
          const result = await fetchJson(REPORTS_API, method === "POST" ? { method: "POST" } : undefined);
          if (reportSeq.current !== seq) return;
          if (result.ok === false) {
            setReportErr(result.error);
          } else {
            setReport({ stat: result.stat ?? "", article: result.article ?? "", week: result.week ?? "" });
            // 只有 POST 才落盘；GET 是实时预览。分开记，免得预览时也报「已保存」。
            const saved = method === "POST";
            setReportSaved(saved);
            setNotice(saved ? `已生成并保存到 reports/（${result.week ?? ""} 那周的两份文件）。` : "");
          }
        } catch (error) {
          if (reportSeq.current !== seq) return;
          setReportErr(`读取失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (reportSeq.current === seq) setReportBusy(false);
        }
      }, []);

      useEffect(() => {
        void loadDiary();
      }, [loadDiary]);

      // 切到「每周回顾」时才去取预览：没点开就发请求是白花一次读盘。
      useEffect(() => {
        if (tab !== "week" || reportTried.current) return;
        reportTried.current = true;
        void loadReport("GET");
      }, [tab, loadReport]);

      const copy = useCallback(async (text, label) => {
        const ok = await copyText(text);
        setNotice(ok ? `已复制${label ?? ""}。` : "复制失败——可能是浏览器没给剪贴板权限，可以手动选中复制。");
      }, []);

      const entries = Array.isArray(data?.entries) ? data.entries : [];
      const thoughts = Array.isArray(data?.thoughts) ? data.thoughts : [];
      const entrySummaries = Array.isArray(data?.entrySummaries) ? data.entrySummaries : null;
      const thoughtSummaries = Array.isArray(data?.thoughtSummaries) ? data.thoughtSummaries : null;

      const summaryParts = [];
      if (data?.checkin) summaryParts.push(`${data.checkin} 打卡`);
      if (entries.length > 0) summaryParts.push(`学到 ${entries.length} 条（${data.entryChars ?? 0} 字）`);
      if (thoughts.length > 0) summaryParts.push(`想到 ${thoughts.length} 条（${data.thoughtChars ?? 0} 字）`);
      if (data?.streak) summaryParts.push(String(data.streak).replace(/。$/, ""));
      if (data?.week) summaryParts.push(`本周 ${data.week.attended}/${data.week.worked} 天，平均 ${data.week.avg}`);
      if (typeof data?.plansOpen === "number") summaryParts.push(`池子还欠 ${data.plansOpen} 条`);

      const renderCards = (items, summaries, hint, empty) => {
        if (items.length === 0) return h("div", { className: "gw-j-empty" }, empty);
        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          items.map((item, index) =>
            h(DiaryCard, {
              // 概览可能为 null（后端没算出来），也可能整段是 null（功能关闭）——
              // 两种都当「没有概览」处理，绝不拿 undefined 去渲染。
              key: `${item?.ts ?? index}`,
              at: item?.at,
              summary: summaries === null ? null : summaries[index] ?? null,
              text: item?.text,
              onCopy: (value) => copy(value, hint),
            }),
          ),
        );
      };

      const diaryPanel = h(
        "div",
        { className: "gw-j-panel" },
        h("p", { className: "gw-j-sum" }, loading && data === null ? "读取中…" : summaryParts.join(" · ")),
        loadErr ? h("div", { className: "gw-err" }, loadErr) : null,
        h(
          "section",
          { className: "gw-j-group" },
          h(
            "h4",
            { className: "gw-j-group-h" },
            "学到的",
            h("span", null, entries.length > 0 ? `${entries.length} 条 · 按记录顺序` : "事实：看了什么、跑通了什么"),
          ),
          renderCards(
            entries,
            entrySummaries,
            "这条记录",
            "今天还没有学习记录。在对话里说「记一下：看了什么」，或者敲 /gongwei 记 <内容>。",
          ),
        ),
        h(
          "section",
          { className: "gw-j-group" },
          h(
            "h4",
            { className: "gw-j-group-h" },
            "想到的",
            h("span", null, thoughts.length > 0 ? `${thoughts.length} 条 · 判断和情绪，不进学习统计` : "判断和情绪，不进学习统计"),
          ),
          renderCards(
            thoughts,
            thoughtSummaries,
            "这条感想",
            "今天还没有感想。在对话里说「感想：……」，或者敲 /gongwei 感想 <内容>。",
          ),
        ),
      );

      const current = report === null ? "" : String(report[reportKind] ?? "");
      const weekPanel = h(
        "div",
        { className: "gw-j-panel" },
        h(
          "div",
          { className: "gw-j-toolbar" },
          h(
            "div",
            { className: "gw-j-seg" },
            REPORT_KINDS.map((kind) =>
              h(
                "button",
                {
                  key: kind.id,
                  type: "button",
                  "aria-pressed": reportKind === kind.id,
                  onClick: () => setReportKind(kind.id),
                },
                kind.label,
              ),
            ),
          ),
          h(
            "button",
            { className: "gw-j-mini", type: "button", onClick: () => void loadReport("POST"), disabled: reportBusy },
            reportBusy ? "生成中…" : "生成并保存",
          ),
          h(
            "button",
            { className: "gw-j-mini", type: "button", onClick: () => void copy(current, "周报正文"), disabled: current === "" },
            "复制正文",
          ),
          h(
            "button",
            { className: "gw-j-mini", type: "button", onClick: () => void loadReport("GET"), disabled: reportBusy },
            "刷新",
          ),
        ),
        report?.week
          ? h(
              "p",
              { className: "gw-j-sum" },
              `本周：${report.week} 起 · ${reportKind === "stat" ? "统计表" : "成文版"}（${reportSaved ? "已生成并保存到 reports/" : "实时预览，未落盘"}）`,
            )
          : null,
        reportErr ? h("div", { className: "gw-err" }, reportErr) : null,
        report === null
          ? h("div", { className: "gw-j-empty" }, reportBusy ? "正在生成本周回顾…" : "还没有本周回顾。点「生成并保存」写一份。")
          : h(MarkdownView, { source: current, className: "gw-j-doc" }),
      );

      return h(
        "div",
        { className: "gw-j" },
        h(
          "div",
          { className: "gw-j-head" },
          h("h3", { className: "gw-title" }, "成长手记"),
          h("span", { className: "gw-j-date" }, todayLabel()),
          h(
            "button",
            {
              className: "gw-j-mini",
              type: "button",
              // 刷新按当前 tab 分派：在「每周回顾」里点刷新却只重读日记，等于按钮没反应。
              onClick: () => void (tab === "week" ? loadReport("GET") : loadDiary()),
              disabled: tab === "week" ? reportBusy : loading,
            },
            (tab === "week" ? reportBusy : loading) ? "读取中…" : "刷新",
          ),
        ),
        h(
          "div",
          { className: "gw-j-tabs", role: "tablist" },
          h(
            "button",
            {
              className: "gw-j-tab",
              type: "button",
              role: "tab",
              "aria-selected": tab === "diary",
              onClick: () => setTab("diary"),
            },
            "日记",
          ),
          h(
            "button",
            {
              className: "gw-j-tab",
              type: "button",
              role: "tab",
              "aria-selected": tab === "week",
              onClick: () => setTab("week"),
            },
            "每周回顾",
          ),
        ),
        notice ? h("div", { className: "gw-ok" }, notice) : null,
        tab === "diary" ? diaryPanel : weekPanel,
        h(
          "div",
          { className: "gw-ok" },
          "气泡里只放得下摘要（桌宠气泡约 120 字封顶），完整的原文在这里。摘要不改原文，周报用的也是原文。",
        ),
      );
    }

    /** 旧名字保留：上一版这个 section 叫「今天」，外部若有引用不至于断。 */
    const TodaySection = JournalSection;

    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: "gongwei", order: 7, label: () => "想学的" },
              GongweiSection,
            ),
            "gongwei: settings section",
          ),
        "gongwei: settings section",
      );
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              // id 保持 `gongwei-today`：它是 slot 的键，改了会让已有入口失联。
              { name: "settings.section", id: "gongwei-today", order: 8, label: () => "成长手记" },
              JournalSection,
            ),
            "gongwei: journal section",
          ),
        "gongwei: journal section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.GongweiSection = GongweiSection;
    exports.JournalSection = JournalSection;
    exports.TodaySection = TodaySection;
    // 纯渲染件也导出来：它们不碰 ctx、不请求数据，自测里可以直接喂 props 验输出。
    exports.MarkdownView = MarkdownView;
    exports.DiaryCard = DiaryCard;
    exports.OriginalText = OriginalText;
    exports.parseMarkdown = parseMarkdown;
    exports.splitSentences = splitSentences;
    return module.exports;
  },
});
