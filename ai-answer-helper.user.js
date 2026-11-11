// ==UserScript==
// @name         AI 答题助手（头歌 / 超星 / 通用）
// @namespace    ai-answer-helper
// @version      2.2.8
// @description  抓取网页题目 → 先查本地题库（导入 Word / 文本，文件不上传）→ 再查在线题库接口（兼容 OCS / 言溪配置，可填多份）→ 都未命中的才调任意 OpenAI 兼容 API → 自动填入。平台差异由 adapter 层适配，内置头歌/超星类，其余页面走通用启发式。
// @icon         https://gcore.jsdelivr.net/gh/wuzhihuijin/touge-answer-helper@main/icon-256.png
// @license      MIT
// @tag          头歌
// @tag          educoder
// @tag          答题
// @tag          自动填写
// @tag          ai
// @tag          题库
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      *
// @updateURL    https://scriptcat.org/scripts/code/9005/AI%20%E7%AD%94%E9%A2%98%E5%8A%A9%E6%89%8B%EF%BC%88%E5%A4%B4%E6%AD%8C%20%2F%20%E8%B6%85%E6%98%9F%20%2F%20%E9%80%9A%E7%94%A8%EF%BC%89.user.js
// @downloadURL  https://scriptcat.org/scripts/code/9005/AI%20%E7%AD%94%E9%A2%98%E5%8A%A9%E6%89%8B%EF%BC%88%E5%A4%B4%E6%AD%8C%20%2F%20%E8%B6%85%E6%98%9F%20%2F%20%E9%80%9A%E7%94%A8%EF%BC%89.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  if (window.__AAH__) return;
  window.__AAH__ = true;

  /* =========================================================
   * 1. 配置
   * =======================================================*/
  const CFG_KEY = 'aah_cfg_v1';
  const PRESETS = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', label: 'DeepSeek 官方' },
    dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', label: '阿里云百炼（通义 / DeepSeek）' },
    moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', label: '月之暗面 Kimi' },
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', label: '智谱 GLM' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI' },
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', label: '本地 Ollama' },
    custom: { baseUrl: '', model: '', label: '自定义（任意 OpenAI 兼容）' }
  };
  const DEFAULTS = {
    provider: 'deepseek',
    baseUrl: PRESETS.deepseek.baseUrl,
    model: PRESETS.deepseek.model,
    apiKey: '',
    chunk: 8,
    temp: 0.1,
    jsonMode: true,
    thinking: false,
    autoHide: true,
    minQ: 2,
    bankApi: '',       // 题库接口配置（OCS 那套 JSON，可多份 #### 分隔）
    bankApiOn: true,   // 答题前先查题库接口
    bankLocalOn: true  // 答题前先查本地题库（Word / 文本导入的）
  };
  let cfg = Object.assign({}, DEFAULTS, GM_getValue(CFG_KEY, {}) || {});
  const saveCfg = () => GM_setValue(CFG_KEY, cfg);

  /* =========================================================
   * 2. 基础工具
   * =======================================================*/
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.prototype.slice.call(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LETTERS = 'ABCDEFGHIJ';
  const esc = (s) => String(s == null ? '' : s);

  /** 写入输入框并触发 React/Vue 能识别的原生事件 */
  function setNativeValue(el, val) {
    if (!el) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement
      : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    const desc = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    el.focus();
    if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  const TYPE_CN = {
    single_choice: '单选题', multiple_choice: '多选题',
    judgement: '判断题', fill_blank: '填空题', short_answer: '简答题'
  };

  /** 把答案（字母 / 选项原文 / 正确错误）统一解析成选项下标数组 */
  function resolveIdx(choices, ans) {
    const norm = (s) => String(s == null ? '' : s).replace(/[\s:：。，,、()（）]/g, '').toLowerCase();
    const raw = String(ans == null ? '' : ans);
    const letters = raw.toUpperCase().replace(/[^A-J]/g, '').split('')
      .map((c) => LETTERS.indexOf(c)).filter((i) => i >= 0 && i < choices.length);
    if (letters.length && !/[\u4e00-\u9fa5]/.test(raw)) return letters;
    const a = norm(raw);
    if (a) {
      let hit = choices.map((c, i) => ({ i: i, t: norm(c.t) })).filter((x) => x.t === a);
      if (!hit.length) hit = choices.map((c, i) => ({ i: i, t: norm(c.t) })).filter((x) => x.t && x.t.indexOf(a) >= 0);
      if (!hit.length && a.length > 1) {
        hit = choices.map((c, i) => ({ i: i, t: norm(c.t) })).filter((x) => a.indexOf(x.t) >= 0 && x.t.length > 0);
      }
      if (hit.length) return [hit[0].i];
    }
    if (choices.length === 2) {
      if (/^(正确|对|是|true|t|√|yes)$/i.test(a)) return [0];
      if (/^(错误|错|否|false|f|×|no)$/i.test(a)) return [1];
    }
    return letters;
  }

  /* =========================================================
   * 3. AI 调用
   * =======================================================*/
  const SYS_PROMPT = [
    '你是一名严谨的高校课程助教，负责给在线作业提供正确答案。',
    '规则：',
    '1) 单选题、判断题：只输出一个选项字母，例如 A；',
    '2) 多选题：输出多个字母，按字母升序、英文逗号分隔，例如 A,C；',
    '3) 填空题：只输出应填入的文字，不要解释、不要加引号和句号；一题多个空用 | 分隔，顺序与空一致；',
    '4) 严格输出 JSON 对象，key 是题号（字符串），value 是答案字符串；',
    '5) 不要输出任何 JSON 以外的文字，不要使用 markdown 代码块；',
    '6) 计算题认真算，宁可多算一遍也不要给含糊答案。'
  ].join('\n');

  async function chat(messages, override) {
    const c = Object.assign({}, cfg, override || {});
    const isLocal = /localhost|127\.0\.0\.1/.test(c.baseUrl || '');
    if (!c.apiKey && !isLocal) throw new Error('还没填 API Key，先点「设置」');
    if (!c.baseUrl || !c.model) throw new Error('Base URL 或模型名是空的');
    const url = String(c.baseUrl).replace(/\/+$/, '') + '/chat/completions';

    const body = {
      model: c.model,
      messages: messages,
      temperature: Number(c.temp) || 0
    };
    if (c.jsonMode) body.response_format = { type: 'json_object' };
    if (c.thinking) { body.enable_thinking = true; delete body.response_format; }

    const send = () => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
        data: JSON.stringify(body),
        timeout: 180000,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时'))
      });
    });

    let r = await send();
    if (r.status === 400 && /response_format|json_object/i.test(r.text) && body.response_format) {
      delete body.response_format;
      r = await send();
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error('AI 接口 ' + r.status + '：' + String(r.text).slice(0, 180));
    }
    let j;
    try { j = JSON.parse(r.text); } catch (e) { throw new Error('AI 返回不是 JSON：' + r.text.slice(0, 120)); }
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    return (msg && msg.content) || '';
  }

  function extractJson(text) {
    if (!text) return null;
    const s = String(text).replace(/```json/gi, '```').replace(/```/g, '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* 走正则 */ }
    }
    const out = {};
    const re = /["']?(\d{1,3})["']?\s*:\s*["']([^"']*)["']/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2];
    return Object.keys(out).length ? out : null;
  }

  function buildPrompt(list) {
    const lines = [];
    list.forEach((q) => {
      const t = TYPE_CN[q.type] || '单选题';
      lines.push('[' + q.n + ']（' + t + '）' + q.title);
      if (q.choices && q.choices.length) {
        q.choices.forEach((c, i) => lines.push('   ' + LETTERS[i] + '. ' + c.t));
      } else {
        lines.push('   （填空题，直接给出应填的文字）');
      }
    });
    return '请给出下面 ' + list.length + ' 道题的答案，只输出 JSON 对象。\n\n' + lines.join('\n');
  }

  async function askAI(questions, onTick) {
    const size = Math.max(1, Math.min(20, Number(cfg.chunk) || 8));
    const result = {};
    for (let i = 0; i < questions.length; i += size) {
      const part = questions.slice(i, i + size);
      if (onTick) onTick('请求 AI：第 ' + (i + 1) + '-' + Math.min(i + size, questions.length) + ' 题…');
      let raw = '';
      let parsed = null;
      for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
        raw = await chat([
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: buildPrompt(part) }
        ]);
        parsed = extractJson(raw);
        if (!parsed && attempt < 2) await sleep(600);
      }
      if (!parsed) throw new Error('AI 返回无法解析：' + String(raw).slice(0, 160));
      part.forEach((q) => {
        const v = parsed[q.n] != null ? parsed[q.n] : parsed[String(q.n)];
        if (v != null && String(v).trim() !== '') result[q.n] = String(v).trim();
      });
      if (i + size < questions.length) await sleep(200);
    }
    return result;
  }

  /* =========================================================
   * 3.5 题干归一化（在线题库的多结果比对也用它）
   * =======================================================*/
  function toHalfWidth(s) {
    return String(s)
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ');
  }

  /** 题干归一化：去标签、去题号、去空白与标点、全角转半角、转小写 */
  function normStem(s) {
    let t = toHalfWidth(s == null ? '' : s);
    t = t.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
    // 题号：括号型（(1) 【2】 [3]）、「第3题」、「1. / 1、/ 1：」
    // 注意 1.5 / 0.5 这类小数开头不能当题号切掉，否则「1.5倍」和「2.5倍」会撞车
    t = t.replace(/^\s*[（(【\[]\s*\d{1,3}\s*[)）】\]]\s*/, '');
    t = t.replace(/^\s*第\s*\d{1,3}\s*[题小]\s*[.、．:：]?\s*/, '');
    t = t.replace(/^\s*\d{1,3}\s*(?:[、．:：)）]|\.(?!\d))\s*/, '');
    t = t.replace(/\s+/g, '');
    t = t.replace(/[，。、；：？！“”‘’（）【】《》〈〉,.;:?!"'`~!@#$%^&*()\[\]{}<>\-=+|\\\/]/g, '');
    return t.toLowerCase();
  }

  /** 答案清洗：去掉「答案：」前缀、解析尾巴、引号；纯字母则压成 ABCD 形式 */
  function cleanAns(a) {
    let s = toHalfWidth(String(a == null ? '' : a)).trim();
    s = s.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
    s = s.replace(/^(?:正确)?答案\s*[:：]\s*/, '').replace(/^[选答]\s*[:：]\s*/, '');
    // 「A 【解析】…」「A 解析：…」这种把解析写在同一行的，只留答案本身
    s = s.replace(/[（(【\[]\s*(?:解析|分析|考点|难度|来源|出处)[\s\S]*$/, '');
    s = s.replace(/\s+(?:解析|考点|难度|来源)\s*[:：][\s\S]*$/, '');
    s = s.trim();
    const letters = s.replace(/[\s,，、;；\/]+/g, '').toUpperCase();
    if (/^[A-J]{1,6}$/.test(letters)) return letters;
    return s.replace(/\s+/g, ' ').trim();
  }

  function bigrams(s) {
    const set = new Set();
    if (s.length === 1) { set.add(s); return set; }
    for (let i = 0; i < s.length - 1; i++) set.add(s.substr(i, 2));
    return set;
  }

  /* =========================================================
   * 3.6 在线题库（兼容 OCS / 言溪那套「题库配置」JSON）
   *   一份配置 = 一次 HTTP 请求 + 一段 handler：
   *     data 里的 ${title} ${options} ${type} 会被替换成题干 / 选项 / 题型，
   *     handler 用 new Function 解析，接收响应，返回 [题,答] 或 [[题,答],…]。
   *   多份配置用 #### 隔开，或用数组包多份。
   * =======================================================*/
  const API_TIMEOUT = 12000;
  const API_DEADLINE = 30000;
  const API_TYPES = {
    single_choice: 'single', multiple_choice: 'multiple',
    judgement: 'judgement', fill_blank: 'completion', short_answer: 'completion'
  };
  let apiCache = null;     // { raw, list }

  function apiConfigs() {
    const raw = String(cfg.bankApi || '').trim();
    if (!raw) return [];
    if (apiCache && apiCache.raw === raw) return apiCache.list;
    const list = [];
    raw.split(/#{3,}/).forEach((seg) => {
      const t = seg.trim();
      if (!t) return;
      let j = null;
      try { j = JSON.parse(t); } catch (e) {
        log('⚠️ 在线题库配置有一段不是合法 JSON，已跳过', 'warn');
        return;
      }
      (Array.isArray(j) ? j : [j]).forEach((c) => {
        if (c && c.url && c.handler) list.push(c);
      });
    });
    apiCache = { raw: raw, list: list };
    return list;
  }

  /** 替换 ${title} / ${options} / ${type}；data 里也能写 {handler:"return (env)=>…"} */
  function apiFill(v, env) {
    if (typeof v === 'string') {
      return v.replace(/\$\{(title|type|options)\}/g, (m, k) => (env[k] == null ? '' : String(env[k])));
    }
    if (v && typeof v === 'object' && typeof v.handler === 'string') {
      try {
        const fn = new Function(v.handler)();
        const r = typeof fn === 'function' ? fn(env) : fn;
        return r === undefined ? null : r;
      } catch (e) {
        log('⚠️ 在线题库 data 里的 handler 执行出错：' + (e.message || e), 'warn');
        return null;
      }
    }
    return v;
  }

  function apiURLEncode(obj) {
    return Object.keys(obj).map((k) => {
      const v = obj[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return encodeURIComponent(k) + '=' + encodeURIComponent(s);
    }).join('&');
  }

  function apiBuild(c, env) {
    const data = {};
    if (c.data && typeof c.data === 'object') {
      Object.keys(c.data).forEach((k) => {
        const v = apiFill(c.data[k], env);
        if (v !== null && v !== undefined) data[k] = v;
      });
    }
    let url = String(apiFill(String(c.url || ''), env));
    const headers = {};
    if (c.headers && typeof c.headers === 'object') {
      Object.keys(c.headers).forEach((k) => { headers[k] = String(apiFill(c.headers[k], env)); });
    }
    const method = String(c.method || 'get').toUpperCase();
    const ctKey = Object.keys(headers).filter((k) => k.toLowerCase() === 'content-type')[0] || '';
    const isForm = /x-www-form-urlencoded/i.test(ctKey ? headers[ctKey] : '');
    let body = null;

    if (method === 'GET') {
      const qs = apiURLEncode(data);
      if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
    } else if (isForm) {
      body = apiURLEncode(data);
      headers[ctKey] = 'application/x-www-form-urlencoded';
    } else {
      if (!ctKey) headers['Content-Type'] = 'application/json';
      body = JSON.stringify(data);
    }
    return { url: url, method: method, headers: headers, body: body };
  }

  function apiSend(req) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { try { clearTimeout(timer); } catch (e) {} fn(v); };
      const timer = setTimeout(() => done(reject, new Error('请求超时')), API_TIMEOUT);
      try {
        GM_xmlhttpRequest({
          url: req.url, method: req.method, headers: req.headers, data: req.body, timeout: API_TIMEOUT,
          onload: (r) => {
            if (r.status >= 200 && r.status < 300) done(resolve, r.responseText);
            else done(reject, new Error('HTTP ' + r.status));
          },
          onerror: () => done(reject, new Error('请求失败，可能域名没放行（@connect）或被浏览器拦了')),
          ontimeout: () => done(reject, new Error('请求超时'))
        });
      } catch (e) { done(reject, e); }
    });
  }

  /** handler 返回可能是 [题,答]、[[题,答],…]、或直接一段文本 */
  function apiPairs(out) {
    if (out == null) return [];
    if (typeof out === 'string' || typeof out === 'number') return [[null, out]];
    if (!Array.isArray(out)) return [];
    // 单条 [题, 答]：答案可能是数字（填空题「7」）或布尔，不能只认字符串
    const scalar = (x) => x == null || typeof x === 'string'
      || typeof x === 'number' || typeof x === 'boolean';
    if (out.length === 2 && scalar(out[0]) && scalar(out[1])) return [[out[0], out[1]]];
    return out.filter((x) => Array.isArray(x) && x.length >= 2).map((x) => [x[0], x[1]]);
  }

  /** 多结果时挑和题干最像的那条 */
  function apiPick(pairs, title) {
    if (!pairs.length) return null;
    if (pairs.length === 1) {
      const a = pairs[0][1];
      return a == null || String(a).trim() === '' ? null : String(a).trim();
    }
    const t = normStem(title);
    const tb = bigrams(t);
    let best = null, bestS = -1;
    pairs.forEach((p) => {
      const a = p[1];
      if (a == null || String(a).trim() === '') return;
      const qk = p[0] == null ? t : normStem(String(p[0]));
      let s;
      if (!qk) s = 0.5;
      else if (qk === t) s = 1;
      else if (qk.indexOf(t) >= 0 || t.indexOf(qk) >= 0) s = 0.9;
      else {
        const kb = bigrams(qk);
        let inter = 0;
        tb.forEach((g) => { if (kb.has(g)) inter++; });
        s = (2 * inter) / (tb.size + kb.size || 1);
      }
      if (s > bestS) { bestS = s; best = String(a).trim(); }
    });
    return bestS >= 0.6 ? best : null;
  }

  function apiEnv(q) {
    return {
      title: q.title || '',
      type: API_TYPES[q.type] || 'single',
      options: (q.choices || []).map((c, i) => LETTERS[i] + '. ' + c.t).join('\n')
    };
  }

  async function apiAsk(q, deadline) {
    const list = apiConfigs();
    if (!list.length) return null;
    const env = apiEnv(q);
    for (let i = 0; i < list.length; i++) {
      if (deadline && Date.now() > deadline) return null;   // 整体超时，别再逐份硬等
      const c = list[i];
      const nm = c.name || c.url;
      try {
        const text = String(await apiSend(apiBuild(c, env))).replace(/^\uFEFF/, '');
        let res = text;
        if ((c.contentType || 'json') !== 'text') {
          try { res = JSON.parse(text); } catch (e) { throw new Error('返回的不是 JSON'); }
        }
        let fn = null;
        try { fn = new Function(String(c.handler))(); } catch (e) {
          throw new Error('handler 无法解析（页面 CSP 可能禁了 new Function）：' + (e.message || e));
        }
        // 兼容「直接写箭头函数没加 return」的配置
        if (fn === undefined) {
          try { fn = new Function('return (' + String(c.handler) + ')')(); } catch (e) { /* 忽略 */ }
        }
        const raw = apiPick(apiPairs(typeof fn === 'function' ? fn(res) : fn), q.title);
        if (raw) return { ans: cleanAns(raw), from: nm };
      } catch (e) {
        log('⚠️ 在线题库「' + nm + '」没取到答案：' + (e.message || e), 'warn');
      }
    }
    return null;
  }

  /** 并发查，最多 4 路，整体不超过 30 秒 */
  async function apiAskAll(qs, onHit) {
    const out = {};
    if (!qs.length || !apiConfigs().length) return out;
    const queue = qs.slice();
    const deadline = Date.now() + API_DEADLINE;
    const c = { stop: false };
    const worker = async () => {
      while (queue.length && !c.stop) {
        if (Date.now() > deadline) { c.stop = true; return; }
        const q = queue.shift();
        const r = await apiAsk(q, deadline);
        if (r) { out[q.n] = r.ans; if (onHit) onHit(q, r); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, qs.length) }, worker));
    return out;
  }

  /* =========================================================
   * 3.7 本地题库（Word .docx / txt / md，本地解析，文件不上传）
   *   docx 本质是个 zip：用 DecompressionStream 取出 word/document.xml，
   *   按段落还原成文本行，再按「题号 / 选项 / 答案：」的排版切题。
   *   存 GM 存储，答题时用 normStem + 二元组相似度匹配，和在线题库共用一套。
   * =======================================================*/
  const BANK_KEY = 'aah_bank_v1';               // { v: 版本戳, name: 来源文件, list: [[题干, 答案], …] }
  const BANK_MAX_BYTES = 4.5 * 1024 * 1024;     // 粗略上限，超了浏览器存储会失败
  let bankCache = null;

  const QNO_RE = /^\s*(?:\d{1,4}\s*[.、．)）](?!\d)|[（(]\s*\d{1,4}\s*[)）]|第\s*\d{1,4}\s*题)/;
  const OPT_RE = /^\s*[A-Ja-j]\s*[.、．)）:：]\s*\S/;
  const ANS_RE = /^\s*(?:参考|正确|标准|我的)?答案\s*[】\]]?\s*[:：]\s*(.*)$/;
  const ANS_BRK = /^\s*【\s*答案\s*】\s*[:：]?\s*(.*)$/;
  const SEC_RE = /^\s*(?:[一二三四五六七八九十]{1,3}\s*[、.．]|第\s*[一二三四五六七八九十]{1,3}\s*[部分章节])/;

  /** docx（zip）→ word/document.xml 文本 */
  async function docxXml(buf) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('这个浏览器不支持解压 docx（需要 Chrome / Edge 103+）。' +
        '可以先用 Word「另存为」纯文本再导入');
    }
    const b = buf instanceof ArrayBuffer ? buf : await new Response(buf).arrayBuffer();
    const dv = new DataView(b);
    const n = dv.byteLength;
    const dec = (bytes) => {
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return ''; }
    };
    // ① 从尾部找 ZIP 中央目录结尾（EOCD）
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('这不是有效的 docx（找不到 ZIP 目录），文件可能损坏或带密码');
    const cnt = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (cnt === 0xffff || p === 0xffffffff) {
      throw new Error('这个 docx 用了 ZIP64（通常是体积超大），暂不支持；另存为 txt 再导入');
    }
    // ② 遍历中央目录，找 word/document.xml
    let hit = null;
    for (let k = 0; k < cnt && p + 46 <= n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      if (dec(new Uint8Array(b, p + 46, nlen)) === 'word/document.xml') {
        hit = { method: method, csize: csize, lho: lho };
        break;
      }
      p += 46 + nlen + elen + clen;
    }
    if (!hit) throw new Error('docx 里没有 word/document.xml，可能不是 Word 文档');
    // ③ 读本地文件头算出正文起点
    const lnlen = dv.getUint16(hit.lho + 26, true);
    const lelen = dv.getUint16(hit.lho + 28, true);
    const start = hit.lho + 30 + lnlen + lelen;
    const data = new Uint8Array(b, start, Math.min(hit.csize || 0, n - start));
    if (hit.method === 0) return dec(data);
    if (hit.method !== 8) throw new Error('docx 用了不认识的压缩方式（method=' + hit.method + '）');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return dec(new Uint8Array(await new Response(stream).arrayBuffer()));
  }

  /** docx 的 XML → 文本行（按 w:p 段落拆，保留 w:br 换行） */
  function docxLines(xml) {
    let doc = null;
    try { doc = new DOMParser().parseFromString(String(xml), 'application/xml'); } catch (e) { doc = null; }
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const ps = doc ? doc.getElementsByTagNameNS(W, 'p') : null;
    if (!ps || !ps.length) {
      return String(xml).replace(/<[^>]*>/g, '\n').split(/\n+/)
        .map((s) => s.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
    }
    const walk = (node, acc) => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType !== 1) continue;
        const tag = c.localName || c.nodeName;
        if (tag === 't') acc.push(c.textContent);
        else if (tag === 'tab') acc.push('\t');
        else if (tag === 'br' || tag === 'cr') acc.push('\n');
        else if (tag === 'instrText' || tag === 'delText') continue;
        else walk(c, acc);
      }
    };
    const out = [];
    for (let i = 0; i < ps.length; i++) {
      const acc = [];
      walk(ps[i], acc);
      String(acc.join('')).split('\n').forEach((l) => {
        const t = l.replace(/\u00a0/g, ' ').trim();
        if (t) out.push(t);
      });
    }
    return out;
  }

  /**
   * 文本行 → [[题干, 答案], …]
   * 支持：①「1. 题干 / A. xx / 答案：C」 ②表格（题干、答案各一段）
   *      ③「1. 题干 答案：C」同一行  ④【答案】C / 正确答案：C
   */
  function parseBankText(input) {
    const lines = Array.isArray(input) ? input : String(input == null ? '' : input).split(/\r?\n/);
    const pairs = [];
    let cur = '';
    const add = (q, a) => {
      const qq = String(q == null ? '' : q).replace(/\s+/g, ' ').trim();
      const aa = cleanAns(a);
      if (qq.length >= 2 && aa) pairs.push([qq, aa]);
    };
    const push = (s) => {
      if (!s) return;
      if (!cur) { cur = s; return; }
      // 中文直接接上，西文补空格，避免「what is」拼成「whatis」
      cur += (/[\u4e00-\u9fa5]$/.test(cur) || /^[\u4e00-\u9fa5]/.test(s)) ? s : ' ' + s;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] == null ? '' : lines[i]).replace(/\u00a0/g, ' ').trim();
      if (!line) continue;
      // ① 答案行
      const am = line.match(ANS_RE) || line.match(ANS_BRK);
      if (am) {
        const a = cleanAns(am[1]);
        if (cur && a) add(cur, a);
        cur = '';
        continue;
      }
      // ② 选项行不进题干
      if (OPT_RE.test(line)) continue;
      // ③ 章节标题、页眉页脚、表格表头
      if (SEC_RE.test(line)) { cur = ''; continue; }
      if (/^\s*(?:第\s*\d+\s*页|共\s*\d+\s*页|得分|分值|总分|卷面)/.test(line)) continue;
      if (/^(?:序号|题号|编号|题目|题干|问题|答案|参考答案|正确答案|标准答案|选项|答案选项|题型|分值|难度|得分)$/.test(line)) continue;
      // ④ 题号行 → 开新题
      if (QNO_RE.test(line)) {
        const rest = line.replace(QNO_RE, '').trim();
        cur = '';
        const im = rest.match(/(?:参考|正确|标准)?答案\s*[:：]\s*(.+)$/);
        if (im) { add(rest.slice(0, im.index), im[1]); continue; }
        push(rest);
        continue;
      }
      // ⑤ 表格排版：题干后单独一段是纯答案
      if (cur && /^(?:[A-J]{1,6}|正确|错误|对|错|√|×|是|否|T|F)$/i.test(line)) {
        add(cur, line);
        cur = '';
        continue;
      }
      if (!cur && /^\d{1,4}$/.test(line)) continue;   // 表格里的「序号」列
      // ⑥ 其余都算上一题的续行
      push(line);
    }
    return pairs;
  }

  function bankData() {
    const d = GM_getValue(BANK_KEY, null);
    if (d && Array.isArray(d.list)) return d;
    return { v: 0, name: '', list: [] };
  }

  function bankSave(list, name) {
    const d = { v: Date.now(), name: name || '', list: list };
    let s = '';
    try { s = JSON.stringify(d); } catch (e) { throw new Error('题库内容无法保存'); }
    let bytes = s.length * 2;
    try { bytes = new Blob([s]).size; } catch (e) { /* 老环境按字符估 */ }
    if (bytes > BANK_MAX_BYTES) {
      throw new Error('题库太大（约 ' + (bytes / 1048576).toFixed(1) + ' MB），超出浏览器存储上限，请拆成多个文件分批导入');
    }
    GM_setValue(BANK_KEY, d);
    bankCache = null;
  }

  function bankIndex() {
    const d = bankData();
    if (bankCache && bankCache.v === d.v) return bankCache;
    const map = new Map();
    const arr = [];
    d.list.forEach((it) => {
      const q = Array.isArray(it) ? it[0] : (it && it.q);
      const a = Array.isArray(it) ? it[1] : (it && it.a);
      const k = normStem(q);
      if (!k || a == null || String(a).trim() === '' || map.has(k)) return;
      map.set(k, String(a));
      arr.push({ k: k, a: String(a), len: k.length });
    });
    bankCache = { v: d.v, map: map, arr: arr, name: d.name || '' };
    return bankCache;
  }

  /** 在本地题库里找答案，返回 { ans, s } 或 null */
  function bankFind(title) {
    const idx = bankIndex();
    if (!idx.arr.length) return null;
    const t = normStem(title);
    if (!t) return null;
    if (idx.map.has(t)) return { ans: idx.map.get(t), s: 1 };
    const tb = bigrams(t);
    let best = null, bestS = 0;
    const win = Math.max(4, Math.round(t.length * 0.4));
    for (let i = 0; i < idx.arr.length; i++) {
      const e = idx.arr[i];
      if (Math.abs(e.len - t.length) > win) continue;
      let s;
      if (e.k.indexOf(t) >= 0 || t.indexOf(e.k) >= 0) {
        const short = Math.min(e.len, t.length), long = Math.max(e.len, t.length);
        s = long && short / long >= 0.55 ? 0.9 : 0;
      } else {
        const kb = bigrams(e.k);
        let inter = 0;
        tb.forEach((g) => { if (kb.has(g)) inter++; });
        s = (2 * inter) / ((tb.size + kb.size) || 1);
      }
      if (s > bestS) { bestS = s; best = e; }
    }
    return best && bestS >= 0.75 ? { ans: best.a, s: bestS } : null;
  }

  /** 合并导入：同题干覆盖答案，其余追加 */
  function bankMerge(pairs, name) {
    const d = bankData();
    const old = new Map();
    d.list.forEach((it) => { if (Array.isArray(it)) old.set(normStem(it[0]), it); });
    let add = 0, upd = 0;
    pairs.forEach((pr) => {
      const k = normStem(pr[0]);
      if (!k) return;
      if (old.has(k)) {
        const it = old.get(k);
        if (String(it[1]) !== String(pr[1])) { it[1] = pr[1]; upd++; }
      } else { old.set(k, [pr[0], pr[1]]); add++; }
    });
    const list = Array.from(old.values());
    bankSave(list, name);
    return { add: add, upd: upd, total: list.length };
  }

  async function bankImportFile(file) {
    const nm = String(file.name || '文件');
    const low = nm.toLowerCase();
    let lines;
    if (/\.docx$/.test(low)) {
      lines = docxLines(await docxXml(await file.arrayBuffer()));
    } else if (/\.doc$/.test(low)) {
      throw new Error('老版 .doc 读不了：请在 Word 里「另存为」→ 选「Word 文档(*.docx)」再导入');
    } else if (/\.(txt|md|csv|text)$/.test(low) || low.indexOf('.') < 0) {
      lines = String(await file.text()).split(/\r?\n/);
    } else {
      throw new Error('只支持 .docx / .txt / .md，这个文件是「' + nm.split('.').pop() + '」');
    }
    const pairs = parseBankText(lines);
    if (!pairs.length) {
      throw new Error('没从「' + nm + '」里解析出题目：请确认每道题后面跟着一行「答案：X」' +
        '（答案：/ 正确答案：/ 【答案】 都认）');
    }
    return bankMerge(pairs, nm);
  }

  /* =========================================================
   * 4. Adapter 注册表
   * 每个 adapter 需要：
   *   id / name
   *   detect(): boolean | Promise<boolean>   是否接管当前页面
   *   collect(): Promise<Question[]>         抓题
   *   apply(qs, map): Promise<{ok, miss}>    填写
   * 可选：
   *   submit(): Promise<void>                页面上的「提交/评测」动作（默认不自动调用）
   * Question = { n, type, title, kind:'choice'|'fill', choices:[{t, el}] }
   * =======================================================*/
  const ADAPTERS = [];

  /* ---------------------------------------------------------
   * 4.1 头歌 / Educoder 类实训关卡
   * -------------------------------------------------------*/
  const tougeAdapter = {
    id: 'touge',
    name: '头歌类实训关卡',

    detect() {
      return $$('ul.choose-container > li').length >= 1;
    },

    _stem(li) {
      const c = li.cloneNode(true);
      $$('label,textarea,input,button,select,script,style,svg', c).forEach((e) => e.remove());
      c.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(c);
      const t = c.innerText || c.textContent || '';
      c.remove();
      return t.replace(/\s+/g, ' ')
        .replace(/^\s*\d+\s*[.、．]\s*/, '')
        .replace(/^\s*(单选|多选|判断|填空|简答)题\s*[:：]\s*/, '')
        .trim();
    },

    async collect() {
      const lis = $$('ul.choose-container > li');
      return lis.map((li, i) => {
        const labels = $$('label.ant-radio-wrapper, label.ant-checkbox-wrapper', li);
        const tas = $$('textarea', li);
        const isFill = !labels.length && tas.length > 0;
        return {
          n: i + 1,
          kind: isFill ? 'fill' : 'choice',
          multi: !!li.querySelector('input[type=checkbox]'),
          type: isFill ? 'fill_blank'
            : (labels.length === 2 && /^(正确|错误)$/.test((labels[1].innerText || '').trim())
              ? 'judgement' : 'single_choice'),
          title: this._stem(li),
          choices: labels.map((l) => ({
            el: l,
            t: (l.innerText || '').trim().replace(/^[A-J]\s*[.、．)）]\s*/, '')
          })),
          _li: li
        };
      });
    },

    async apply(qs, map) {
      let ok = 0; const miss = [];
      qs.forEach((q) => {
        const a = map[q.n];
        if (!a) { miss.push(q.n); return; }
        if (q.kind === 'fill') {
          const tas = $$('textarea', q._li);
          const parts = String(a).split('|');
          tas.forEach((t, i) => setNativeValue(t, (parts[i] != null ? parts[i] : parts[0] || '').trim()));
          ok++;
        } else {
          const idx = resolveIdx(q.choices, a);
          if (!idx.length) { miss.push(q.n); return; }
          (q.multi ? idx : idx.slice(0, 1)).forEach((i) => q.choices[i].el.click());
          ok++;
        }
      });
      return { ok: ok, miss: miss };
    },

    async submit() {
      const btn = $$('b,button,div,span,a').find((e) => !e.children.length && (e.innerText || '').trim() === '评测');
      if (!btn) throw new Error('没找到「评测」按钮');
      btn.click();
    }
  };
  ADAPTERS.push(tougeAdapter);

  /* ---------------------------------------------------------
   * 4.2 超星 / 学习通类：试卷接口模式
   *     路径形如 /{任意前缀}/exercise/{id}[/users/{账号}]
   *     start.json 与答题接口同源，前缀（如 WebVPN 网关）自动继承
   * -------------------------------------------------------*/
  const cxAdapter = {
    id: 'cx-api',
    name: '作业试卷接口（整卷）',
    _paper: null,

    /**
     * 所有可能的整卷接口地址，页面自己发过的排前面。
     * 关键是「哪个能用得试过才知道」——WebVPN 之类网关的接口对参数极敏感，
     * 少一个 coursesId 就返回登录页 HTML（HTTP 照样 200），拼是拼不出来的。
     */
    _cands() {
      if (this._candList) return this._candList;
      const out = []; const seen = new Set();
      const push = (o) => { if (o.url && !seen.has(o.url)) { seen.add(o.url); out.push(o); } };
      let urls = [];
      try { urls = performance.getEntriesByType('resource').map((e) => e.name); } catch (e) { /* 老浏览器 */ }
      // 页面调过的试卷类接口：/api/exercises/{id}/xxx.json（个别版本带 /v2/ 这类前缀）
      const RE = /^(.*?)\/api\/(?:v\d+\/)?exercises\/(\d+)\/([^?#]*\.json)(\?[^#]*)?/;
      const hits = [];
      urls.forEach((u) => {
        const mm = String(u).match(RE);
        if (mm) hits.push({ url: u, prefix: mm[1] || '', id: mm[2], tail: mm[3], query: mm[4] || '' });
      });
      // ① 页面自己请求过 start.json：原样复用，token / coursesId 一个不差
      hits.forEach((h) => {
        if (h.tail !== 'start.json') return;
        push({ url: h.url, prefix: h.prefix, id: h.id, user: '', query: h.query, real: true });
      });
      // ② 只调过同组的别的接口（get_exercise_user_info 之类）：拿它的前缀和参数改写
      //    这一条很关键——有些版本根本不请求 start.json，但参数规格是同一套
      hits.forEach((h) => {
        if (h.tail === 'start.json') return;
        const b = { prefix: h.prefix, id: h.id, user: '', query: h.query, real: false };
        b.url = b.prefix + '/api/exercises/' + b.id + '/start.json' + h.query;
        push(b);
      });
      // ③ 实在没记录：从地址里解析，自己拼参数，最后兜底
      const m = location.pathname.match(/^(.*?)\/exercise\/(\d+)(?:\/users\/([^/?#]+))?/);
      if (m) {
        const b = { prefix: m[1] || '', id: m[2], user: m[3] || '', query: '', real: false };
        b.url = b.prefix + '/api/exercises/' + b.id + '/start.json' + this._q(b);
        push(b);
      }
      this._candList = out;
      return out;
    },

    _ctx(reset) {
      if (reset) { this._res = null; this._win = null; this._candList = null; }
      if (this._res) return this._res;
      const list = this._cands();
      this._res = list[0] || null;
      return this._res;
    },

    _q(c) {
      c = c || this._ctx();
      if (c && c.query) return c.query; // 反查来的请求本身已带 token
      const qs = [];
      const all = [location.search, location.href]
        .concat(performance.getEntriesByType('resource').map((e) => e.name)).join(' ');
      const vpn = all.match(/vpn-\d+-[\d.]+/);
      if (vpn) qs.push(vpn[0]); // WebVPN 网关的裸参数名
      if (c && c.user) qs.push('login=' + encodeURIComponent(c.user), 'zzud=' + encodeURIComponent(c.user));
      return qs.length ? '?' + qs.join('&') : '';
    },

    /** 已经试出来的那条可用地址；还没试出来时退回第一候选 */
    _base() {
      return this._win || this._ctx();
    },

    _url(path) {
      const c = this._base();
      if (!c) return null;
      return c.prefix + path + (c.query || this._q(c));
    },

    /** 试一条地址：返回试卷对象，失败返回 null 并把原因记到 _errs */
    async _tryOne(c, errs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      let r, txt;
      try {
        r = await fetch(c.url, {
          credentials: 'include',
          headers: { Accept: 'application/json, text/plain, */*' },
          signal: ctrl.signal
        });
        txt = await r.text();
      } catch (e) {
        clearTimeout(timer);
        errs.push(e.name === 'AbortError' ? '超时(12s)' : ('网络失败 ' + e.message));
        return null;
      }
      clearTimeout(timer);
      if (!r.ok) { errs.push('HTTP ' + r.status); return null; }
      let j = null;
      try { j = JSON.parse(txt.replace(/^\uFEFF/, '')); } catch (e) { /* 下面记原因 */ }
      if (!j) {
        const ct = r.headers.get('content-type') || '无 content-type';
        const head = txt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
        errs.push('不是 JSON（' + ct + '）：' + (head || '空响应'));
        return null;
      }
      if (!Array.isArray(j.exercise_question_types)) { errs.push('缺 exercise_question_types'); return null; }
      return j;
    },

    /**
     * 拉整卷：候选地址挨个试，第一个能给出合法试卷的就是它。
     * 这样网关少参数返回登录页、CDN 回旧页之类的情况都能自动绕过。
     */
    async _loadPaper(report) {
      const list = this._cands();
      if (!list.length) {
        if (report) this._why = '页面地址和网络记录里都没有 /api/exercises/{id}/start.json 的痕迹';
        return null;
      }
      const errs = [];
      for (const c of list) {
        const j = await this._tryOne(c, errs);
        if (j) { this._win = c; this._paper = j; return j; }
      }
      if (report) {
        this._why = '试了 ' + list.length + ' 条地址都不行 → ' + errs.slice(0, 2).join(' / ');
      }
      return null;
    },

    async detect() {
      this._ctx(true); // 每次重新扫一遍网络记录
      const list = this._cands();
      if (!list.length) {
        this._why = '页面地址和网络记录里都没有 /api/exercises/{id}/start.json 的痕迹';
        return false;
      }
      // SPA 在同一个文档里换卷子（考试 → 考试、作业 → 考试）时，缓存的旧卷必须丢掉
      if (this._pid !== list[0].id) {
        this._pid = list[0].id;
        this._paper = null;
        this._win = null;
      }
      try {
        return !!(await this._loadPaper(true));
      } catch (e) {
        this._why = '拉试卷失败：' + e.message;
        return false;
      }
    },

    async collect() {
      let data = this._paper;
      const cur = this._base();
      // 卷子 id 对不上就重拉，别把上一份卷子的题当成这一份
      if (data && cur && data.exercise && String(data.exercise.id) !== String(cur.id)) data = null;
      if (!data) data = await this._loadPaper(false);
      if (!data) throw new Error('拉整卷接口失败，看日志里的「没接管的原因」');
      const out = [];
      (data.exercise_question_types || []).forEach((g) => {
        (g.items || []).forEach((it) => {
          out.push({
            n: it.question_num,
            _id: it.question_id,
            type: g.question_type,
            title: it.question_title,
            kind: (it.question_choices && it.question_choices.length) ? 'choice' : 'fill',
            choices: (it.question_choices || []).map((ch) => ({ id: ch.choice_id, t: ch.choice_text }))
          });
        });
      });
      return out;
    },

    async apply(qs, map) {
      let ok = 0; const miss = []; const errs = [];
      for (const q of qs) {
        const a = map[q.n];
        if (!a) { miss.push(q.n); continue; }
        const url = this._url('/api/exercise_questions/' + q._id + '/exercise_answers.json');
        const put = async (choiceId, text) => {
          const r = await fetch(url, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionId: q._id, exercise_choice_id: choiceId, answer_text: text })
          });
          const t = await r.text();
          if (!/"status"\s*:\s*0/.test(t)) throw new Error('第 ' + q.n + ' 题：' + t.slice(0, 80));
        };
        try {
          if (q.choices.length) {
            const idx = resolveIdx(q.choices, a);
            if (!idx.length) { miss.push(q.n); continue; }
            for (const i of idx) await put(q.choices[i].id, null);
          } else {
            const parts = String(a).split('|');
            for (let i = 0; i < parts.length; i++) await put(i + 1, parts[i].trim());
          }
          ok++;
        } catch (e) { errs.push(e.message); }
      }
      if (errs.length) log('⚠️ ' + errs.slice(0, 3).join('；'), 'warn');
      return { ok: ok, miss: miss };
    }
  };
  ADAPTERS.push(cxAdapter);

  /* ---------------------------------------------------------
   * 4.3 通用启发式：没有专属 adapter 时兜底
   * -------------------------------------------------------*/
  const genericAdapter = {
    id: 'generic',
    name: '通用页面（启发式）',
    _qs: null,

    _scan() {
      const inputs = $$('input[type=radio],input[type=checkbox]');
      const used = new Set();
      const groups = [];

      inputs.forEach((inp) => {
        if (used.has(inp)) return;
        let peers = [];
        if (inp.name) {
          peers = inputs.filter((x) => x.name === inp.name && x.type === inp.type);
        } else {
          let el = inp.parentElement, guard = 0;
          while (el && guard++ < 8) {
            const inside = inputs.filter((x) => el.contains(x));
            if (inside.length >= 2) { peers = inside; break; }
            el = el.parentElement;
          }
        }
        if (peers.length < 2) return;
        peers.forEach((x) => used.add(x));
        groups.push(peers);
      });

      groups.sort((a, b) => (a[0].compareDocumentPosition(b[0]) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

      const qs = groups.map((peers, i) => {
        const choices = peers.map((inp) => {
          const lab = inp.closest('label');
          const wrap = lab || inp.parentElement || inp;
          let t = (wrap.innerText || wrap.textContent || '').replace(/\s+/g, ' ').trim();
          t = t.replace(/^[A-J]\s*[.、．)）]\s*/, '');
          return { el: lab || inp, t: t, input: inp };
        });
        const two = choices.length === 2 && /^(正确|错误|对|错|true|false)$/i.test(choices[1].t);
        return {
          n: i + 1,
          kind: 'choice',
          multi: peers[0].type === 'checkbox',
          type: two ? 'judgement' : (peers[0].type === 'checkbox' ? 'multiple_choice' : 'single_choice'),
          title: this._stem(peers, choices.map((c) => c.t)),
          choices: choices
        };
      });

      // 填空题：独立 textarea（排除搜索/评论类）
      const inGroup = new Set(groups.flat());
      $$('textarea').forEach((ta) => {
        if (ta.closest('ul.choose-container')) return;
        if (inGroup.has(ta)) return;
        const hint = [ta.placeholder, ta.getAttribute('aria-label'), ta.name, ta.id].join(' ');
        if (/搜索|评论|留言|回复|message|comment|search/i.test(hint)) return;
        if (!ta.offsetParent && ta.offsetHeight === 0) return;
        qs.push({
          n: qs.length + 1, kind: 'fill', type: 'fill_blank',
          title: this._stem([ta], []),
          choices: [], _el: ta
        });
      });

      // 按页面上的实际顺序重排 + 重新编号（选择题和填空题可能交错出现）
      const anchor = (q) => {
        const e = q._el || (q.choices && q.choices[0] && (q.choices[0].input || q.choices[0].el));
        return e || null;
      };
      qs.sort((a, b) => {
        const x = anchor(a), y = anchor(b);
        if (!x || !y) return 0;
        return (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
      });
      qs.forEach((q, i) => { q.n = i + 1; });

      return qs;
    },

    _stem(elems, optTexts) {
      // 找到包含全部控件的最近公共容器，克隆后把选项/输入框整段删掉，剩下的就是题干
      let el = elems[0].parentElement;
      let box = el;
      for (let i = 0; i < 6 && el; i++) {
        if (elems.every((e) => el.contains(e))) box = el;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > 24) break;
        el = el.parentElement;
      }
      const c = box.cloneNode(true);
      $$('label,input,textarea,button,select,script,style,svg', c).forEach((n) => n.remove());
      c.style.cssText = 'position:fixed;left:-9999px;top:0;width:600px;white-space:normal;';
      document.body.appendChild(c);
      let text = c.innerText || c.textContent || '';
      c.remove();
      text = text.replace(/\s+/g, ' ').trim();
      (optTexts || []).forEach((o) => { if (o) text = text.split(o).join(' '); });
      // 清掉没有 label 包裹时残留的 “A.” “B、” 之类字母标记
      text = text.replace(/(^|\s)[A-J]\s*[.、．)）]\s*/g, ' ');
      return text.replace(/\s+/g, ' ').trim().slice(0, 400);
    },

    detect() {
      this._qs = this._scan();
      return this._qs.length >= Math.max(1, Number(cfg.minQ) || 2);
    },

    async collect() {
      this._qs = this._scan();
      return this._qs;
    },

    async apply(qs, map) {
      let ok = 0; const miss = [];
      qs.forEach((q) => {
        const a = map[q.n];
        if (!a) { miss.push(q.n); return; }
        if (q.kind === 'fill') {
          setNativeValue(q._el, String(a).trim());
          ok++;
        } else {
          const idx = resolveIdx(q.choices, a);
          if (!idx.length) { miss.push(q.n); return; }
          (q.multi ? idx : idx.slice(0, 1)).forEach((i) => q.choices[i].el.click());
          ok++;
        }
      });
      return { ok: ok, miss: miss };
    }
  };
  ADAPTERS.push(genericAdapter);

  /* =========================================================
   * 5. 选择 adapter
   * =======================================================*/
  let current = null;

  async function pickAdapter(force) {
    if (current && !force) return current;
    current = null;
    setDot('…');
    const why = [];
    for (const a of ADAPTERS) {
      try {
        if (await a.detect()) { current = a; break; }
        if (a._why) { why.push(a.name + '：' + a._why); a._why = ''; }
      } catch (e) { why.push(a.name + '：' + e.message); }
    }
    setDot(current ? '●' : '·');
    if (box) {
      const el = $('#aah-adapter', box);
      if (el) el.textContent = current ? current.name : '未识别';
    }
    if (!current && why.length) log('没接管的原因 → ' + why.join(' ｜ '), 'warn');
    return current;
  }

  /* =========================================================
   * 6. 主流程
   * =======================================================*/
  let busy = false;
  let lastRun = { kind: '', at: 0 };

  async function doAnswer() {
    const ad = await pickAdapter();
    if (!ad) throw new Error('当前页面没识别出题目（可在设置里调低「最少题数」，或改用「导出题目」）');
    const qs = await ad.collect();
    if (!qs.length) throw new Error('抓到 0 道题');
    log('识别为：' + ad.name + '，共 ' + qs.length + ' 题');

    // 1) 本地题库（Word / 文本导入的，纯本地查表，不耗时）
    const map = {};
    let rest = qs;
    if (cfg.bankLocalOn !== false && bankIndex().arr.length) {
      setStat('共 ' + qs.length + ' 题，查本地题库…');
      const locHit = [];
      qs.forEach((q) => {
        const r = bankFind(q.title);
        if (r) { map[q.n] = r.ans; locHit.push(q.n); }
      });
      if (locHit.length) log('📄 本地题库命中 ' + locHit.length + ' 题：' + locHit.join(','));
      rest = qs.filter((q) => !map[q.n]);
      if (!rest.length) log('✅ 全部命中本地题库，本轮未调用 AI');
    }

    // 2) 在线题库接口（OCS 配置）
    if (rest.length && cfg.bankApiOn !== false && apiConfigs().length) {
      setStat('还剩 ' + rest.length + ' 题，查在线题库接口…');
      const apiHit = [];
      const apiMap = await apiAskAll(rest, (q) => apiHit.push(q.n));
      if (apiHit.length) {
        apiHit.forEach((n) => { map[n] = apiMap[n]; });
        log('🌐 在线题库命中 ' + apiHit.length + ' 题：' + apiHit.join(','));
      }
      rest = rest.filter((q) => !apiMap[q.n]);
      if (!rest.length) log('✅ 剩下的全部命中在线题库，本轮未调用 AI');
    }

    // 3) 还没命中的才请求 AI
    let aiErr = null;
    if (rest.length) {
      setStat('题库命中 ' + (qs.length - rest.length) + ' 题，AI 作答 ' + rest.length + ' 题…');
      try {
        const aiMap = await askAI(rest, setStat);
        Object.assign(map, aiMap);
      } catch (e) { aiErr = e; }
    }
    if (aiErr && !Object.keys(map).length) throw aiErr;

    // 4) 回填
    setStat('正在填入…');
    const r = await ad.apply(qs, map);
    if (aiErr) log('⚠️ AI 出错（题库部分已填）：' + (aiErr.message || aiErr), 'warn');
    setStat('已填 ' + r.ok + '/' + qs.length + ' 题' + (aiErr ? '，部分题缺答案' : ''));
    log('✅ 已填 ' + r.ok + '/' + qs.length + ' 题' + (r.miss.length ? '，缺答案：' + r.miss.join(',') : ''));
    return r;
  }

  async function doExport() {
    const ad = await pickAdapter();
    if (!ad) throw new Error('当前页面没识别出题目');
    const qs = await ad.collect();
    if (!qs.length) throw new Error('抓到 0 道题');
    const lines = [
      '下面是一份作业，共 ' + qs.length + ' 题。请直接给答案，格式为一行一个：题号: 答案',
      '（单选写字母，多选写字母逗号分隔，填空写文字，多个空用 | 分隔）', ''
    ];
    qs.forEach((q) => {
      lines.push('[' + q.n + ']（' + (TYPE_CN[q.type] || '单选题') + '）' + q.title);
      (q.choices || []).forEach((c, i) => lines.push('   ' + LETTERS[i] + '. ' + c.t));
    });
    const text = lines.join('\n');
    try { GM_setClipboard(text, 'text'); log('✅ 题目已复制（' + qs.length + ' 题），粘给任意 AI 即可'); }
    catch (e) { log('复制失败，请从弹窗手动复制', 'warn'); }
    showModal('已复制题目', '<textarea style="width:100%;height:280px;font:12px/1.5 Consolas,monospace">' +
      text.replace(/</g, '&lt;') + '</textarea>', [{ t: '关闭', f: closeModal }]);
  }

  function parseAnswerText(text) {
    const map = {};
    const j = extractJson(text);
    if (j && typeof j === 'object') {
      Object.keys(j).forEach((k) => { map[String(k).trim()] = String(j[k]).trim(); });
      if (Object.keys(map).length) return map;
    }
    String(text).split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*\[?(\d{1,3})\]?\s*[:：.、)]\s*(.+?)\s*$/);
      if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    });
    return map;
  }

  async function doImport(text) {
    const map = parseAnswerText(text);
    if (!Object.keys(map).length) throw new Error('没解析出答案，格式应为 1: B 或 JSON');
    const ad = await pickAdapter();
    if (!ad) throw new Error('当前页面没识别出题目');
    const qs = await ad.collect();
    const r = await ad.apply(qs, map);
    setStat('已回填 ' + r.ok + '/' + qs.length);
    log('✅ 已回填 ' + r.ok + ' 题' + (r.miss.length ? '，缺：' + r.miss.join(',') : ''));
  }

  /* =========================================================
   * 7. UI
   * =======================================================*/
  const CSS = `
#aah-dot{position:fixed;right:18px;bottom:22px;width:44px;height:44px;border-radius:50%;z-index:2147483000;
  display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;
  background:linear-gradient(135deg,#4f7cff,#7a5cff);color:#fff;font:600 13px/1 -apple-system,"Microsoft YaHei",sans-serif;
  box-shadow:0 6px 18px rgba(79,124,255,.42);transition:transform .15s,opacity .15s}
#aah-dot:hover{transform:scale(1.06)}
#aah-dot.idle{opacity:.45;box-shadow:0 4px 12px rgba(0,0,0,.16);background:#9aa4b2}
#aah-box{position:fixed;right:18px;bottom:76px;width:312px;z-index:2147483001;display:none;
  font:13px/1.65 -apple-system,"Microsoft YaHei",sans-serif;background:#fff;color:#1f2328;
  border:1px solid #e3e6ea;border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.16);overflow:hidden}
#aah-box.on{display:block}
#aah-box *{box-sizing:border-box}
#aah-box .hd{display:flex;align-items:center;gap:6px;padding:9px 12px;background:#f6f8fa;border-bottom:1px solid #eaecef;cursor:move;user-select:none}
#aah-box .hd b{font-size:13px}
#aah-box .hd .tag{margin-left:auto;font-size:11px;color:#57606a;background:#eaeef2;border-radius:20px;padding:1px 8px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#aah-box .bd{padding:10px 12px 12px}
#aah-box .stat{font-size:12px;color:#57606a;min-height:18px;margin-bottom:8px;word-break:break-all}
#aah-box .row{display:flex;gap:8px;margin-bottom:8px}
#aah-box button{flex:1;cursor:pointer;border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;border-radius:8px;
  padding:7px 6px;font:12px/1.2 inherit;transition:.15s}
#aah-box button:hover{background:#eef1f4;border-color:#b9c0c8}
#aah-box button:active{transform:translateY(1px)}
#aah-box button.main{background:#4f7cff;border-color:#4f7cff;color:#fff;font-weight:600}
#aah-box button.main:hover{background:#3f6ce8}
#aah-box button.ghost{background:#fff}
#aah-box .log{margin-top:9px;max-height:104px;overflow:auto;border-top:1px dashed #e3e6ea;padding-top:7px;font-size:11.5px;color:#57606a}
#aah-box .log div{padding:1px 0;word-break:break-all}
#aah-box .log .warn{color:#bf8700}
#aah-box .log .err{color:#cf222e}
#aah-box .cap{font-size:11px;color:#8b949e;margin-top:8px;line-height:1.5}
#aah-mask{position:fixed;inset:0;background:rgba(15,20,25,.42);z-index:2147483002;display:flex;align-items:center;justify-content:center}
#aah-modal{width:520px;max-width:92vw;max-height:86vh;overflow:auto;background:#fff;border-radius:12px;padding:18px 20px;
  font:13px/1.7 -apple-system,"Microsoft YaHei",sans-serif;color:#1f2328;box-shadow:0 20px 50px rgba(0,0,0,.25)}
#aah-modal h3{margin:0 0 12px;font-size:15px}
#aah-modal label{display:block;font-size:12px;color:#57606a;margin:9px 0 3px}
#aah-modal input,#aah-modal select{width:100%;padding:6px 9px;border:1px solid #d0d7de;border-radius:7px;
  font:12.5px/1.4 Consolas,"Microsoft YaHei",monospace;background:#fff;color:#1f2328}
#aah-modal .btns{display:flex;gap:8px;margin-top:15px;justify-content:flex-end}
#aah-modal .btns button{flex:0 0 auto;min-width:76px}
`;

  let box, dot, statEl, logEl;

  function buildUI() {
    GM_addStyle(CSS);

    dot = document.createElement('div');
    dot.id = 'aah-dot';
    dot.textContent = 'AI';
    dot.title = 'AI 答题助手';
    dot.className = 'idle';
    document.body.appendChild(dot);

    box = document.createElement('div');
    box.id = 'aah-box';
    box.innerHTML =
      '<div class="hd"><b>AI 答题助手</b><span class="tag" id="aah-adapter">检测中…</span></div>' +
      '<div class="bd">' +
      '<div class="stat" id="aah-stat">就绪</div>' +
      '<div class="row"><button class="main" id="aah-run">一键作答</button></div>' +
      '<div class="row"><button class="ghost" id="aah-exp">导出题目</button><button class="ghost" id="aah-imp">导入答案</button></div>' +
      '<div class="row"><button class="ghost" id="aah-detect">重新检测</button><button class="ghost" id="aah-submit" style="display:none">提交</button></div>' +
      '<div class="row"><button class="ghost" id="aah-bank">题库</button><button class="ghost" id="aah-cfg">设置</button></div>' +
      '<div class="log" id="aah-log"></div>' +
      '<div class="cap">只负责填答案；「提交 / 交卷」请自行确认。</div>' +
      '</div>';
    document.body.appendChild(box);

    statEl = $('#aah-stat', box);
    logEl = $('#aah-log', box);

    dot.addEventListener('click', () => box.classList.toggle('on'));
    $('#aah-run', box).onclick = () => run('answer');
    $('#aah-exp', box).onclick = () => run('export');
    $('#aah-imp', box).onclick = openImport;
    $('#aah-detect', box).onclick = async () => { setStat('重新检测…'); await pickAdapter(true); setStat(current ? '已识别：' + current.name : '没识别出题目'); };
    $('#aah-submit', box).onclick = () => run('submit');
    $('#aah-bank', box).onclick = openBank;
    $('#aah-cfg', box).onclick = openSettings;

    makeDraggable(box, $('.hd', box));
  }

  function setDot(t) { if (dot) dot.textContent = t; }
  function setStat(s) { if (statEl) statEl.textContent = s; }
  function log(s, cls) {
    if (!logEl) return;
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = new Date().toTimeString().slice(0, 5) + ' ' + s;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 40) logEl.removeChild(logEl.firstChild);
  }

  async function run(kind) {
    if (busy) { log('正在执行，请稍等…', 'warn'); return; }
    const now = Date.now();
    if (kind === lastRun.kind && now - lastRun.at < 1200) return;
    lastRun = { kind: kind, at: now };
    busy = true;
    try {
      if (kind === 'answer') await doAnswer();
      else if (kind === 'export') await doExport();
      else if (kind === 'submit') {
        const ad = await pickAdapter();
        if (!ad || !ad.submit) throw new Error('当前页面不支持提交');
        await ad.submit();
        log('已触发页面提交/评测');
      }
    } catch (e) {
      const m = (e && e.message) || String(e);
      setStat('出错了：' + m);
      log('❌ ' + m, 'err');
    } finally {
      busy = false;
    }
  }

  /* ---------- 弹窗 ---------- */
  function showModal(title, bodyHtml, buttons) {
    closeModal();
    const mask = document.createElement('div');
    mask.id = 'aah-mask';
    const m = document.createElement('div');
    m.id = 'aah-modal';
    m.innerHTML = '<h3>' + title + '</h3>' + bodyHtml + '<div class="btns"></div>';
    mask.appendChild(m);
    document.body.appendChild(mask);
    const btns = $('.btns', m);
    (buttons || [{ t: '关闭', f: closeModal }]).forEach((b) => {
      const el = document.createElement('button');
      el.textContent = b.t;
      if (b.main) { el.style.background = '#4f7cff'; el.style.color = '#fff'; el.style.borderColor = '#4f7cff'; }
      el.onclick = () => { if (!b.f || b.f() !== false) closeModal(); };
      btns.appendChild(el);
    });
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    return m;
  }
  function closeModal() { const e = $('#aah-mask'); if (e) e.remove(); }

  function openImport() {
    showModal('导入答案',
      '<div style="font-size:12px;color:#57606a;margin-bottom:6px">支持两种格式：一行一个 <code>1: B</code>，或 JSON <code>{"1":"B","2":"A"}</code></div>' +
      '<textarea id="aah-imp-t" style="width:100%;height:220px;font:12px/1.5 Consolas,monospace;padding:8px;border:1px solid #d0d7de;border-radius:8px"></textarea>',
      [{
        t: '填入', main: true, f: () => {
          const v = $('#aah-imp-t').value;
          if (v.trim()) {
            setStat('回填中…');
            doImport(v).catch((e) => { log('❌ ' + e.message, 'err'); setStat('导入失败'); });
          }
          return true;
        }
      }, { t: '取消', f: closeModal }]);
    setTimeout(() => { const t = $('#aah-imp-t'); if (t) t.focus(); }, 50);
  }

  /* ---------- 题库接口（OCS 配置） ---------- */
  function openBank() {
    const bk = bankIndex();
    const bkInfo = bk.arr.length
      ? '已导入 <b>' + bk.arr.length + '</b> 题' + (bk.name ? '（' + esc(bk.name) + '）' : '')
      : '还没有本地题库';
    const m = showModal('题库',
      '<div style="font-size:12.5px;font-weight:600;margin-bottom:4px">📄 本地题库（Word / 文本）</div>' +
      '<div style="font-size:11.5px;color:#8b949e;line-height:1.7;margin-bottom:8px">' +
        '选一个 <code>.docx</code> / <code>.txt</code> / <code>.md</code> 文件，在本地解析后存进浏览器 —— <b>文件不会上传</b>。<br>' +
        '排版要求：每道题后面跟一行 <code>答案：C</code>（<code>正确答案：</code>、<code>【答案】C</code> 也认）。' +
        '重复导入是<b>合并</b>：同题干的答案会被新文件覆盖，其余保留。</div>' +
      '<div id="aah-bk-locinfo" style="font-size:12px;color:#1a7f37;margin-bottom:8px">' + bkInfo + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<button id="aah-bk-pick" style="padding:5px 12px;border:1px solid #d0d7de;background:#f6f8fa;border-radius:7px;cursor:pointer;font-size:12px">选择文件导入</button>' +
        '<button id="aah-bk-locdel" style="padding:5px 12px;border:1px solid #d0d7de;background:#f6f8fa;border-radius:7px;cursor:pointer;font-size:12px">清空本地题库</button>' +
        '<input id="aah-bk-file" type="file" accept=".docx,.txt,.md" style="display:none">' +
      '</div>' +
      '<label style="margin-top:10px"><input id="aah-bk-locon" type="checkbox" style="width:auto;margin-right:6px"' + (cfg.bankLocalOn !== false ? ' checked' : '') + '>答题前先查本地题库</label>' +
      '<div id="aah-bk-locmsg" style="margin-top:6px;font-size:12px;color:#57606a;min-height:17px;word-break:break-all"></div>' +
      '<hr style="border:0;border-top:1px solid #eaeef2;margin:14px 0">' +
      '<div style="font-size:12.5px;font-weight:600;margin-bottom:4px">🌐 在线题库接口（可选）</div>' +
      '<div style="font-size:11.5px;color:#8b949e;line-height:1.7;margin-bottom:8px">' +
        '把 <b>OCS / 言溪那套题库配置</b> 整个粘进来即可（就是 <code>[{"url":…,"handler":…}]</code> 那段 JSON）。' +
        '多份配置用 <code>####</code> 隔开。<br>' +
        '可用占位符：<code>${title}</code> 题干、<code>${options}</code> 选项（<code>A. xxx\\nB. xxx</code> 换行拼接）、<code>${type}</code> 题型（single / multiple / judgement / completion）。<br>' +
        '顺序：<b>本地题库 → 在线接口 → AI</b>，前面命中的题不会再去问 AI。</div>' +
      '<textarea id="aah-bk-api" spellcheck="false" placeholder=\'[{"name":"我的题库","url":"https://example.com/search","method":"post","contentType":"json","headers":{"Content-Type":"application/json"},"data":{"question":"${title}","options":"${options}","type":"${type}"},"handler":"return (res)=> res.code === 200 ? [res.question,res.answer] : undefined"}]\'' +
        ' style="width:100%;height:190px;font:12px/1.5 Consolas,monospace;padding:8px;border:1px solid #d0d7de;border-radius:8px"></textarea>' +
      '<label style="margin-top:10px"><input id="aah-bk-apion" type="checkbox" style="width:auto;margin-right:6px">启用题库接口（关了就直接用 AI）</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">' +
        '<button id="aah-bk-apisave" style="padding:5px 12px;border:1px solid #d0d7de;background:#f6f8fa;border-radius:7px;cursor:pointer;font-size:12px">保存</button>' +
        '<button id="aah-bk-apitest" style="padding:5px 12px;border:1px solid #d0d7de;background:#f6f8fa;border-radius:7px;cursor:pointer;font-size:12px">测试一下</button>' +
        '<button id="aah-bk-apiclear" style="padding:5px 12px;border:1px solid #d0d7de;background:#f6f8fa;border-radius:7px;cursor:pointer;font-size:12px">清空</button>' +
      '</div>' +
      '<div id="aah-bk-apimsg" style="margin-top:8px;font-size:12px;color:#57606a;min-height:17px;word-break:break-all"></div>',
      [{ t: '关闭', f: closeModal }]);

    const ta = $('#aah-bk-api', m);
    const on = $('#aah-bk-apion', m);
    const msg = (t, isErr) => {
      const el = $('#aah-bk-apimsg', m);
      if (!el) return;
      el.style.color = isErr ? '#cf222e' : '#1a7f37';
      el.textContent = t;
    };
    if (ta) ta.value = cfg.bankApi || '';
    if (on) on.checked = cfg.bankApiOn !== false;

    /* ---- 本地题库（Word / 文本） ---- */
    const locInfo = $('#aah-bk-locinfo', m);
    const locMsgEl = $('#aah-bk-locmsg', m);
    const locMsg = (t, isErr) => {
      if (!locMsgEl) return;
      locMsgEl.style.color = isErr ? '#cf222e' : '#1a7f37';
      locMsgEl.textContent = t;
    };
    const locOn = $('#aah-bk-locon', m);
    if (locOn) locOn.onchange = () => { cfg.bankLocalOn = !!locOn.checked; saveCfg(); };

    const fileEl = $('#aah-bk-file', m);
    const pickBtn = $('#aah-bk-pick', m);
    if (pickBtn && fileEl) pickBtn.onclick = () => fileEl.click();
    if (fileEl) fileEl.onchange = async () => {
      const f = fileEl.files && fileEl.files[0];
      if (!f) return;
      locMsg('读取并解析中：' + f.name + '（' + Math.round(f.size / 1024) + ' KB）…', false);
      if (pickBtn) pickBtn.disabled = true;
      try {
        const r = await bankImportFile(f);
        const bk2 = bankIndex();
        if (locInfo) locInfo.innerHTML = '已导入 <b>' + bk2.arr.length + '</b> 题（' + esc(f.name) + '）';
        locMsg('✅ 新增 ' + r.add + ' 题、更新 ' + r.upd + ' 题，题库共 ' + r.total + ' 题', false);
        log('📄 本地题库导入完成：共 ' + r.total + ' 题（新增 ' + r.add + '，更新 ' + r.upd + '）');
        // 顺手拿当前页面第 1 题试搜一下，让用户当场看见命不命中
        if (current) {
          try {
            const qs0 = await current.collect();
            if (qs0 && qs0.length) {
              const hit = bankFind(qs0[0].title);
              locMsg('✅ 共 ' + r.total + ' 题 ｜ 拿当前第 1 题试搜：' +
                (hit ? '命中 → ' + hit.ans : '没命中（说明这份卷子不在这份题库里，或题干差异太大）'), false);
            }
          } catch (e) { /* 试搜失败不影响导入结果 */ }
        }
      } catch (e) {
        locMsg('❌ ' + (e.message || e), true);
        log('❌ 本地题库导入失败：' + (e.message || e), 'err');
      } finally {
        if (pickBtn) pickBtn.disabled = false;
        fileEl.value = '';
      }
    };
    const delBtn = $('#aah-bk-locdel', m);
    if (delBtn) delBtn.onclick = () => {
      bankSave([], '');
      if (locInfo) locInfo.textContent = '还没有本地题库';
      locMsg('已清空本地题库', false);
      log('本地题库已清空');
    };

    const save = () => {
      cfg.bankApi = ta ? ta.value.trim() : '';
      cfg.bankApiOn = on ? !!on.checked : true;
      apiCache = null;
      saveCfg();
      return apiConfigs();
    };

    const saveBtn = $('#aah-bk-apisave', m);
    if (saveBtn) saveBtn.onclick = () => {
      const l = save();
      if (!cfg.bankApi) { msg('已清空，之后只用 AI', false); return; }
      if (!l.length) { msg('存下了，但没解析出有效题库：每份都必须有 url 和 handler', true); return; }
      msg('✅ 已保存 ' + l.length + ' 份配置' + (cfg.bankApiOn ? '' : '（但没勾启用）'), false);
    };

    const clearBtn = $('#aah-bk-apiclear', m);
    if (clearBtn) clearBtn.onclick = () => {
      if (ta) ta.value = '';
      apiCache = null;
      cfg.bankApi = '';
      saveCfg();
      msg('已清空题库配置', false);
    };

    const testBtn = $('#aah-bk-apitest', m);
    if (testBtn) testBtn.onclick = async () => {
      const l = save();
      if (!l.length) { msg('先粘一份有效配置，至少要有 url 和 handler', true); return; }
      msg('测试中，最多等 12 秒…', false);
      let q = {
        n: 1, title: 'OSI 参考模型共分为几层', type: 'single_choice',
        choices: [{ t: '5' }, { t: '6' }, { t: '7' }, { t: '8' }]
      };
      try {
        if (current) {
          const qs2 = await current.collect();
          if (qs2 && qs2.length) q = qs2[0];
        }
      } catch (e) { /* 页面上没题就用示例题 */ }
      const t0 = Date.now();
      const r = await apiAsk(q);
      if (r) msg('✅ ' + r.from + ' → ' + r.ans + '（' + (Date.now() - t0) + 'ms）', false);
      else msg('❌ 没拿到答案：题库里没有、handler 返回空，或请求被跨域拦截（详情看面板日志）', true);
    };
  }

  function openSettings() {
    const p = PRESETS[cfg.provider] || PRESETS.deepseek;
    const opts = Object.keys(PRESETS).map((k) =>
      '<option value="' + k + '"' + (k === cfg.provider ? ' selected' : '') + '>' + PRESETS[k].label + '</option>').join('');
    const m = showModal('设置',
      '<label>服务商预设</label><select id="aah-prov">' + opts + '</select>' +
      '<label>Base URL（需 OpenAI 兼容 /chat/completions）</label><input id="aah-url" value="' + esc(cfg.baseUrl) + '">' +
      '<label>模型名</label><input id="aah-model" value="' + esc(cfg.model) + '">' +
      '<label>API Key</label><input id="aah-key" type="password" value="' + esc(cfg.apiKey) + '" placeholder="sk-...">' +
      '<label>每次打包题数（6-12 较稳）</label><input id="aah-chunk" type="number" min="1" max="20" value="' + esc(cfg.chunk) + '">' +
      '<label>通用模式最少识别题数</label><input id="aah-minq" type="number" min="1" max="10" value="' + esc(cfg.minQ) + '">' +
      '<label><input id="aah-think" type="checkbox" style="width:auto;margin-right:6px"' + (cfg.thinking ? ' checked' : '') + '>思考模式（部分模型支持，计算题更准但更贵）</label>' +
      '<label><input id="aah-apion" type="checkbox" style="width:auto;margin-right:6px"' + (cfg.bankApiOn !== false ? ' checked' : '') + '>答题前先查题库接口（命中就不调 AI）</label>' +
      '<div id="aah-test" style="margin-top:12px;font-size:12px;color:#57606a;min-height:17px;word-break:break-all"></div>' +
      '<div style="font-size:11.5px;color:#8b949e;margin-top:6px">Key 只存在本机脚本存储里，除你填的 AI 接口外不会发往任何地方。</div>',
      [
        {
          t: '保存', main: true, f: () => {
            cfg.provider = $('#aah-prov').value;
            cfg.baseUrl = $('#aah-url').value.trim() || p.baseUrl;
            cfg.model = $('#aah-model').value.trim();
            cfg.apiKey = $('#aah-key').value.trim();
            cfg.chunk = Math.max(1, Math.min(20, parseInt($('#aah-chunk').value, 10) || 8));
            cfg.minQ = Math.max(1, Math.min(10, parseInt($('#aah-minq').value, 10) || 2));
            cfg.thinking = !!$('#aah-think').checked;
            cfg.bankApiOn = !!$('#aah-apion').checked;
            saveCfg();
            log('设置已保存');
            return true;
          }
        },
        {
          t: '测试连接', f: () => {
            const box2 = $('#aah-test', m);
            const url = $('#aah-url', m).value.trim();
            const model = $('#aah-model', m).value.trim();
            const key = $('#aah-key', m).value.trim();
            if (!url || !model) { box2.style.color = '#cf222e'; box2.textContent = '❌ 先填 Base URL 和模型名'; return false; }
            box2.style.color = '#57606a';
            box2.textContent = '测试中…';
            chat([{ role: 'user', content: '只回复两个字：收到' }],
              { baseUrl: url, model: model, apiKey: key, jsonMode: false })
              .then((t) => { box2.style.color = '#1a7f37'; box2.textContent = '✅ 连通成功，模型回：' + String(t).replace(/\s+/g, ' ').slice(0, 40); })
              .catch((e) => { box2.style.color = '#cf222e'; box2.textContent = '❌ ' + (e.message || e); });
            return false;
          }
        },
        { t: '取消', f: closeModal }
      ]);
    setTimeout(() => {
      const sel = $('#aah-prov', m);
      if (!sel) return;
      sel.onchange = () => {
        const t = PRESETS[sel.value];
        if (!t) return;
        if (t.baseUrl) $('#aah-url', m).value = t.baseUrl;
        if (t.model) $('#aah-model', m).value = t.model;
        if (!t.baseUrl) $('#aah-url', m).focus();
      };
    }, 30);
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true;
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = ox + 'px'; el.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      el.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      el.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  /* =========================================================
   * 8. 启动
   * =======================================================*/
  function boot() {
    // 只在顶层文档、非空白页注入
    if (window.top !== window.self) return;
    if (!document.body) { setTimeout(boot, 200); return; }
    if ($('#aah-dot')) return;

    buildUI();

    // 首轮检测（等页面渲染）
    setTimeout(async () => {
      const ad = await pickAdapter();
      if (ad) {
        dot.classList.remove('idle');
        const subBtn = $('#aah-submit', box);
        if (ad.submit) subBtn.style.display = '';
        setStat('已识别：' + ad.name);
      } else if (cfg.autoHide) {
        dot.classList.add('idle');
        setStat('当前页未识别到题目');
      }
    }, 900);

    // 页面是慢渲染 SPA 时再补两次检测
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      if (current || tries > 6) { clearInterval(timer); return; }
      const ad = await pickAdapter(true);
      if (ad) {
        clearInterval(timer);
        dot.classList.remove('idle');
        if (ad.submit) $('#aah-submit', box).style.display = '';
        setStat('已识别：' + ad.name);
      }
    }, 2500);
  }

  GM_registerMenuCommand('⚙️ 答题助手设置', openSettings);
  GM_registerMenuCommand('📚 题库配置（本地 Word / 在线接口）', openBank);
  GM_registerMenuCommand('🔍 重新检测页面', async () => { await pickAdapter(true); setStat(current ? '已识别：' + current.name : '没识别出题目'); });

  boot();
})();
