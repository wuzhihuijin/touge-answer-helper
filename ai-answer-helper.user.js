// ==UserScript==
// @name         AI 答题助手（头歌 / 超星 / 通用）
// @namespace    ai-answer-helper
// @version      2.0.1
// @description  抓取网页题目 → 调用任意 OpenAI 兼容 API 生成答案 → 自动填入。平台差异由 adapter 层适配，内置头歌/超星类，其余页面走通用启发式；也可导出题目交给任意对话式 AI，再把答案粘回来回填。
// @license      MIT
// @tag          头歌
// @tag          educoder
// @tag          答题
// @tag          自动填写
// @tag          ai
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      *
// @updateURL    https://raw.githubusercontent.com/wuzhihuijin/touge-answer-helper/main/ai-answer-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/wuzhihuijin/touge-answer-helper/main/ai-answer-helper.user.js
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
    minQ: 2
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
    name: '超星类 · 试卷接口',
    _paper: null,

    _ctx() {
      const m = location.pathname.match(/^(.*?)\/exercise\/(\d+)(?:\/users\/([^/?#]+))?/);
      if (!m) return null;
      return { prefix: m[1] || '', id: m[2], user: m[3] || '' };
    },

    _q() {
      const qs = [];
      const all = [location.search, location.href]
        .concat(performance.getEntriesByType('resource').map((e) => e.name)).join(' ');
      const vpn = all.match(/vpn-\d+-[\d.]+/);
      if (vpn) qs.push(vpn[0]); // WebVPN 网关的裸参数名
      const login = this._ctx() && this._ctx().user;
      if (login) qs.push('login=' + encodeURIComponent(login), 'zzud=' + encodeURIComponent(login));
      return qs.length ? '?' + qs.join('&') : '';
    },

    _url(path) {
      const c = this._ctx();
      return c.prefix + path + this._q();
    },

    async detect() {
      const c = this._ctx();
      if (!c) return false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(this._url('/api/exercises/' + c.id + '/start.json'), {
          credentials: 'include', signal: ctrl.signal
        });
        clearTimeout(timer);
        if (!r.ok) return false;
        const j = await r.json();
        if (j && Array.isArray(j.exercise_question_types)) { this._paper = j; return true; }
        return false;
      } catch (e) { return false; }
    },

    async collect() {
      const c = this._ctx();
      let data = this._paper;
      if (!data) {
        const r = await fetch(this._url('/api/exercises/' + c.id + '/start.json'), { credentials: 'include' });
        data = await r.json();
        this._paper = data;
      }
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
    for (const a of ADAPTERS) {
      try {
        if (await a.detect()) { current = a; break; }
      } catch (e) { /* 下一个 */ }
    }
    setDot(current ? '●' : '·');
    if (box) {
      const el = $('#aah-adapter', box);
      if (el) el.textContent = current ? current.name : '未识别';
    }
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
    setStat('共 ' + qs.length + ' 题，请求 AI…');
    log('识别为：' + ad.name + '，共 ' + qs.length + ' 题');
    const map = await askAI(qs, setStat);
    setStat('AI 已返回，正在填入…');
    const r = await ad.apply(qs, map);
    setStat('已填 ' + r.ok + '/' + qs.length + ' 题');
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
      '<div class="row"><button class="ghost" id="aah-cfg">设置</button></div>' +
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
  GM_registerMenuCommand('🔍 重新检测页面', async () => { await pickAdapter(true); setStat(current ? '已识别：' + current.name : '没识别出题目'); });

  boot();
})();
