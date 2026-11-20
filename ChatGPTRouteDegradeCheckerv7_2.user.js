// ==UserScript==
// @name         ChatGPT Route & Degrade Checker v7.2
// @name:zh-CN   ChatGPT 路由 + 运行时(Harmony/Codex) + DIL + 思考预算检测器 v7.2
// @namespace    local.chatgpt.route-checker
// @version      7.2.0
// @description  Detect Harmony vs Codex/cca harness routing, DIL/GenUI component tags, reasoning budget, Sentinel risk, and Regenerate runtime switches on ChatGPT Web.
// @description:zh-CN 识别 Harmony 与 Codex/cca 运行时分流、提取 DIL/GenUI 实际组件标签、监测思考预算、Sentinel 风控及 Regenerate 管线切换。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  "use strict";
  if (window.__CHATGPT_ROUTE_CHECKER_V7_2__) {
    console.log("ChatGPT Route Checker v7.2 已在运行");
    return;
  }
  window.__CHATGPT_ROUTE_CHECKER_V7_2__ = true;

  const nativeFetch = window.fetch.bind(window);
  const nativeBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  const NativeWebSocket = window.WebSocket;

  // ================== 安全深拷贝与深度合并 ==================
  function safeClone(val, maxDepth = 6, maxArr = 20, maxStr = 400, seen = new WeakSet()) {
    if (val === null || val === undefined) return val;
    const tp = typeof val;
    if (tp === "boolean" || tp === "number") return val;
    if (tp === "string") {
      return val.length > maxStr ? `${val.slice(0, maxStr)}…[+${val.length - maxStr} chars]` : val;
    }
    if (tp !== "object") return String(val);
    if (maxDepth <= 0) return Array.isArray(val) ? `[Array(${val.length})]` : "[Object]";
    if (seen.has(val)) return "[Circular]";
    seen.add(val);

    if (Array.isArray(val)) {
      const out = val.slice(0, maxArr).map(item => safeClone(item, maxDepth - 1, maxArr, maxStr, seen));
      if (val.length > maxArr) out.push(`…[+${val.length - maxArr} more items]`);
      seen.delete(val);
      return out;
    }

    const keys = Object.keys(val);
    const out = {};
    const limit = Math.min(keys.length, 45);
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      out[k] = safeClone(val[k], maxDepth - 1, maxArr, maxStr, seen);
    }
    if (keys.length > limit) out.__truncated_keys__ = keys.length - limit;
    seen.delete(val);
    return out;
  }

  function deepMergeObj(dst, src, depth = 0) {
    if (!src || typeof src !== "object" || Array.isArray(src)) return dst;
    if (!dst || typeof dst !== "object" || Array.isArray(dst)) return { ...src };
    const out = { ...dst };
    for (const [k, v] of Object.entries(src)) {
      if (depth < 4 && v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
        out[k] = deepMergeObj(out[k], v, depth + 1);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // ================== 载荷摘要 ==================
  function isPatchOpArray(val) {
    return Array.isArray(val) && val.length > 0 && val.every(x => x && typeof x === "object" && "p" in x && "o" in x);
  }

  function summarizeValue(val) {
    if (val === null) {
      return { present: true, type: "null", count: 0, nonEmpty: false, itemTypes: [], sample: null };
    }
    if (val === undefined) {
      return { present: true, type: "undefined", count: 0, nonEmpty: false, itemTypes: [], sample: null };
    }
    if (Array.isArray(val)) {
      const itemTypes = [];
      for (const item of val.slice(0, 15)) {
        if (item && typeof item === "object") {
          const tag = item.type || item.component_type || item.component || item.widget_type || item.name || item.kind || Object.keys(item).slice(0, 2).join("+");
          if (tag && !itemTypes.includes(String(tag))) itemTypes.push(String(tag));
        } else {
          const t = typeof item;
          if (!itemTypes.includes(t)) itemTypes.push(t);
        }
      }
      return {
        present: true,
        type: "array",
        count: val.length,
        nonEmpty: val.length > 0,
        itemTypes,
        sample: safeClone(val, 5, 12, 300)
      };
    }
    if (typeof val === "object") {
      const keys = Object.keys(val);
      return {
        present: true,
        type: "object",
        count: keys.length,
        nonEmpty: keys.length > 0,
        itemTypes: keys.slice(0, 12),
        sample: safeClone(val, 5, 12, 300)
      };
    }
    if (typeof val === "string") {
      return {
        present: true,
        type: "string",
        count: val.length,
        nonEmpty: val.trim().length > 0,
        itemTypes: [],
        sample: val.length > 300 ? `${val.slice(0, 300)}…[+${val.length - 300} chars]` : val
      };
    }
    return {
      present: true,
      type: typeof val,
      count: val ? 1 : 0,
      nonEmpty: Boolean(val),
      itemTypes: [],
      sample: val
    };
  }

  function shouldReplaceSummary(curr, next) {
    if (!curr) return true;
    if (next.nonEmpty && !curr.nonEmpty) return true;
    if (next.nonEmpty === curr.nonEmpty && next.count >= curr.count) return true;
    return false;
  }

  // ================== 状态模型 ==================
  function createEmptyTurn() {
    return {
      turnId: 0,
      recordedInHistory: false,
      active: false,
      streamEnded: false,
      finished: false,
      action: null, // next | variant | continue
      requestModel: null,
      thinkingEffort: null,
      serverModel: null,
      assistantModel: null,
      defaultModel: null,
      resolvedModel: null,
      requestedExperience: null,
      domModel: null,
      assistantMessageId: null,
      finishReason: null,
      // v7.2 核心运行时指纹
      harness: null,           // Harmony | Codex | ...
      runtimeSource: null,     // null | cca | ...
      chimeVersion: null,      // 1 | 3 | ...
      clusterRegion: null,     // japaneast | australiaeast | ...
      warmupState: null,       // warm | locked | new
      conduitPrewarmed: null,  // true | false
      steToolName: null,       // SonicBrowserTool | null
      // GenUI & model_dil_v2 实际内容摘要
      genuiPresent: null,
      genuiInfo: null,
      _genuiPatchItems: [],
      modelDilPresent: null,
      modelDilInfo: null,
      dilUpdateCount: 0,
      dilComponents: new Set(),
      _dilCodeBuf: "",
      // 完整原始元数据快照
      rawServerSteMetadata: null,
      rawTurnAnalytics: null,
      rawAssistantMeta: null,
      richUiSignals: new Set(),
      toolsUsed: new Set(),
      // 时间与思考预算
      turnStart: null,
      firstByteAt: null,
      reasoningStartAt: null,
      reasoningEndAt: null,
      firstAnswerAt: null,
      endAt: null,
      serverThoughtSec: null,
      thoughtChunks: 0,
      thoughtChars: 0,
      streamAnswerChars: 0,
      _deltaAnswerText: "",
      _fullAnswerText: "",
      answerChars: 0,
      paragraphs: 0,
      hasTable: false,
      hasCode: false,
      hasThinking: false,
      cfRay: null,
      httpStatus: null
    };
  }

  let turnSeq = 0;
  let finishTimer = null;

  const state = {
    turn: createEmptyTurn(),
    history: [],
    diff: null,
    routeStatus: null,
    softSignals: [],
    sentinel: {
      powHistory: [],
      powRisk: null,
      powRequired: null,
      persona: null,
      turnstile: null,
      arkose: null,
      forceLogin: null,
      cfRay: null,
      lastAt: null
    },
    env: {
      traceIp: null,
      traceLoc: null,
      traceColo: null,
      traceWarp: null,
      traceError: null,
      asnIp: null,
      asnOrg: null,
      asnRisk: null,
      asnError: null
    },
    account: {
      planType: null,
      modelCount: null,
      flagsHit: new Set()
    }
  };

  let dirty = false;
  function setTurnField(key, value) {
    if (value != null && state.turn[key] !== value) {
      state.turn[key] = value;
      dirty = true;
    }
  }

  function isCodexRuntime(t = state.turn) {
    const h = String(t.harness || "").toLowerCase();
    const rs = String(t.runtimeSource || "").toLowerCase();
    return h === "codex" || rs === "cca";
  }

  function isHarmonyRuntime(t = state.turn) {
    return String(t.harness || "").toLowerCase() === "harmony";
  }

  function extractDilTags(codeStr) {
    if (typeof codeStr !== "string" || !codeStr) return;
    const re = /__dil\.jsx\(\s*["']([a-zA-Z0-9_.:-]+)["']/g;
    let m;
    while ((m = re.exec(codeStr)) !== null) {
      if (!state.turn.dilComponents.has(m[1])) {
        state.turn.dilComponents.add(m[1]);
        dirty = true;
      }
    }
  }

  function recordGenui(val) {
    if (isPatchOpArray(val)) return; // 过滤误入的 JSON-patch 数组
    const t = state.turn;
    t.genuiPresent = true;
    const summary = summarizeValue(val);
    if (shouldReplaceSummary(t.genuiInfo, summary)) {
      t.genuiInfo = summary;
      dirty = true;
    }
    if (summary.nonEmpty) {
      t.richUiSignals.add(`genui(${summary.count})`);
      dirty = true;
    }
  }

  function recordModelDil(val) {
    if (isPatchOpArray(val)) return;
    const t = state.turn;
    t.modelDilPresent = true;
    t.dilUpdateCount += 1;
    if (val && typeof val === "object" && typeof val.code === "string") {
      extractDilTags(val.code);
    }
    const summary = summarizeValue(val);
    const currCodeLen = typeof t.modelDilInfo?.sample?.code === "string" ? t.modelDilInfo.sample.code.length : 0;
    const nextCodeLen = typeof val?.code === "string" ? val.code.length : 0;
    if (shouldReplaceSummary(t.modelDilInfo, summary) || nextCodeLen > currCodeLen) {
      t.modelDilInfo = summary;
      dirty = true;
    }
  }

  function recordServerSte(raw) {
    if (!raw || typeof raw !== "object") return;
    const cleaned = safeClone(raw, 6, 20, 400);
    state.turn.rawServerSteMetadata = deepMergeObj(state.turn.rawServerSteMetadata, cleaned);
    if (typeof raw.harness === "string" && raw.harness) setTurnField("harness", raw.harness);
    if (typeof raw.runtime_source === "string" && raw.runtime_source) setTurnField("runtimeSource", raw.runtime_source);
    if (typeof raw.cluster_region === "string" && raw.cluster_region) setTurnField("clusterRegion", raw.cluster_region);
    if (typeof raw.warmup_state === "string" && raw.warmup_state) setTurnField("warmupState", raw.warmup_state);
    if (typeof raw.conduit_prewarmed === "boolean") setTurnField("conduitPrewarmed", raw.conduit_prewarmed);
    if (typeof raw.tool_name === "string" && raw.tool_name) setTurnField("steToolName", raw.tool_name);
    dirty = true;
  }

  function recordTurnAnalytics(raw) {
    if (!raw || typeof raw !== "object") return;
    const cleaned = safeClone(raw, 6, 20, 400);
    state.turn.rawTurnAnalytics = deepMergeObj(state.turn.rawTurnAnalytics, cleaned);
    dirty = true;
  }

  function recordAssistantMeta(raw) {
    if (!raw || typeof raw !== "object") return;
    if (typeof raw.chime_version === "number") setTurnField("chimeVersion", raw.chime_version);
    const cleaned = safeClone(raw, 5, 15, 300);
    state.turn.rawAssistantMeta = deepMergeObj(state.turn.rawAssistantMeta, cleaned);
    dirty = true;
  }

  // ================== UI 基础（拖动 / 收起 / 自动收起） ==================
  const STORAGE_KEY = "crc-v7-ui";
  const ui = (() => {
    try {
      const o = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return o && typeof o === "object" ? o : {};
    } catch {
      return {};
    }
  })();
  function saveUI(p) {
    try {
      Object.assign(ui, p);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
    } catch {}
  }

  const AC_MIN = 1, AC_MAX = 600, AC_DEF = 15;
  function acSecs() {
    const v = Number(ui.autoCollapseSeconds);
    return Number.isFinite(v) ? Math.min(AC_MAX, Math.max(AC_MIN, Math.floor(v))) : AC_DEF;
  }

  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483647",
    transform: "scale(0.72)",
    transformOrigin: "0 0"
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    width: "510px",
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "calc(125vh - 32px)",
    overflowY: "auto",
    padding: "14px 16px",
    border: "1px solid #444",
    borderRadius: "12px",
    background: "#111",
    color: "#eee",
    font: "12.5px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    boxShadow: "0 8px 30px rgba(0,0,0,.45)"
  });

  const tab = document.createElement("div");
  tab.id = "crc-tab";
  Object.assign(tab.style, {
    display: "none",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    width: "26px",
    padding: "10px 4px",
    border: "1px solid #444",
    borderRadius: "10px",
    background: "#111",
    color: "#eee",
    font: "600 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    boxShadow: "0 8px 30px rgba(0,0,0,.45)",
    cursor: "pointer",
    userSelect: "none",
    touchAction: "none"
  });
  tab.innerHTML = `<span id="crc-tab-dot" style="display:block;width:14px;height:14px;border-radius:50%;background:#888;flex:none;"></span><span style="writing-mode:vertical-rl;letter-spacing:1px;">Checker v7.2</span>`;
  tab.title = "展开 ChatGPT Route & Degrade Checker v7.2";

  wrapper.appendChild(panel);
  wrapper.appendChild(tab);

  let collapsed = !!ui.collapsed;
  panel.style.display = collapsed ? "none" : "block";
  tab.style.display = collapsed ? "flex" : "none";

  let currentPos = { left: 0, top: 0 };
  let expandedPos = (typeof ui.expandedLeft === "number" && typeof ui.expandedTop === "number")
    ? { left: ui.expandedLeft, top: ui.expandedTop }
    : null;

  function updateTabCorner() {
    if (!collapsed) return;
    const r = wrapper.getBoundingClientRect();
    const atL = r.left <= 2, atR = r.left + r.width >= window.innerWidth - 2;
    tab.style.borderRadius = atL ? "0 10px 10px 0" : atR ? "10px 0 0 10px" : "10px";
  }

  function applyPos(l, t) {
    const r = wrapper.getBoundingClientRect();
    const ml = Math.max(0, window.innerWidth - r.width);
    const mt = Math.max(0, window.innerHeight - r.height);
    const l2 = Math.round(Math.min(Math.max(l, 0), ml));
    const t2 = Math.round(Math.min(Math.max(t, 0), mt));
    wrapper.style.left = l2 + "px";
    wrapper.style.top = t2 + "px";
    wrapper.style.right = "auto";
    wrapper.style.bottom = "auto";
    currentPos = { left: l2, top: t2 };
    updateTabCorner();
  }

  let mounted = false;
  function mountPanel() {
    if (mounted || !document.documentElement) return;
    mounted = true;
    document.documentElement.appendChild(wrapper);
    requestAnimationFrame(() => {
      const r = wrapper.getBoundingClientRect();
      let l = typeof ui.left === "number" ? ui.left : window.innerWidth - r.width - 16;
      let t = typeof ui.top === "number" ? ui.top : window.innerHeight - r.height - 16;
      const cx = l + r.width / 2;
      l = collapsed
        ? (cx < window.innerWidth / 2 ? 0 : window.innerWidth - r.width)
        : (cx < window.innerWidth / 2 ? 16 : window.innerWidth - r.width - 16);
      applyPos(l, t);
      saveUI({ left: l, top: t });
    });
  }

  let acTimer = null;
  function stopAC() { if (acTimer) { clearTimeout(acTimer); acTimer = null; } }
  function startAC() {
    stopAC();
    if (!ui.autoCollapse || collapsed) return;
    acTimer = setTimeout(() => { acTimer = null; collapse(); }, acSecs() * 1000);
  }

  function collapse() {
    if (collapsed) return;
    stopAC();
    const r = wrapper.getBoundingClientRect();
    const side = r.left + r.width / 2 < window.innerWidth / 2 ? "left" : "right";
    const at = r.top + r.height / 2;
    expandedPos = { left: r.left, top: r.top };
    collapsed = true;
    panel.style.display = "none";
    tab.style.display = "flex";
    requestAnimationFrame(() => {
      const tr = wrapper.getBoundingClientRect();
      applyPos(side === "left" ? 0 : window.innerWidth - tr.width, at - tr.height / 2);
      saveUI({ collapsed: true, left: currentPos.left, top: currentPos.top, expandedLeft: expandedPos.left, expandedTop: expandedPos.top });
    });
  }

  function expand() {
    if (!collapsed) return;
    const anchor = { ...currentPos }, tabR = wrapper.getBoundingClientRect();
    collapsed = false;
    panel.style.display = "block";
    tab.style.display = "none";
    requestAnimationFrame(() => {
      const pr = wrapper.getBoundingClientRect();
      let target;
      if (expandedPos) target = expandedPos;
      else {
        const onL = anchor.left + tabR.width / 2 < window.innerWidth / 2;
        target = { left: onL ? 0 : window.innerWidth - pr.width, top: anchor.top + tabR.height / 2 - pr.height / 2 };
      }
      applyPos(target.left, target.top);
      saveUI({ collapsed: false, left: currentPos.left, top: currentPos.top });
      startAC();
    });
  }

  let dragState = null, justDragged = false;
  wrapper.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const h = e.target.closest("#crc-header, #crc-tab");
    if (!h || e.target.closest("[data-no-drag]")) return;
    const r = wrapper.getBoundingClientRect();
    dragState = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    try { h.setPointerCapture(e.pointerId); } catch {}
  });
  wrapper.addEventListener("pointermove", e => {
    if (!dragState || e.pointerId !== dragState.id) return;
    const nx = e.clientX - dragState.dx, ny = e.clientY - dragState.dy;
    if (Math.abs(nx - currentPos.left) > 2 || Math.abs(ny - currentPos.top) > 2) dragState.moved = true;
    applyPos(nx, ny);
  });
  function upHandler(e) {
    if (!dragState || e.pointerId !== dragState.id) return;
    const m = dragState.moved;
    dragState = null;
    if (!m) return;
    justDragged = true;
    setTimeout(() => (justDragged = false), 0);
    if (collapsed) expandedPos = null;
    saveUI({
      collapsed,
      left: currentPos.left,
      top: currentPos.top,
      expandedLeft: expandedPos ? expandedPos.left : undefined,
      expandedTop: expandedPos ? expandedPos.top : undefined
    });
  }
  wrapper.addEventListener("pointerup", upHandler);
  wrapper.addEventListener("pointercancel", upHandler);

  wrapper.addEventListener("click", e => {
    if (justDragged) return;
    if (e.target.closest("#crc-collapse")) collapse();
    else if (e.target.closest("#crc-tab")) expand();
    else if (e.target.closest("#crc-ac-toggle")) toggleAC();
    else if (e.target.closest("#crc-copy-probes")) copyText(PROBES, "#crc-copy-probes");
    else if (e.target.closest("#crc-copy-diag")) copyText(buildDiagnosticJson(), "#crc-copy-diag");
    else if (e.target.closest("#crc-refresh-env")) refreshEnv(true);
  });

  function toggleAC() {
    ui.autoCollapse = !ui.autoCollapse;
    saveUI({ autoCollapse: ui.autoCollapse });
    if (ui.autoCollapse) startAC();
    else stopAC();
    updateACUI();
  }

  function updateACUI() {
    const b = panel.querySelector("#crc-ac-box");
    if (b) {
      if (ui.autoCollapse) {
        b.style.background = "#4caf50"; b.style.borderColor = "#4caf50"; b.style.color = "#111";
      } else {
        b.style.background = "#1b1b1b"; b.style.borderColor = "#666"; b.style.color = "transparent";
      }
    }
    const s = panel.querySelector("#crc-ac-sec-row");
    if (s) s.style.opacity = ui.autoCollapse ? "1" : "0.55";
  }

  panel.addEventListener("keydown", e => {
    if (e.target && e.target.id === "crc-ac-seconds") {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    }
  }, true);
  panel.addEventListener("input", e => {
    if (!e.target || e.target.id !== "crc-ac-seconds") return;
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) return;
    const s = Math.min(AC_MAX, Math.max(AC_MIN, v));
    ui.autoCollapseSeconds = s; saveUI({ autoCollapseSeconds: s }); startAC();
  });
  panel.addEventListener("change", e => {
    if (!e.target || e.target.id !== "crc-ac-seconds") return;
    const v = parseInt(e.target.value, 10);
    const s = Number.isFinite(v) ? Math.min(AC_MAX, Math.max(AC_MIN, v)) : AC_DEF;
    ui.autoCollapseSeconds = s; saveUI({ autoCollapseSeconds: s }); e.target.value = String(s); startAC();
  });
  document.addEventListener("pointerdown", e => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!ui.autoCollapse || collapsed || wrapper.contains(e.target)) return;
    collapse();
  }, true);
  window.addEventListener("resize", () => {
    if (!mounted) return;
    const r = wrapper.getBoundingClientRect();
    const cx = currentPos.left + r.width / 2;
    const nl = collapsed
      ? (cx < window.innerWidth / 2 ? 0 : window.innerWidth - r.width)
      : (cx < window.innerWidth / 2 ? 16 : window.innerWidth - r.width - 16);
    applyPos(nl, currentPos.top);
    saveUI({ left: currentPos.left, top: currentPos.top });
  });

  // ================== 工具函数 ==================
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const disp = v => v ? esc(v) : state.turn.finished ? "未返回" : state.turn.active ? "监听中…" : "—";
  const fmtSec = ms => ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`;

  function parseModelFamily(slug) {
    const s = String(slug || "").toLowerCase().trim();
    if (!s || s === "auto") return null;
    const mini = /(?:^|[-_])(mini|nano|lite|micro|small)(?:$|[-_])/.test(s);
    let m;
    if ((m = s.match(/^(gpt-\d+(?:[.-]\d+|o)?)/))) {
      return { base: m[1].replace(/\./g, "-"), mini };
    }
    if ((m = s.match(/^(o\d+)/))) {
      return { base: m[1], mini };
    }
    return { base: s.split("-")[0], mini };
  }

  function sameModelTier(req, actual) {
    if (!req || !actual) return null;
    if (req.toLowerCase() === actual.toLowerCase()) return true;
    const rf = parseModelFamily(req), af = parseModelFamily(actual);
    if (!rf || !af) return false;
    return rf.base === af.base && rf.mini === af.mini;
  }

  function isThinkingRequest(t) {
    const r = String(t.requestModel || "").toLowerCase();
    const e = String(t.thinkingEffort || "").toLowerCase();
    return r.includes("thinking") || r.includes("reason") || /^o\d/.test(r) || (e && e !== "none" && e !== "minimal");
  }

  function getThinkingMs(t) {
    if (typeof t.serverThoughtSec === "number" && t.serverThoughtSec >= 0) {
      return Math.round(t.serverThoughtSec * 1000);
    }
    if (t.reasoningStartAt && t.reasoningEndAt && t.reasoningEndAt >= t.reasoningStartAt) {
      return t.reasoningEndAt - t.reasoningStartAt;
    }
    if (t.reasoningStartAt && t.firstAnswerAt && t.firstAnswerAt >= t.reasoningStartAt) {
      return t.firstAnswerAt - t.reasoningStartAt;
    }
    return null;
  }

  // ================== 路由与软降级综合判定 ==================
  function evaluateRoute() {
    const t = state.turn;
    const req = t.requestModel;
    if (!req) return null;

    const vals = [t.resolvedModel, t.serverModel, t.assistantModel, t.domModel].filter(Boolean);
    if (vals.some(v => String(v).toLowerCase().includes("auto-thinking"))) {
      return { level: "auto", label: "自动推理路由", color: "#8bc34a", detail: "响应含 auto-thinking，豁免硬降级判定" };
    }
    if (!vals.length) {
      if (t.finished) {
        return { level: "suspicious", label: "路由字段全缺", color: "#f0ad4e", detail: "流与尾包结束后仍未捕获任何模型字段" };
      }
      return null;
    }

    const actual = t.resolvedModel || t.serverModel || t.assistantModel || t.domModel;
    const matched = sameModelTier(req, actual);
    const codex = isCodexRuntime(t);
    const attributionBroken = t.finished && !t.resolvedModel;

    if (matched) {
      if (codex) {
        return {
          level: "codex",
          label: "Codex/cca 运行时（模型一致）",
          color: "#ba68c8",
          detail: `请求 ${req} → ${actual}；该运行时默认不下发 resolved_model_slug 与 model_dil_v2`
        };
      }
      if (attributionBroken) {
        return {
          level: "attribution",
          label: "归因链不完整",
          color: "#f0ad4e",
          detail: `非 Codex 管线 (${t.harness || "未知"})，同家族 (${actual}) 但缺 resolved_model_slug`
        };
      }
      return {
        level: "ok",
        label: isHarmonyRuntime(t) ? "Harmony 主线一致" : "路由一致",
        color: "#4caf50",
        detail: `请求 ${req} → 实际 ${actual}`
      };
    }
    return { level: "downgraded", label: "路由硬降级", color: "#f44336", detail: `请求 ${req} → 实际 ${actual}（家族或档位不符）` };
  }

  function evaluateSoftSignals() {
    const t = state.turn;
    const signals = [];
    if (!t.active) return signals;

    const thinkMs = getThinkingMs(t);
    const codex = isCodexRuntime(t);

    if (t.finished && isThinkingRequest(t)) {
      if (!t.hasThinking && t.thoughtChars === 0 && (thinkMs == null || thinkMs < 500)) {
        signals.push({ level: "high", text: "请求了思考模式，但本轮未观测到思考链路" });
      } else if (thinkMs != null && thinkMs < 2000 && t.answerChars > 0 && t.answerChars < 350) {
        signals.push({ level: "warn", text: `思考极短 (${fmtSec(thinkMs)}) 且回复偏短 (${t.answerChars} 字)` });
      }
    }

    if (t.finished && t.finishReason && t.finishReason !== "stop") {
      signals.push({ level: "warn", text: `非正常结束: finish_details=${t.finishReason}` });
    }

    // 仅在非 Codex/cca 管线下缺失 DIL/GenUI 才告警；Codex 管线已在顶部单独标注
    if (t.finished && !codex && t.genuiPresent === false && t.modelDilPresent === false) {
      signals.push({ level: "warn", text: "非 Codex 管线下仍缺失 model_dil_v2 与 genui_components" });
    }

    if (state.diff?.harnessSwitch) {
      signals.push({ level: "info", text: `运行时切换：${state.diff.harnessSwitch}` });
    }
    if (state.diff?.regenRecovery) {
      signals.push({ level: "high", text: state.diff.regenRecovery });
    }

    const p = String(state.sentinel.persona || "").toLowerCase();
    if (p && (p.includes("free") || p.includes("noauth") || p.includes("anon") || p.includes("degrad"))) {
      signals.push({ level: "high", text: `Sentinel persona 异常: ${state.sentinel.persona}` });
    }
    if (state.sentinel.arkose === true) {
      signals.push({ level: "high", text: "触发 Arkose 人机校验" });
    }
    if (state.sentinel.forceLogin === true) {
      signals.push({ level: "high", text: "触发 ForceLogin 强制重登标记" });
    }
    return signals;
  }

  // ================== PoW / Sentinel / 同源 Trace / ASN ==================
  function powRiskEval(d) {
    if (!Number.isFinite(d)) return null;
    if (d >= 5) return { level: "normal", label: "正常", color: "#4caf50", digits: d };
    if (d === 4) return { level: "low", label: "中风险", color: "#f0ad4e", digits: d };
    return { level: "high", label: "高风险", color: "#f44336", digits: d };
  }

  function recordPow(hex) {
    if (typeof hex !== "string" || !hex) return;
    const stripped = hex.replace(/^0+/, "");
    const digits = stripped.length;
    const leadingZeros = hex.length - digits;
    state.sentinel.powHistory.push({ difficulty: hex, digits, leadingZeros, t: Date.now() });
    if (state.sentinel.powHistory.length > 12) state.sentinel.powHistory.shift();
    const sorted = state.sentinel.powHistory.map(x => x.digits).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    state.sentinel.powRisk = powRiskEval(med);
  }

  const HOSTING_KW = [
    "amazon", "aws", "google cloud", "microsoft", "azure", "digitalocean", "linode", "akamai",
    "vultr", "hetzner", "ovh", "oracle", "alibaba", "tencent", "cloud", "m247", "contabo",
    "hostinger", "leaseweb", "fastly", "cloudflare", "fly.io", "scaleway", "equinix",
    "datacamp", "cdn77", "choopa", "psychz", "zenlayer", "dmit", "bandwagon", "vpn",
    "nordvpn", "expressvpn", "surfshark", "mullvad", "proton"
  ];
  function evalAsnRisk(org) {
    const t = String(org || "").toLowerCase();
    if (!t) return { level: "unknown", label: "未知", color: "#888" };
    for (const kw of HOSTING_KW) {
      if (t.includes(kw)) return { level: "high", label: "数据中心/云/VPN", color: "#f44336" };
    }
    return { level: "normal", label: "住宅/常规 ISP", color: "#4caf50" };
  }

  async function queryCloudflareTrace() {
    try {
      const r = await nativeFetch(`${location.origin}/cdn-cgi/trace`, { credentials: "omit", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const txt = await r.text();
      const map = {};
      for (const line of txt.split(/\r?\n/)) {
        const idx = line.indexOf("=");
        if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (map.ip) {
        state.env.traceIp = map.ip;
        state.env.traceLoc = map.loc || null;
        state.env.traceColo = map.colo || null;
        state.env.traceWarp = map.warp || null;
        state.env.traceError = null;
        render();
        return map.ip;
      }
      state.env.traceError = "trace 无 IP";
    } catch {
      state.env.traceError = "trace 失败";
    }
    render();
    return null;
  }

  async function queryASN(targetIp) {
    const ipPath = targetIp ? encodeURIComponent(targetIp) : "";
    const srcs = [
      {
        url: ipPath ? `https://ipwho.is/${ipPath}` : "https://ipwho.is/",
        parse: d => ({ ip: d.ip, org: d.connection?.isp || d.connection?.org || d.org })
      },
      {
        url: ipPath ? `https://ipapi.co/${ipPath}/json/` : "https://ipapi.co/json/",
        parse: d => ({ ip: d.ip, org: d.org })
      },
      {
        url: ipPath ? `https://ipinfo.io/${ipPath}/json` : "https://ipinfo.io/json",
        parse: d => ({ ip: d.ip, org: d.org })
      }
    ];
    for (const s of srcs) {
      try {
        const r = await nativeFetch(s.url, { mode: "cors" });
        if (!r.ok) continue;
        const raw = await r.json();
        const { ip, org } = s.parse(raw);
        if (ip && org) {
          state.env.asnIp = ip;
          state.env.asnOrg = org;
          state.env.asnRisk = evalAsnRisk(org);
          state.env.asnError = null;
          render();
          return;
        }
      } catch {}
    }
    state.env.asnError = "被页面 CSP 或网络拦截";
    state.env.asnRisk = { level: "unknown", label: "待人工核验", color: "#888" };
    render();
  }

  let envStarted = false;
  async function refreshEnv(force) {
    if (envStarted && !force) return;
    envStarted = true;
    const ip = await queryCloudflareTrace();
    await queryASN(ip);
  }

  // ================== 综合状态与颜色 ==================
  const RANK = { unknown: 0, normal: 1, low: 2, high: 3 };
  function envRank() {
    const s = state.sentinel;
    const sentinelFlag = (s.arkose === true || s.forceLogin === true) ? 3 : 0;
    return Math.max(RANK[s.powRisk?.level] ?? 0, RANK[state.env.asnRisk?.level] ?? 0, sentinelFlag);
  }

  function overall() {
    const rs = state.routeStatus;
    const highSoft = state.softSignals.filter(x => x.level === "high");
    const warnSoft = state.softSignals.filter(x => x.level === "warn");

    if (rs?.level === "downgraded") return "🔴 路由硬降级：请求与实际执行模型档位不符";
    if (highSoft.length) return `🟠 强软降级/风控信号：${highSoft[0].text}`;
    if (rs?.level === "codex") return "🟣 Codex/cca 运行时分流：模型一致，无 DIL/Intelligent UI";
    if (rs?.level === "suspicious") return "🟡 路由字段全缺：待结合导出 JSON 与对照账号核查";
    if (rs?.level === "attribution") return "🟡 归因链不完整：非 Codex 管线但缺 resolved_model_slug";
    if (warnSoft.length) return `🟡 软降级旁证：${warnSoft[0].text}`;
    if (!state.turn.active) {
      return envRank() >= 3 ? "⚫️ 等待发消息 · 🟡 环境/风控风险高" : "⚫️ 等待发送一条新消息";
    }
    if (!state.turn.finished) return "🔵 本轮生成中，等待流结束统计…";
    if (envRank() >= 3) return "🟡 路由一致，但环境/风控风险高";
    return "🟢 Harmony 主线、思考链与环境均正常";
  }

  function statusColor() {
    if (state.routeStatus?.level === "downgraded") return "#f44336";
    if (state.softSignals.some(x => x.level === "high")) return "#ff7043";
    if (state.routeStatus?.level === "codex") return "#ba68c8";
    if (state.routeStatus?.level === "attribution" || state.routeStatus?.level === "suspicious") return "#f0ad4e";
    if (state.softSignals.some(x => x.level === "warn")) return "#f0ad4e";
    const e = envRank();
    if (e >= 3) return "#f44336";
    if (e >= 2) return "#f0ad4e";
    if (!state.turn.active) return "#888";
    if (!state.turn.finished) return "#42a5f5";
    return "#4caf50";
  }

  function updateDot() {
    const d = tab.querySelector("#crc-tab-dot");
    if (d) d.style.background = statusColor();
    tab.title = overall();
  }

  // ================== DOM 与正文流结构统计 ==================
  function findLatestAssistantEl() {
    const id = state.turn.assistantMessageId;
    if (id && typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      const exact = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      if (exact) return exact;
    }
    const roleEls = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (roleEls.length) return roleEls[roleEls.length - 1];
    const turnEls = document.querySelectorAll('article[data-testid^="conversation-turn-"]');
    return turnEls.length ? turnEls[turnEls.length - 1] : null;
  }

  function refreshDom() {
    const el = findLatestAssistantEl();
    if (!el) return;
    const slug = el.getAttribute("data-message-model-slug") || el.querySelector("[data-message-model-slug]")?.getAttribute("data-message-model-slug");
    if (slug) state.turn.domModel = slug;
  }

  function analyzeTextStructure(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return { chars: 0, paragraphs: 0, hasTable: false, hasCode: false };
    const paragraphs = trimmed.split(/\n\s*\n/).filter(p => p.trim()).length;
    const hasTable = /(?:^|\n)\s*\|.+\|\s*\n\s*\|[\s:-]+\|/.test(trimmed);
    const hasCode = /```/.test(trimmed);
    return { chars: trimmed.length, paragraphs, hasTable, hasCode };
  }

  function extractMetrics() {
    const t = state.turn;
    const el = findLatestAssistantEl();
    if (el) {
      const slug = el.getAttribute("data-message-model-slug") || el.querySelector("[data-message-model-slug]")?.getAttribute("data-message-model-slug");
      if (slug) t.domModel = slug;

      const md = el.querySelector(".markdown, .prose") || el;
      const text = (md.innerText || md.textContent || "").trim();
      if (text.length > 0) {
        t.answerChars = Math.max(t.answerChars, text.length);
        t.paragraphs = Math.max(t.paragraphs, text.split(/\n\s*\n/).filter(p => p.trim()).length);
      }
      if (md.querySelector("table")) t.hasTable = true;
      if (md.querySelector("pre, code")) t.hasCode = true;
      if (el.querySelector('[data-testid*="reasoning"], [data-testid*="thought"]')) {
        t.hasThinking = true;
      }
    }

    const bestStreamText = t._fullAnswerText.length >= t._deltaAnswerText.length ? t._fullAnswerText : t._deltaAnswerText;
    if (bestStreamText) {
      const m = analyzeTextStructure(bestStreamText);
      if (t.answerChars === 0) t.answerChars = m.chars;
      if (t.paragraphs === 0) t.paragraphs = m.paragraphs;
      if (m.hasTable) t.hasTable = true;
      if (m.hasCode) t.hasCode = true;
    }
  }

  // ================== 轮次对比（含 Harmony/Codex 管线切换检测） ==================
  function snapshotTurn(t) {
    return {
      turnId: t.turnId,
      action: t.action,
      harness: t.harness,
      runtimeSource: t.runtimeSource,
      chimeVersion: t.chimeVersion,
      clusterRegion: t.clusterRegion,
      warmupState: t.warmupState,
      conduitPrewarmed: t.conduitPrewarmed,
      steToolName: t.steToolName,
      requestModel: t.requestModel,
      thinkingEffort: t.thinkingEffort,
      resolvedModel: t.resolvedModel,
      serverModel: t.serverModel,
      assistantModel: t.assistantModel,
      defaultModel: t.defaultModel,
      domModel: t.domModel,
      requestedExperience: t.requestedExperience,
      finishReason: t.finishReason,
      genuiPresent: t.genuiPresent,
      genuiInfo: t.genuiInfo,
      modelDilPresent: t.modelDilPresent,
      dilUpdateCount: t.dilUpdateCount,
      dilComponents: [...t.dilComponents],
      modelDilInfo: t.modelDilInfo,
      toolsUsed: [...t.toolsUsed],
      richUiSignals: [...t.richUiSignals],
      thinkingMs: getThinkingMs(t),
      firstTokenMs: t.firstByteAt && t.turnStart ? t.firstByteAt - t.turnStart : null,
      totalMs: t.endAt && t.turnStart ? t.endAt - t.turnStart : null,
      thoughtChars: t.thoughtChars,
      answerChars: t.answerChars || t.streamAnswerChars,
      paragraphs: t.paragraphs,
      hasThinking: t.hasThinking,
      hasTable: t.hasTable,
      hasCode: t.hasCode,
      rawServerSteMetadata: t.rawServerSteMetadata,
      rawTurnAnalytics: t.rawTurnAnalytics,
      rawAssistantMeta: t.rawAssistantMeta
    };
  }

  function compactHistorySnap(s) {
    const { rawServerSteMetadata, rawTurnAnalytics, rawAssistantMeta, genuiInfo, modelDilInfo, ...rest } = s;
    return {
      ...rest,
      genuiCount: genuiInfo?.count ?? null,
      genuiNonEmpty: genuiInfo?.nonEmpty ?? null
    };
  }

  function computeDiff(prev, curr) {
    if (!prev || !curr) return null;
    const isRegen = curr.action === "variant";
    const dChars = (curr.answerChars || 0) - (prev.answerChars || 0);
    const dThink = (curr.thinkingMs != null && prev.thinkingMs != null)
      ? curr.thinkingMs - prev.thinkingMs
      : null;
    const addedTools = curr.toolsUsed.filter(x => !prev.toolsUsed.includes(x));
    const prevRt = prev.harness ? `${prev.harness}${prev.runtimeSource ? `/${prev.runtimeSource}` : ""}` : null;
    const currRt = curr.harness ? `${curr.harness}${curr.runtimeSource ? `/${curr.runtimeSource}` : ""}` : null;
    const harnessSwitch = prevRt && currRt && prevRt !== currRt ? `${prevRt} → ${currRt}` : null;

    let regenRecovery = null;
    if (isRegen) {
      const charsSurge = prev.answerChars > 0 && curr.answerChars >= prev.answerChars * 1.6 && dChars >= 300;
      const thinkSurge = dThink != null && dThink >= 3000 && prev.thinkingMs > 0 && curr.thinkingMs >= prev.thinkingMs * 1.8;
      const attrRecovered = !prev.resolvedModel && !!curr.resolvedModel;
      if (charsSurge || thinkSurge || attrRecovered || harnessSwitch) {
        const reasons = [];
        if (harnessSwitch) reasons.push(`运行时 ${harnessSwitch}`);
        if (attrRecovered) reasons.push("归因链恢复");
        if (charsSurge) reasons.push(`字数 ${dChars >= 0 ? "+" : ""}${dChars}`);
        if (thinkSurge) reasons.push(`思考 ${dThink >= 0 ? "+" : ""}${fmtSec(dThink)}`);
        regenRecovery = `Regenerate 变化 (${reasons.join(" · ")})`;
      }
    }
    return { isRegen, dChars, dThink, addedTools, harnessSwitch, regenRecovery };
  }

  // ================== 探针与诊断导出 ==================
  const PROBES = `【探针 1｜工具链与富媒体能力】
List all tools currently available to you in a compact Markdown table (name, purpose, enabled). Do not invent unavailable tools.
观察：对比两个账号的工具表数量及是否缺失 web/python/UI 类工具。

【探针 2｜多约束深度推理（防题库背诵）】
袋中有红/蓝/绿三种颜色、方/圆两种形状的球。圆形数量为 红7/蓝9/绿8，方形数量为 红7/蓝6/绿4。最少取出多少个球，才能保证同时拥有不同形状的红球和蓝球？请严格用最坏情况构造法证明。
预期：21。若秒答 29 或跳步无构造证明，说明思考预算被压低。

【探针 3｜抗模板化长输出（检验是否被锁三段式）】
请用不少于 600 字，分 5 个递进维度剖析“缓存一致性协议 MESI 与目录协议在多核扩展时的瓶颈差异”，必须包含一个 Markdown 对比表格和一段 ASCII 状态转移示意图，禁止使用“一句话定义+一个例子”的简写格式。
观察：是否仍被强行压回极简三段式、是否拒绝画图/建表。

【探针 4｜双 Bug 隐蔽代码审查】
找出以下伪代码中的全部逻辑缺陷（不止一个）：
\`\`\`python
def rate_limit(timestamps, now, window=60, limit=5):
    for ts in timestamps:
        if now - ts > window:
            timestamps.remove(ts)
    if len(timestamps) < limit:
        timestamps.append(now)
        return True
    return False
\`\`\`
预期同时指出：① 遍历列表时原地 remove 导致跳过相邻元素；② 边界条件 > window 与 >= window 语义及非单调时钟/并发竞态风险。弱模型常只答出第 1 点。`;

  function buildDiagnosticJson() {
    const snap = snapshotTurn(state.turn);
    return JSON.stringify({
      checkerVersion: "7.2.0",
      capturedAt: new Date().toISOString(),
      overall: overall(),
      routeStatus: state.routeStatus,
      softSignals: state.softSignals,
      currentTurn: snap,
      prevTurnDiff: state.diff,
      sentinel: {
        powRisk: state.sentinel.powRisk,
        powRecent: state.sentinel.powHistory.slice(-5),
        powRequired: state.sentinel.powRequired,
        persona: state.sentinel.persona,
        turnstile: state.sentinel.turnstile,
        arkose: state.sentinel.arkose,
        forceLogin: state.sentinel.forceLogin,
        cfRay: state.sentinel.cfRay || state.turn.cfRay
      },
      env: state.env,
      account: {
        planType: state.account.planType,
        modelCount: state.account.modelCount,
        flagsHit: [...state.account.flagsHit]
      },
      recentHistory: state.history.slice(-5).map(compactHistorySnap)
    }, null, 2);
  }

  async function copyText(text, btnSelector) {
    let ok = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {}
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        ok = true;
      } catch {}
    }
    const b = panel.querySelector(btnSelector);
    if (b) {
      const orig = b.textContent;
      b.textContent = ok ? "已复制 ✓" : "复制失败";
      setTimeout(() => { b.textContent = orig; }, 1800);
    }
  }

  // ================== 面板渲染 ==================
  const INPUT_STYLE = [
    "width:50px", "padding:2px 6px", "border:1px solid #444 !important", "border-radius:4px",
    "background:#1b1b1b !important", "color:#eee !important",
    "font:12px/1.4 ui-monospace,Menlo,Consolas,monospace !important",
    "text-align:center", "box-sizing:border-box", "outline:none", "height:auto", "min-height:0"
  ].join(";");

  function runtimeBannerHtml() {
    const t = state.turn;
    if (!t.active) {
      return `<div style="margin-bottom:7px;padding:6px 8px;border:1px solid #2e2e2e;border-radius:6px;background:#181818;color:#888;font-size:11.5px">运行时：等待首包 STE 元数据（Harmony vs Codex/cca）</div>`;
    }
    const codex = isCodexRuntime(t);
    const harmony = isHarmonyRuntime(t);
    const border = codex ? "#6a3b7a" : harmony ? "#2e5c36" : "#444";
    const bg = codex ? "#201426" : harmony ? "#122116" : "#1a1a1a";
    const titleColor = codex ? "#ce93d8" : harmony ? "#81c784" : "#ddd";
    const title = codex
      ? `Codex${t.runtimeSource ? ` / ${t.runtimeSource}` : ""}（Agent 精简管线 · 无 DIL/UI）`
      : harmony
        ? `Harmony（主线管线 · 支持 DIL/GenUI）`
        : t.harness
          ? `${t.harness}${t.runtimeSource ? ` / ${t.runtimeSource}` : ""}`
          : "等待 server_ste_metadata…";

    const metaBits = [
      t.chimeVersion != null ? `chime v${t.chimeVersion}` : null,
      t.clusterRegion ? `cluster: ${t.clusterRegion}` : null,
      t.warmupState ? `warmup: ${t.warmupState}` : null,
      t.steToolName ? `tool: ${t.steToolName}` : null
    ].filter(Boolean).join(" · ");

    return `
      <div style="margin-bottom:7px;padding:6px 8px;border:1px solid ${border};border-radius:6px;background:${bg}">
        <div style="color:${titleColor};font-weight:700;font-size:12px">运行时：${esc(title)}</div>
        ${metaBits ? `<div style="color:#aaa;font-size:11px;margin-top:1px">${esc(metaBits)}</div>` : ""}
      </div>
    `;
  }

  function formatPayloadBadge(present, info) {
    if (present === null) return `<span style="color:#888">—</span>`;
    if (present === false) return `<span style="color:#888">未出现</span>`;
    if (!info) return `<span style="color:#aaa">存在</span>`;
    if (info.type === "array") {
      if (info.count === 0) return `<span style="color:#aaa">空数组 (0)</span>`;
      const types = info.itemTypes?.length ? `: ${esc(info.itemTypes.slice(0, 3).join(","))}` : "";
      return `<span style="color:#4caf50">数组 (${info.count}项${types})</span>`;
    }
    if (info.type === "object") {
      if (info.count === 0) return `<span style="color:#aaa">空对象 (0)</span>`;
      const keys = info.itemTypes?.length ? `: ${esc(info.itemTypes.slice(0, 3).join(","))}` : "";
      return `<span style="color:#4caf50">对象 (${info.count}键${keys})</span>`;
    }
    if (info.type === "boolean") {
      return `<span style="color:${info.sample ? "#4caf50" : "#aaa"}">${info.sample ? "true" : "false"}</span>`;
    }
    if (info.type === "null") return `<span style="color:#aaa">null</span>`;
    return `<span style="color:#4caf50">${esc(String(info.sample ?? info.type).slice(0, 28))}</span>`;
  }

  function dilBadgeHtml() {
    const t = state.turn;
    const base = formatPayloadBadge(t.modelDilPresent, t.modelDilInfo);
    if (!t.dilComponents.size) return base;
    const tags = [...t.dilComponents];
    const rich = tags.filter(x => !["text", "title", "p", "span", "div", "markdown"].includes(x.toLowerCase()));
    const tagStr = esc(tags.slice(0, 8).join(", ")) + (tags.length > 8 ? `…+${tags.length - 8}` : "");
    const color = rich.length ? "#4caf50" : "#80cbc4";
    return `${base} <span style="color:${color};font-size:11px">[组件: ${tagStr}${t.dilUpdateCount > 1 ? ` · ${t.dilUpdateCount}次更新` : ""}]</span>`;
  }

  function routeHtml() {
    const r = state.routeStatus;
    if (!r) return `<span style="color:#888">等待本轮响应…</span>`;
    return `<span style="color:${r.color};font-weight:700">${esc(r.label)}</span><br><span style="color:#888;font-size:11px">${esc(r.detail)}</span>`;
  }

  function budgetHtml() {
    const t = state.turn;
    if (!t.active) return `<span style="color:#888">尚未发送消息</span>`;
    const thinkMs = getThinkingMs(t);
    const ttft = t.firstByteAt && t.turnStart ? t.firstByteAt - t.turnStart : null;
    const total = t.endAt && t.turnStart ? t.endAt - t.turnStart : null;
    const chars = t.answerChars || t.streamAnswerChars;
    const speed = total && total > 0 && chars > 0 ? `${(chars / (total / 1000)).toFixed(1)}字/s` : "—";
    const thinkBadge = t.hasThinking || thinkMs != null
      ? `<span style="color:#4caf50">有 (${fmtSec(thinkMs)}${t.thoughtChars ? ` / ${t.thoughtChars}字` : ""})</span>`
      : t.finished
        ? `<span style="color:#f0ad4e">无</span>`
        : `<span style="color:#888">检测中…</span>`;
    const tools = t.toolsUsed.size ? esc([...t.toolsUsed].join(", ")) : (t.finished ? "无" : "—");
    const rich = [
      t.hasTable ? "表格" : null,
      t.hasCode ? "代码" : null,
      ...[...t.richUiSignals]
    ].filter(Boolean);
    return `
      思考链：${thinkBadge} · 首包：<b>${ttft != null ? `${ttft}ms` : "—"}</b> · 总耗时：<b>${fmtSec(total)}</b><br>
      正文：<b>${chars}</b> 字 · <b>${t.paragraphs}</b> 段 · 速率：<b>${speed}</b> · 结束：<b>${esc(t.finishReason || (t.finished ? "未返回" : "…"))}</b><br>
      工具调用：<b>${tools}</b> · 富元素：<b>${rich.length ? esc(rich.join("/")) : (t.finished ? "纯文本" : "—")}</b>
    `;
  }

  function diffHtml() {
    const d = state.diff;
    if (!d) return "";
    const tag = d.isRegen
      ? `<span style="color:#64b5f6;font-weight:700">[Regenerate vs 上轮]</span>`
      : `<span style="color:#888">[本轮 vs 上轮]</span>`;
    const parts = [
      d.harnessSwitch ? `运行时 ${d.harnessSwitch}` : null,
      `字数 ${d.dChars >= 0 ? "+" : ""}${d.dChars}`,
      d.dThink != null ? `思考 ${d.dThink >= 0 ? "+" : ""}${fmtSec(d.dThink)}` : null,
      d.addedTools.length ? `新增工具 ${d.addedTools.join(",")}` : null
    ].filter(Boolean);
    return `<div style="margin-top:4px;font-size:11px;color:#ccc">${tag} ${esc(parts.join(" · "))}</div>`;
  }

  function sentinelHtml() {
    const s = state.sentinel;
    const pow = s.powRisk
      ? `<span style="color:${s.powRisk.color};font-weight:700">${s.powRisk.label}</span> (${s.powRisk.digits}位中位, 最近 ${esc(s.powHistory[s.powHistory.length - 1]?.difficulty || "")})`
      : `<span style="color:#888">尚未捕获</span>`;
    const persona = s.persona ? `<b>${esc(s.persona)}</b>` : `<span style="color:#888">—</span>`;
    const riskFlags = [
      s.turnstile === true ? `<span style="color:#aaa">Turnstile:常态</span>` : s.turnstile === false ? `Turnstile:关` : null,
      s.arkose === true ? `<span style="color:#f44336">Arkose:开</span>` : s.arkose === false ? `Arkose:关` : null,
      s.forceLogin === true ? `<span style="color:#f44336">ForceLogin</span>` : null
    ].filter(Boolean).join(" · ") || "—";
    return `
      <div><span style="color:#888">PoW：</span>${pow}</div>
      <div><span style="color:#888">Persona：</span>${persona} · <span style="color:#888">校验：</span>${riskFlags}</div>
    `;
  }

  function envHtml() {
    const e = state.env;
    const ray = state.turn.cfRay || state.sentinel.cfRay;
    const traceLine = e.traceIp
      ? `<b>${esc(e.traceIp)}</b> (${esc(e.traceLoc || "?")} / ${esc(e.traceColo || "?")}${e.traceWarp && e.traceWarp !== "off" ? ` / WARP:${esc(e.traceWarp)}` : ""}) <a href="[https://bgp.he.net/ip/$](https://bgp.he.net/ip/$){encodeURIComponent(e.traceIp)}" target="_blank" rel="noopener" data-no-drag style="color:#64b5f6;text-decoration:underline;margin-left:4px">查ASN</a>`
      : `<span style="color:#888">${esc(e.traceError || "查询中…")}</span>`;
    const asnLine = e.asnOrg
      ? `<span style="color:${e.asnRisk.color};font-weight:700">${esc(e.asnRisk.label)}</span> <span style="color:#999">(${esc(e.asnOrg)})</span>`
      : `<span style="color:#888">${esc(e.asnError || "查询中…")}</span>`;
    return `
      <div><span style="color:#888">同源出口：</span>${traceLine}</div>
      <div><span style="color:#888">ASN 归属：</span>${asnLine}${ray ? ` · <span style="color:#777">CF-Ray:${esc(ray)}</span>` : ""} <button id="crc-refresh-env" data-no-drag style="margin-left:4px;padding:1px 5px;border:1px solid #444;border-radius:4px;background:#1b1b1b;color:#ccc;font:11px/1 ui-monospace;cursor:pointer">刷新</button></div>
    `;
  }

  function softSignalsHtml() {
    if (!state.softSignals.length) return "";
    const rows = state.softSignals.map(s => {
      const c = s.level === "high" ? "#ff7043" : s.level === "info" ? "#90caf9" : "#f0ad4e";
      return `<div style="color:${c};font-size:11px">• ${esc(s.text)}</div>`;
    }).join("");
    return `<div style="margin-top:5px;margin-bottom:6px;padding:5px 8px;border:1px solid #443322;border-radius:6px;background:#1b1510">${rows}</div>`;
  }

  function render() {
    mountPanel();
    refreshDom();
    state.routeStatus = evaluateRoute();
    state.softSignals = evaluateSoftSignals();

    const t = state.turn;
    const ae = document.activeElement;
    const keep = ae && ae.id === "crc-ac-seconds";
    const sel = keep ? ae.selectionStart : null;

    const actionBadge = t.action
      ? `<span style="padding:1px 5px;border-radius:4px;background:${t.action === "variant" ? "#1e3a5f" : "#222"};color:${t.action === "variant" ? "#90caf9" : "#bbb"};font-size:11px">${esc(t.action)}</span>`
      : "";

    panel.innerHTML = `
      <div id="crc-header" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;cursor:grab;user-select:none;touch-action:none">
        <div style="flex:1;font-weight:700;font-size:13.5px;pointer-events:none">ChatGPT Degrade Checker v7.2</div>
        ${actionBadge}
        <button id="crc-collapse" data-no-drag title="收起" style="flex:none;width:22px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid #444;border-radius:6px;background:#1b1b1b;color:#ddd;font:14px/1 ui-monospace;cursor:pointer">–</button>
      </div>
      <div style="margin-bottom:6px;font-weight:600">${overall()}</div>
      ${runtimeBannerHtml()}
      ${softSignalsHtml()}

      <div style="border-top:1px solid #333;padding-top:7px;margin-bottom:7px">
        <div style="color:#aaa;font-weight:700;margin-bottom:3px">1. 路由与 DIL/GenUI 载荷</div>
        ${routeHtml()}
        <div style="margin-top:5px;font-size:11.5px;color:#ccc">
          请求：<b>${disp(t.requestModel)}</b> · 强度：<b>${disp(t.thinkingEffort)}</b><br>
          resolved：<b>${disp(t.resolvedModel)}</b> · default：<b>${disp(t.defaultModel)}</b><br>
          server_ste：<b>${disp(t.serverModel)}</b> · assistant：<b>${disp(t.assistantModel)}</b><br>
          model_dil_v2：${dilBadgeHtml()}<br>
          genui_components：${formatPayloadBadge(t.genuiPresent, t.genuiInfo)}
        </div>
      </div>

      <div style="border-top:1px solid #333;padding-top:7px;margin-bottom:7px">
        <div style="color:#aaa;font-weight:700;margin-bottom:3px">2. 思考预算与输出指纹</div>
        <div style="font-size:11.5px;color:#ccc">${budgetHtml()}</div>
        ${diffHtml()}
      </div>

      <div style="border-top:1px solid #333;padding-top:7px;margin-bottom:7px">
        <div style="color:#aaa;font-weight:700;margin-bottom:3px">3. Sentinel 风控与同源出口</div>
        <div style="font-size:11.5px;color:#ccc">${sentinelHtml()}${envHtml()}</div>
      </div>

      <div style="border-top:1px solid #333;padding-top:7px;display:flex;gap:6px">
        <button id="crc-copy-diag" data-no-drag style="flex:1;padding:6px 8px;border:1px solid #3a5a40;border-radius:6px;background:#162419;color:#b7e4c7;font:11.5px/1.3 ui-monospace;cursor:pointer">复制诊断 JSON（含完整元数据）</button>
        <button id="crc-copy-probes" data-no-drag style="flex:1;padding:6px 8px;border:1px solid #444;border-radius:6px;background:#1b1b1b;color:#eee;font:11.5px/1.3 ui-monospace;cursor:pointer">复制新版探针（4 维度）</button>
      </div>

      <div id="crc-ac-row" data-no-drag style="display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:7px;border-top:1px solid #333;color:#aaa;font-size:11px;user-select:none;">
        <span id="crc-ac-toggle" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <span id="crc-ac-box" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid #666;border-radius:3px;background:#1b1b1b;flex:none;font:700 11px/1 ui-monospace;color:transparent;box-sizing:border-box;">✓</span>
          <span>自动收起</span>
        </span>
        <span id="crc-ac-sec-row" style="display:inline-flex;align-items:center;gap:4px;">
          <span>（点击外部或展开后</span>
          <input id="crc-ac-seconds" type="number" min="${AC_MIN}" max="${AC_MAX}" step="1" value="${acSecs()}" style="${INPUT_STYLE}">
          <span>秒）</span>
        </span>
      </div>
    `;

    updateACUI();
    updateDot();
    if (keep) {
      const el = panel.querySelector("#crc-ac-seconds");
      if (el) {
        el.focus();
        try { el.setSelectionRange(sel, sel); } catch {}
      }
    }
  }

  // ================== 轮次生命周期 ==================
  function beginTurn(req) {
    clearTimeout(finishTimer);
    const t = createEmptyTurn();
    t.turnId = ++turnSeq;
    t.active = true;
    t.turnStart = Date.now();
    t.action = typeof req?.action === "string" ? req.action : "next";
    t.requestModel = typeof req?.model === "string" ? req.model : null;
    t.thinkingEffort = typeof req?.thinking_effort === "string"
      ? req.thinking_effort
      : (typeof req?.reasoning_effort === "string" ? req.reasoning_effort : null);
    state.turn = t;
    state.diff = null;
    render();
  }

  function finalizeTurn(expectedTurnId) {
    const t = state.turn;
    if (t.turnId !== expectedTurnId) return;
    t.finished = true;
    if (!t.endAt) t.endAt = Date.now();
    if (t.genuiPresent === null) t.genuiPresent = false;
    if (t.modelDilPresent === null) t.modelDilPresent = false;

    extractMetrics();

    if (!t.recordedInHistory) {
      t.recordedInHistory = true;
      const snap = snapshotTurn(t);
      const prev = state.history.length ? state.history[state.history.length - 1] : null;
      state.diff = computeDiff(prev, snap);
      state.history.push(snap);
      if (state.history.length > 10) state.history.shift();
    }
    render();
  }

  function scheduleFinishAfterStream(turnId, delay = 1200) {
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => finalizeTurn(turnId), delay);
  }

  // ================== 深度对象扫描 ==================
  function scanObject(obj, depth = 0, seen = new WeakSet(), ctx = null) {
    if (obj == null || depth > 14) return;
    if (typeof obj === "string") {
      const s = obj.trim();
      if ((s.startsWith("{") || s.startsWith("[")) &&
          (s.includes("model_slug") || s.includes("genui") || s.includes("model_dil") || s.includes("finished_duration") || s.includes("server_ste_metadata") || s.includes("turn_analytics"))) {
        try { scanObject(JSON.parse(s), depth + 1, seen, ctx); } catch {}
      }
      return;
    }
    if (typeof obj !== "object" || seen.has(obj)) return;
    seen.add(obj);

    const t = state.turn;

    // 1. 直接键值捕获：genui_components 与 model_dil_v2
    if ("genui_components" in obj) recordGenui(obj.genui_components);
    if ("model_dil_v2" in obj) recordModelDil(obj.model_dil_v2);

    if ("search_result_groups" in obj || "content_references" in obj) {
      const v = obj.search_result_groups || obj.content_references;
      if (Array.isArray(v) && v.length) {
        t.richUiSignals.add("citations");
        dirty = true;
      }
    }

    // 2. 完整捕获 turn_analytics 与 server_ste_metadata
    if (obj.turn_analytics && typeof obj.turn_analytics === "object") {
      recordTurnAnalytics(obj.turn_analytics);
    }

    const steObj =
      (obj.type === "server_ste_metadata" && (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : obj)) ||
      (obj.server_ste_metadata && typeof obj.server_ste_metadata === "object" ? obj.server_ste_metadata : null) ||
      (obj.turn_analytics?.server_ste_metadata && typeof obj.turn_analytics.server_ste_metadata === "object" ? obj.turn_analytics.server_ste_metadata : null);

    if (steObj) {
      recordServerSte(steObj);
      if (typeof steObj.model_slug === "string") setTurnField("serverModel", steObj.model_slug);
      if (typeof steObj.requested_model_experience === "string") setTurnField("requestedExperience", steObj.requested_model_experience);
    }

    // 3. resolved_model_slug
    if (typeof obj.resolved_model_slug === "string" && obj.resolved_model_slug) {
      setTurnField("resolvedModel", obj.resolved_model_slug);
    }

    // 4. 思考状态与服务端时长
    if (typeof obj.finished_duration_sec === "number") {
      setTurnField("serverThoughtSec", obj.finished_duration_sec);
      t.hasThinking = true;
    }
    if (typeof obj.reasoning_status === "string") {
      t.hasThinking = true;
      if (obj.reasoning_status === "is_reasoning" && !t.reasoningStartAt) t.reasoningStartAt = Date.now();
      if (obj.reasoning_status === "reasoning_ended" && !t.reasoningEndAt) t.reasoningEndAt = Date.now();
    }

    // 5. finish_details
    if (obj.finish_details && typeof obj.finish_details.type === "string") {
      setTurnField("finishReason", obj.finish_details.type);
    }

    // 6. assistant / tool 消息节点
    const msg = obj.author?.role ? obj : (obj.message?.author?.role ? obj.message : null);
    if (msg) {
      const role = msg.author?.role;
      const recipient = msg.recipient;
      if (role === "assistant") {
        if (typeof msg.id === "string" && msg.id) setTurnField("assistantMessageId", msg.id);
        if (msg.metadata && typeof msg.metadata === "object") {
          recordAssistantMeta(msg.metadata);
          if (typeof msg.metadata.model_slug === "string") setTurnField("assistantModel", msg.metadata.model_slug);
          if (typeof msg.metadata.default_model_slug === "string") setTurnField("defaultModel", msg.metadata.default_model_slug);
          if (typeof msg.metadata.resolved_model_slug === "string") setTurnField("resolvedModel", msg.metadata.resolved_model_slug);
          if (typeof msg.metadata.finished_duration_sec === "number") {
            setTurnField("serverThoughtSec", msg.metadata.finished_duration_sec);
            t.hasThinking = true;
          }
          if (msg.metadata.finish_details?.type) setTurnField("finishReason", msg.metadata.finish_details.type);
        }

        if (typeof recipient === "string" && recipient && recipient !== "all" && recipient !== "commentary") {
          t.toolsUsed.add(recipient);
          dirty = true;
        }

        const ct = msg.content?.content_type;
        if (ct === "thoughts" || ct === "reasoning_recap") {
          t.hasThinking = true;
          if (!t.reasoningStartAt) t.reasoningStartAt = Date.now();
          if (Array.isArray(msg.content?.thoughts)) {
            const len = msg.content.thoughts.map(x => `${x.summary || ""}${x.content || ""}`).join("").length;
            if (len > t.thoughtChars) t.thoughtChars = len;
          }
        } else if (ct && ct !== "text" && ct !== "code") {
          t.richUiSignals.add(ct);
        }

        if (ct === "text" && (!recipient || recipient === "all") && Array.isArray(msg.content?.parts)) {
          const joined = msg.content.parts.filter(x => typeof x === "string").join("");
          if (joined.length > 0) {
            if (!t.firstAnswerAt) t.firstAnswerAt = Date.now();
            if (t.reasoningStartAt && !t.reasoningEndAt) t.reasoningEndAt = t.firstAnswerAt;
            if (joined.length > t.streamAnswerChars) t.streamAnswerChars = joined.length;
            if (joined.length > t._fullAnswerText.length && joined.length <= 60000) {
              t._fullAnswerText = joined;
            }
          }
        }
      } else if (role === "tool" && typeof msg.author?.name === "string" && msg.author.name) {
        t.toolsUsed.add(msg.author.name);
        dirty = true;
      }
    }

    // 7. delta_encoding v1 增量补丁（v7.2：严格隔离 batch patch 包装层，仅显式 p 匹配结构字段）
    const isBatchPatch = obj.o === "patch" && Array.isArray(obj.v);
    if (ctx && !isBatchPatch && ("p" in obj || "o" in obj || "v" in obj)) {
      const explicitP = typeof obj.p === "string" ? obj.p : null;
      if (explicitP) ctx.lastPath = explicitP;
      const effectiveP = explicitP || ctx.lastPath;

      if (explicitP && "v" in obj) {
        if (/\/genui_components$/.test(explicitP)) {
          recordGenui(obj.v);
        } else if (/\/genui_components\/.+/.test(explicitP)) {
          if (t._genuiPatchItems.length < 30) t._genuiPatchItems.push(obj.v);
          recordGenui(t._genuiPatchItems);
        } else if (/\/model_dil_v2$/.test(explicitP)) {
          recordModelDil(obj.v);
        } else if (/\/model_dil_v2\/code$/.test(explicitP) && typeof obj.v === "string") {
          t.modelDilPresent = true;
          t._dilCodeBuf = (t._dilCodeBuf + obj.v).slice(-24000);
          extractDilTags(t._dilCodeBuf);
          dirty = true;
        } else if (/\/server_ste_metadata$/.test(explicitP) && obj.v && typeof obj.v === "object") {
          recordServerSte(obj.v);
        } else if (/\/turn_analytics$/.test(explicitP) && obj.v && typeof obj.v === "object") {
          recordTurnAnalytics(obj.v);
        } else if (/\/resolved_model_slug$/.test(explicitP) && typeof obj.v === "string") {
          setTurnField("resolvedModel", obj.v);
        }
      }

      if (effectiveP && typeof obj.v === "string" && obj.v.length > 0) {
        if (effectiveP.includes("model_dil_v2/code") && !explicitP) {
          t.modelDilPresent = true;
          t._dilCodeBuf = (t._dilCodeBuf + obj.v).slice(-24000);
          extractDilTags(t._dilCodeBuf);
        } else if (effectiveP.includes("thought") || effectiveP.includes("reasoning")) {
          t.hasThinking = true;
          t.thoughtChunks += 1;
          t.thoughtChars += obj.v.length;
          if (!t.reasoningStartAt) t.reasoningStartAt = Date.now();
        } else if (effectiveP.includes("/message/content/parts/")) {
          if (!t.firstAnswerAt) t.firstAnswerAt = Date.now();
          if (t.reasoningStartAt && !t.reasoningEndAt) t.reasoningEndAt = t.firstAnswerAt;
          t.streamAnswerChars += obj.v.length;
          if (t._deltaAnswerText.length < 60000) t._deltaAnswerText += obj.v;
        }
      }
    }

    for (const v of Object.values(obj)) {
      if (v && (typeof v === "object" || typeof v === "string")) {
        scanObject(v, depth + 1, seen, ctx);
      }
    }
  }

  function parseData(raw, ctx = null) {
    if (!raw) return;
    const s = raw.trim();
    if (!s || s === "[DONE]") return;
    let o;
    try { o = JSON.parse(s); } catch { return; }
    dirty = false;
    scanObject(o, 0, new WeakSet(), ctx);
    if (dirty) render();
  }

  function scanWhole(text) {
    if (!text) return;
    parseData(text);
    for (let l of text.split(/\r?\n/)) {
      l = l.trim();
      if (!l) continue;
      if (l.startsWith("data:")) l = l.slice(5).trim();
      parseData(l);
    }
  }

  // ================== SSE 流监听 ==================
  async function watchStream(response, turnId) {
    const t = state.turn;
    const cfRay = response.headers?.get("cf-ray");
    if (cfRay) t.cfRay = cfRay;
    t.httpStatus = response.status;

    if (!response.body) {
      try { scanWhole(await response.text()); } catch {}
      if (state.turn.turnId === turnId) {
        state.turn.streamEnded = true;
        state.turn.endAt = Date.now();
        scheduleFinishAfterStream(turnId, 800);
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ctx = { lastPath: "" };
    let buffer = "", ev = [];

    const flush = () => {
      if (ev.length) {
        parseData(ev.join("\n"), ctx);
        ev = [];
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (state.turn.turnId !== turnId) break;
        if (!state.turn.firstByteAt) state.turn.firstByteAt = Date.now();

        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") flush();
          else if (line.startsWith("data:")) ev.push(line.slice(5).trimStart());
          else {
            const trimmed = line.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) parseData(trimmed, ctx);
          }
        }
      }
      const rest = buffer.trim();
      if (rest.startsWith("data:")) ev.push(rest.slice(5).trimStart());
      else if (rest) parseData(rest, ctx);
      flush();
    } catch {}

    if (state.turn.turnId === turnId) {
      state.turn.streamEnded = true;
      state.turn.endAt = Date.now();
      scheduleFinishAfterStream(turnId, 1200);
    }
  }

  // ================== 各类辅助接口处理 ==================
  async function handleChatRequirements(resp) {
    try {
      const ray = resp.headers?.get("cf-ray");
      if (ray) state.sentinel.cfRay = ray;
      const d = await resp.clone().json();
      const pow = d?.proofofwork || d?.proof_of_work;
      if (pow) {
        if (typeof pow.required === "boolean") state.sentinel.powRequired = pow.required;
        if (typeof pow.difficulty === "string" && pow.difficulty) recordPow(pow.difficulty);
      }
      if (typeof d?.persona === "string") state.sentinel.persona = d.persona;
      if (typeof d?.turnstile?.required === "boolean") state.sentinel.turnstile = d.turnstile.required;
      if (typeof d?.arkose?.required === "boolean") state.sentinel.arkose = d.arkose.required;
      if (typeof d?.force_login === "boolean") state.sentinel.forceLogin = d.force_login;
      state.sentinel.lastAt = Date.now();
      render();
    } catch {}
  }

  async function handleConversationGet(resp) {
    try {
      const t = state.turn;
      if (!t.active) return;
      const d = await resp.clone().json();
      const mapping = d?.mapping;
      if (!mapping || typeof mapping !== "object") return;
      let node = t.assistantMessageId ? mapping[t.assistantMessageId] : null;
      if (!node && d.current_node && mapping[d.current_node]?.message?.author?.role === "assistant") {
        node = mapping[d.current_node];
      }
      if (node?.message) {
        dirty = false;
        scanObject(node.message);
        if (dirty) render();
      }
    } catch {}
  }

  async function handleAccountMeta(resp, url) {
    try {
      const d = await resp.clone().json();
      if (/\/backend-api\/models/.test(url) && Array.isArray(d?.models)) {
        state.account.modelCount = d.models.length;
      }
      const raw = JSON.stringify(d);
      const planMatch = raw.match(/"plan_type"\s*:\s*"([^"]+)"/);
      if (planMatch) state.account.planType = planMatch[1];
      for (const kw of ["genui", "intelligent_ui", "model_dil", "codex", "cca", "concise", "fallback"]) {
        if (raw.toLowerCase().includes(kw)) state.account.flagsHit.add(kw);
      }
    } catch {}
  }

  // ================== 请求体读取与路由匹配 ==================
  async function bodyText(b) {
    try {
      if (b == null) return "";
      if (typeof b === "string") return b;
      if (b instanceof Blob) return await b.text();
      if (b instanceof URLSearchParams) return b.toString();
      if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
      if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
    } catch {}
    return "";
  }
  async function reqText(input, init) {
    if (init?.body != null) return await bodyText(init.body);
    if (input instanceof Request) { try { return await input.clone().text(); } catch {} }
    return "";
  }

  const isConvPost = (u, m) => m === "POST" && /\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(u);
  const isConvGet = (u, m) => m === "GET" && /\/backend-api\/conversation\/[0-9a-f-]{16,}(?:\?|$)/i.test(u);
  const isTele = (u, m) => m === "POST" && /\/ces\/v1\/telemetry\/intake(?:\?|$)/.test(u);
  const isCR = (u, m) => m === "POST" && /\/backend-(?:api|anon)\/sentinel\/chat-requirements(?:\/prepare)?(?:\?|$)/.test(u);
  const isAccountMeta = (u, m) => m === "GET" && /\/backend-api\/(?:models|accounts\/check|me)(?:\/|\?|$)/.test(u);

  // ================== fetch / WebSocket / beacon Hook ==================
  window.fetch = async function (input, init = {}) {
    const u = typeof input === "string" ? input : input?.url || "";
    const m = String(init.method || input?.method || "GET").toUpperCase();

    let myTurnId = null;
    if (isConvPost(u, m)) {
      const txt = await reqText(input, init);
      try { beginTurn(JSON.parse(txt)); } catch { beginTurn({}); }
      myTurnId = state.turn.turnId;
    } else if (isTele(u, m)) {
      const txt = await reqText(input, init);
      if (txt.includes("model_slug") || txt.includes("genui") || txt.includes("model_dil") || txt.includes("server_ste_metadata") || txt.includes("turn_analytics")) {
        scanWhole(txt);
      }
    }

    const resp = await nativeFetch(input, init);

    if (myTurnId != null) {
      try { void watchStream(resp.clone(), myTurnId); } catch {}
    } else if (isCR(u, m)) {
      void handleChatRequirements(resp);
    } else if (isConvGet(u, m)) {
      void handleConversationGet(resp);
    } else if (isAccountMeta(u, m)) {
      void handleAccountMeta(resp, u);
    }

    return resp;
  };

  try {
    window.WebSocket = function (...args) {
      const ws = new NativeWebSocket(...args);
      ws.addEventListener("message", ev => {
        try {
          const s = typeof ev.data === "string" ? ev.data : "";
          if (s.includes("model_slug") || s.includes("resolved_model_slug") || s.includes("genui_components") || s.includes("server_ste_metadata") || s.includes("turn_analytics")) {
            scanWhole(s);
          }
        } catch {}
      });
      return ws;
    };
    window.WebSocket.prototype = NativeWebSocket.prototype;
  } catch {}

  if (nativeBeacon) {
    try {
      navigator.sendBeacon = function (u, d) {
        if (/\/ces\/v1\/telemetry\/intake(?:\?|$)/.test(String(u || ""))) {
          void bodyText(d).then(txt => {
            if (txt.includes("model_slug") || txt.includes("genui") || txt.includes("model_dil") || txt.includes("server_ste_metadata") || txt.includes("turn_analytics")) {
              scanWhole(txt);
            }
          });
        }
        return nativeBeacon(u, d);
      };
    } catch {}
  }

  // ================== DOM 监听 ==================
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      mountPanel();
      const before = state.turn.domModel;
      refreshDom();
      if (state.turn.domModel !== before) render();
    });
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-message-model-slug"] });

  // ================== 启动 ==================
  render();
  setTimeout(() => void refreshEnv(false), 1800);
  console.log("ChatGPT Route & Degrade Checker v7.2 已启动。");
})();