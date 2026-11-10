// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);
}
// AI/富文本输出统一先转义再套最小 Markdown，避免模型回显 HTML/脚本。
function aiText(text) {
  return esc(String(text ?? '')).replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}
// URL 白名单：只允许 http(s)、站内相对路径、mailto。
function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return '#';
  if (/^(https?:|mailto:)/i.test(s)) return esc(s);
  if (s.startsWith('/') && !s.startsWith('//')) return esc(s);
  return '#';
}
function money(cents) { return `¥ ${(Number(cents||0)/100).toLocaleString('zh-CN',{maximumFractionDigits:2})}`; }
function fmtDate(str) { return str ? String(str).slice(0,10) : '—'; }
function ago(str) {
  if (!str) return '—';
  const d = new Date(str), diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff/60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff/3600)}小时前`;
  if (diff < 7*86400) return `${Math.floor(diff/86400)}天前`;
  return d.toLocaleDateString('zh-CN');
}
function pct(val) { return `${Math.min(100,Math.max(0,Math.round(Number(val||0))))}%`; }
function avatar(name) { return String(name||'?').replace(/\s+/g,'').slice(0,1); }

// ──────────────────────────────────────────────────────────────
// API 客户端
// ──────────────────────────────────────────────────────────────
const API = {
  _apiCachePrefix: 'hq_api_v1:',
  _apiCacheFreshMs: 5 * 60_000,
  _apiCacheMaxMs: 24 * 60 * 60_000,
  _apiWrites: 0,
  _apiGen: 0,
  _scope() { return window.FeishuHQ?.cacheScope || 'anon'; },
  _localKey(path) { return `${API._apiCachePrefix}${API._scope()}:${path}`; },
  _readLocal(path) {
    if (API._scope() === 'anon') return null;
    try {
      const raw = localStorage.getItem(API._localKey(path));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.at || Date.now() - parsed.at > API._apiCacheMaxMs) {
        localStorage.removeItem(API._localKey(path));
        return null;
      }
      return parsed;
    } catch { return null; }
  },
  _writeLocal(path, data) {
    if (API._scope() === 'anon') return;
    try {
      const payload = JSON.stringify({ data, at: Date.now() });
      if (payload.length > 240_000) return;
      localStorage.setItem(API._localKey(path), payload);
      if (++API._apiWrites % 20 === 0) API._pruneLocal();
    } catch {
      // 配额满时清掉本作用域旧缓存再试一次
      API._clearLocal(false);
      try { localStorage.setItem(API._localKey(path), JSON.stringify({ data, at: Date.now() })); } catch {}
    }
  },
  _pruneLocal() {
    try {
      const prefix = `${API._apiCachePrefix}${API._scope()}:`;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          let at = 0;
          try { at = Number(JSON.parse(localStorage.getItem(key) || '{}').at || 0); } catch {}
          keys.push({ key, at });
        }
      }
      if (keys.length <= 120) return;
      keys.sort((a, b) => a.at - b.at).slice(0, Math.max(10, keys.length - 100)).forEach(x => localStorage.removeItem(x.key));
    } catch {}
  },
  _clearLocal(all = false) {
    try {
      const prefixes = all
        ? [API._apiCachePrefix]
        : [`${API._apiCachePrefix}${API._scope()}:`];
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && prefixes.some(p => key.startsWith(p))) keys.push(key);
      }
      keys.forEach(key => localStorage.removeItem(key));
    } catch {}
  },
  _revalidate(path) {
    if (API._revalidating.has(path)) return;
    API._revalidating.add(path);
    const gen = API._apiGen;
    API.request('GET', path).then(data => {
      if (gen !== API._apiGen) return;
      API._writeLocal(path, data);
      API._getCache.set(path, { data, expires: Date.now() + 30_000 });
    }).catch(() => {}).finally(() => API._revalidating.delete(path));
  },
  async request(method, path, body, _retried = false) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (networkError) {
      // 跨境链路偶发掐断连接：幂等读请求自动重试一次，避免整页数据加载失败
      if (method === 'GET' && !_retried) {
        await new Promise(r => setTimeout(r, 800));
        return API.request(method, path, body, true);
      }
      throw Object.assign(networkError, { network: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  },
  // 内存 30 秒 + localStorage 持久缓存：第二次进入直接出数据，过期则后台刷新。
  get: (path) => {
    const now = Date.now();
    const cached = API._getCache.get(path);
    if (cached && cached.expires > now) {
      // 首屏 prefetch 可能发生在认证完成前（scope=anon），命中内存时补写一次本地缓存。
      if (API._scope() !== 'anon' && !API._readLocal(path)) API._writeLocal(path, cached.data);
      return Promise.resolve(cached.data);
    }
    const local = API._readLocal(path);
    if (local) {
      API._getCache.set(path, { data: local.data, expires: now + 30_000 });
      if (now - local.at > API._apiCacheFreshMs) API._revalidate(path);
      return Promise.resolve(local.data);
    }
    const inflight = API._getInflight.get(path);
    if (inflight) return inflight;
    const promise = API.request('GET', path).then(data => {
      API._getCache.set(path, { data, expires: Date.now() + 30_000 });
      API._writeLocal(path, data);
      return data;
    }).finally(() => API._getInflight.delete(path));
    API._getInflight.set(path, promise);
    return promise;
  },
  post: (path, body) => API._mutate('POST', path, body),
  patch: (path, body) => API._mutate('PATCH', path, body),
  put: (path, body) => API._mutate('PUT', path, body),
  del: (path) => API._mutate('DELETE', path),
  _getCache: new Map(),
  _getInflight: new Map(),
  _revalidating: new Set(),
  _mutate(method, path, body) {
    API._apiGen++;
    API._getCache.clear();
    // 一次写操作可能影响其他岗位的待办/审批（同一浏览器里切换过账号），全部作用域失效。
    API._clearLocal(true);
    return API.request(method, path, body);
  }
};

// 当前用户是否具备某项能力（前端按此隐藏敏感操作；服务端始终强制校验）
function can(capability) {
  const caps = window.FeishuHQ?.caps?.capabilities || [];
  return caps.includes('*') || caps.includes(capability);
}

// ──────────────────────────────────────────────────────────────
// Toast 通知
// ──────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  let el = document.querySelector('.app-toast');
  if (!el) { el = document.createElement('div'); el.className = 'app-toast'; document.body.append(el); }
  el.textContent = msg;
  el.className = `app-toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ──────────────────────────────────────────────────────────────
// 模态对话框
// ──────────────────────────────────────────────────────────────
const Modal = {
  _el: null,
  show(title, html, onSubmit, opts = {}) {
    if (!this._el) {
      this._el = document.createElement('div');
      this._el.className = 'crud-modal';
      this._el.innerHTML = `<div class="crud-backdrop"></div><div class="crud-dialog" role="dialog" aria-modal="true">
        <header class="crud-head"><h2></h2><button class="crud-close" type="button" aria-label="关闭">×</button></header>
        <div class="crud-body"></div>
        <footer class="crud-foot">
          <button class="btn ghost crud-cancel" type="button">取消</button>
          <button class="btn primary crud-submit" type="button">${opts.submitText || '保存'}</button>
        </footer>
      </div>`;
      document.body.append(this._el);
      this._el.addEventListener('click', e => { if (e.target.closest('.crud-backdrop,.crud-close,.crud-cancel')) this.hide(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') this.hide(); });
    }
    this._el.querySelector('h2').textContent = title;
    const body = this._el.querySelector('.crud-body');
    body.innerHTML = html;
    const submitBtn = this._el.querySelector('.crud-submit');
    submitBtn.textContent = opts.submitText || '保存';
    if (opts.hideSubmit) submitBtn.style.display = 'none';
    else submitBtn.style.display = '';
    this._onSubmit = onSubmit;
    this._el.querySelector('.crud-foot').style.display = opts.hideSubmit ? 'none' : '';
    const oldBtn = submitBtn.cloneNode(true);
    submitBtn.replaceWith(oldBtn);
    oldBtn.addEventListener('click', () => this._doSubmit());
    this._el.classList.add('open');
    PersonPicker.init(body);
    body.querySelector('input:not([type=hidden]),textarea,select')?.focus();
  },
  hide() { this._el?.classList.remove('open'); },
  async _doSubmit() {
    const btn = this._el.querySelector('.crud-submit');
    if (!this._onSubmit) return this.hide();
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const data = Object.fromEntries(
        [...this._el.querySelectorAll('[name]')].map(el => [
          el.name,
          el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value ? Number(el.value) : null) : el.value || null
        ])
      );
      await this._onSubmit(data);
      this.hide();
    } catch(e) {
      toast(e.message || '保存失败，请重试', 'error');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  }
};

// ──────────────────────────────────────────────────────────────
// 侧滑抽屉
// ──────────────────────────────────────────────────────────────
const Drawer = {
  _el: null,
  show(title, html) {
    if (!this._el) {
      this._el = document.createElement('div');
      this._el.className = 'detail-drawer';
      this._el.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel">
        <header class="drawer-head"><h2></h2><button class="drawer-close" type="button" aria-label="关闭">×</button></header>
        <div class="drawer-body"></div>
      </div>`;
      document.body.append(this._el);
      this._el.addEventListener('click', e => { if (e.target.closest('.drawer-backdrop,.drawer-close')) this.hide(); });
    }
    this._el.querySelector('h2').textContent = title;
    const body = this._el.querySelector('.drawer-body');
    body.innerHTML = html;
    this._el.classList.add('open');
    PersonPicker.init(body);
    return body;
  },
  hide() { this._el?.classList.remove('open'); },
  setBody(html) {
    if (!this._el) return;
    const body = this._el.querySelector('.drawer-body');
    body.innerHTML = html;
    PersonPicker.init(body);
  },
  setTitle(t) { if (this._el) this._el.querySelector('h2').textContent = t; }
};

// ──────────────────────────────────────────────────────────────
// 人员选择器（Person Picker）
// ──────────────────────────────────────────────────────────────
const PersonPicker = {
  html(fieldName, label, opts = {}) {
    const { required = false, placeholder = '搜索成员姓名…' } = opts;
    return `<label class="form-row">
      <span>${esc(label)}${required ? ' <i class="req">*</i>' : ''}</span>
      <div class="person-picker" data-field="${fieldName}">
        <input class="picker-text" type="text" placeholder="${placeholder}" autocomplete="off">
        <input class="picker-id" type="hidden" name="${fieldName}">
        <div class="picker-results" hidden></div>
      </div>
    </label>`;
  },
  init(container = document) {
    container.querySelectorAll('.person-picker').forEach(el => {
      if (el._ready) return;
      el._ready = true;
      const textEl = el.querySelector('.picker-text');
      const idEl = el.querySelector('.picker-id');
      const results = el.querySelector('.picker-results');
      let timer = null;
      textEl.addEventListener('input', () => {
        idEl.value = '';
        clearTimeout(timer);
        const q = textEl.value.trim();
        if (q.length < 1) { results.hidden = true; return; }
        timer = setTimeout(async () => {
          try {
            const { items = [] } = await API.get(`/v1/people?search=${encodeURIComponent(q)}&limit=8`);
            if (!items.length) { results.hidden = true; return; }
            results.innerHTML = items.map(p => `
              <div class="picker-option" data-id="${p.id}" data-name="${esc(p.display_name)}">
                <span class="person-chip sm">${avatar(p.display_name)}</span>
                <div><b>${esc(p.display_name)}</b>${p.org_unit_name ? `<small>${esc(p.org_unit_name)}</small>` : ''}</div>
              </div>`).join('');
            results.hidden = false;
            results.querySelectorAll('.picker-option').forEach(opt => {
              opt.addEventListener('mousedown', e => {
                e.preventDefault();
                idEl.value = opt.dataset.id;
                textEl.value = opt.dataset.name;
                results.hidden = true;
              });
            });
          } catch { results.hidden = true; }
        }, 280);
      });
      textEl.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 160));
    });
  }
};

// ──────────────────────────────────────────────────────────────
// ── 项目管理模块
// ──────────────────────────────────────────────────────────────
const PROJ_STATUS = { planning:'规划中', active:'进行中', at_risk:'有风险', on_hold:'暂停', completed:'已完成', cancelled:'已取消' };
const TASK_STATUS = { todo:'待开始', in_progress:'进行中', in_review:'审核中', done:'已完成', blocked:'已阻塞', cancelled:'已取消' };
const PRIORITY_MAP = { low:'低', medium:'中', high:'高', critical:'紧急' };

async function loadProjectsData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  try {
    const { items } = await API.get('/v1/projects?limit=50');
    const tbody = container.querySelector('.data-table tbody');
    if (!tbody) return;
    if (!items?.length) { tbody.innerHTML = `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无项目，点击「新建项目」开始</p></td></tr>`; return; }
    const colors = ['blue','green','amber','violet','teal','red'];
    tbody.innerHTML = items.map((p, i) => `
      <tr data-id="${p.id}" class="clickable-row">
        <td><div class="entity"><span class="project-code ${colors[i%colors.length]}">${esc((p.code||'P').slice(0,3))}</span><div><b>${esc(p.name)}</b><small style="color:var(--muted);display:block;margin-top:2px">${esc(p.customer_name||'内部项目')}</small></div></div></td>
        <td><span class="person-chip">${avatar(p.owner_name)}</span>${esc(p.owner_name||'未分配')}</td>
        <td><span class="inline-progress" style="width:70px"><i style="width:${p.progress||0}%"></i></span>${p.progress||0}%</td>
        <td>${fmtDate(p.end_date)}</td>
        <td><span class="status-pill ${['at_risk','cancelled'].includes(p.status)?'warning':''}">${PROJ_STATUS[p.status]||p.status}</span></td>
        <td>${money(p.budget_cents)}</td>
      </tr>`).join('');
    tbody.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openProjectDetail(tr.dataset.id)));
    const stats = container.querySelectorAll('.metric-card strong');
    if (stats[0]) stats[0].textContent = items.filter(p => ['active','at_risk'].includes(p.status)).length;
    if (stats[1]) {
      const atRisk = items.filter(p => p.status === 'at_risk').length;
      stats[1].textContent = items.length ? `${Math.round((1 - atRisk / items.length) * 100)}%` : '—';
    }
    if (stats[2]) stats[2].textContent = money(items.reduce((s,p) => s + Number(p.budget_cents||0), 0));
    if (stats[3]) {
      const owners = new Set(items.map(p => p.owner_name).filter(Boolean));
      stats[3].textContent = owners.size ? `${owners.size} 位负责人` : '—';
    }
  } catch(e) { console.warn('projects:', e.message); }
}

async function openProjectDetail(id) {
  Drawer.show('项目详情', '<p class="loading-text">加载中…</p>');
  try {
    const p = await API.get(`/v1/projects/${id}`);
    const colors = ['blue','green','amber'];
    const colorClass = colors[0];
    renderProjectDrawer(p);
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

function renderProjectDrawer(p, tab = 'tasks') {
  const tabs = [['tasks','任务'],['risks','风险'],['milestones','里程碑'],['members','成员'],['time','工时']];
  const body = Drawer.show(p.name, `
    <div class="detail-header">
      <span class="project-code blue">${esc((p.code||'P').slice(0,3))}</span>
      <div><h3>${esc(p.name)}</h3><p>${esc(p.customer_name||'内部项目')} · ${fmtDate(p.start_date)} → ${fmtDate(p.end_date)}</p></div>
    </div>
    <div class="detail-stats">
      <div><small>进度</small><strong>${p.progress||0}%</strong></div>
      <div><small>负责人</small><strong>${esc(p.owner_name||'—')}</strong></div>
      <div><small>状态</small><strong>${PROJ_STATUS[p.status]||p.status}</strong></div>
      <div><small>预算</small><strong>${money(p.budget_cents)}</strong></div>
    </div>
    <div style="display:flex;gap:8px;margin:0 0 12px">
      <button class="btn ghost small" type="button" id="edit-project-btn">编辑项目</button>
      <button class="btn danger-ghost small" type="button" id="archive-project-btn">归档项目</button>
    </div>
    <div class="drawer-tabs">
      ${tabs.map(([k,v]) => `<button class="drawer-tab${tab===k?' active':''}" data-proj-tab="${k}" data-proj-id="${p.id}">${v}</button>`).join('')}
    </div>
    <div id="proj-tab-content"></div>`);

  // 绑定 tab 切换
  body.querySelector('#edit-project-btn')?.addEventListener('click', () => openEditProjectModal(p));
  body.querySelector('#archive-project-btn')?.addEventListener('click', async () => {
    if (!confirm(`确定归档项目「${p.name}」？归档后状态将变为已完成。`)) return;
    try {
      await API.del(`/v1/projects/${p.id}`);
      toast('项目已归档');
      Drawer.hide();
      loadProjectsData();
    } catch (e) { toast(e.message || '归档失败', 'error'); }
  });
  body.querySelectorAll('[data-proj-tab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      body.querySelectorAll('[data-proj-tab]').forEach(b => b.classList.toggle('active', b === btn));
      await renderProjectTab(p, btn.dataset.projTab);
    });
  });
  renderProjectTab(p, tab);
}

async function renderProjectTab(p, tab) {
  const el = document.getElementById('proj-tab-content');
  if (!el) return;
  el.innerHTML = '<p class="loading-text" style="padding:12px">加载中…</p>';

  if (tab === 'tasks') {
    const tasks = p.tasks || [];
    el.innerHTML = `
      <div class="task-mini-list">
        ${tasks.length ? tasks.map(t => `
          <div class="task-mini-row" style="grid-template-columns:10px 1fr 70px 50px">
            <span class="status-dot ${t.status==='done'?'done':t.status==='blocked'?'blocked':''}"></span>
            <span>${esc(t.title)}</span>
            <small style="color:var(--muted)">${esc(t.assignee_name||'未分配')}</small>
            <span class="status-pill" style="font-size:7px;padding:2px 5px">${PRIORITY_MAP[t.priority]||''}</span>
          </div>`).join('') : '<p class="empty-hint">暂无任务</p>'}
      </div>
      <button class="btn ghost small" id="add-task-btn" style="width:100%;margin-top:8px">＋ 新建任务</button>`;
    el.querySelector('#add-task-btn')?.addEventListener('click', () => openCreateTaskModal(p.id, p.name));
  }

  else if (tab === 'risks') {
    try {
      const { items } = await API.get(`/v1/projects/${p.id}/risks`);
      el.innerHTML = `
        ${items.length ? items.map(r => `
          <div style="padding:10px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
              <b style="font-size:10px">${esc(r.title)}</b>
              <span class="status-pill ${r.probability==='high'?'warning':''}" style="font-size:7px">${{low:'低',medium:'中',high:'高'}[r.probability]||'—'}概率</span>
            </div>
            <p style="margin:0;color:var(--muted);line-height:1.5">${esc(r.mitigation_plan||'—')}</p>
          </div>`).join('') : '<p class="empty-hint">暂无风险记录</p>'}
        <button class="btn ghost small" id="add-risk-btn" style="width:100%;margin-top:10px">＋ 登记风险</button>`;
      el.querySelector('#add-risk-btn')?.addEventListener('click', () => openCreateRiskModal(p.id));
    } catch { el.innerHTML = '<p class="error-hint">加载失败</p>'; }
  }

  else if (tab === 'milestones') {
    try {
      const { items } = await API.get(`/v1/projects/${p.id}/milestones`);
      el.innerHTML = `
        ${items.length ? items.map(m => `
          <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <span><b style="font-size:10px;display:block">${esc(m.title)}</b><small style="color:var(--muted)">${fmtDate(m.due_date)}</small></span>
            <span class="status-pill ${m.status==='missed'?'warning':m.status==='completed'?'':''}">
              ${{planned:'计划中',completed:'已完成',missed:'已逾期'}[m.status]||m.status}
            </span>
          </div>`).join('') : '<p class="empty-hint">暂无里程碑</p>'}
        <button class="btn ghost small" id="add-ms-btn" style="width:100%;margin-top:10px">＋ 新建里程碑</button>`;
      el.querySelector('#add-ms-btn')?.addEventListener('click', () => openCreateMilestoneModal(p.id));
    } catch { el.innerHTML = '<p class="error-hint">加载失败</p>'; }
  }

  else if (tab === 'members') {
    const members = p.members || [];
    el.innerHTML = `
      <div style="margin-bottom:12px">
        ${members.length ? members.map(m => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <span class="person-chip">${avatar(m.display_name)}</span>
            <span style="flex:1">${esc(m.display_name)}</span>
            <small style="color:var(--muted)">${esc(m.role||'成员')}</small>
          </div>`).join('') : '<p class="empty-hint">暂无成员</p>'}
      </div>
      ${PersonPicker.html('person_id','添加成员')}
      <button class="btn ghost small" id="add-member-btn" style="margin-top:4px">＋ 添加成员</button>`;
    PersonPicker.init(el);
    el.querySelector('#add-member-btn')?.addEventListener('click', async () => {
      const pid = el.querySelector('[name=person_id]')?.value;
      if (!pid) { toast('请先搜索并选择成员', 'error'); return; }
      try { await API.post(`/v1/projects/${p.id}/members`, { person_id: pid }); toast('成员已添加'); const fresh = await API.get(`/v1/projects/${p.id}`); renderProjectDrawer(fresh, 'members'); } catch(e) { toast(e.message, 'error'); }
    });
  }

  else if (tab === 'time') {
    try {
      const summary = await API.get(`/v1/projects/${p.id}/time-summary`);
      el.innerHTML = `
        <div class="detail-stats" style="margin-bottom:16px">
          <div><small>总记录工时</small><strong>${summary.total_hours||0}h</strong></div>
          <div><small>贡献人数</small><strong>${summary.contributor_count||0}</strong></div>
        </div>
        ${(summary.by_person||[]).map(r => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <span class="person-chip">${avatar(r.person_name)}</span>
            <span style="flex:1">${esc(r.person_name)}</span>
            <b style="font:600 11px var(--mono)">${r.hours}h</b>
          </div>`).join('') || '<p class="empty-hint">暂无工时记录</p>'}
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line-soft)">
          <div class="form-row"><span>记录工时</span><input type="number" id="log-hours" placeholder="小时数" min="0.5" step="0.5" style="padding:8px 11px;border:1px solid var(--line);border-radius:8px;width:100%;font:inherit"></div>
          <button class="btn ghost small" id="log-time-btn">记录工时</button>
        </div>`;
      el.querySelector('#log-time-btn')?.addEventListener('click', async () => {
        const hours = Number(el.querySelector('#log-hours')?.value);
        if (!hours) { toast('请输入工时', 'error'); return; }
        try {
          const tasks = p.tasks || [];
          const taskId = tasks[0]?.id;
          if (!taskId) { toast('项目无任务，无法记录工时', 'error'); return; }
          await API.post(`/v1/tasks/${taskId}/time-logs`, { hours_logged: hours, log_date: new Date().toISOString().slice(0,10) });
          toast('工时已记录');
          const fresh = await API.get(`/v1/projects/${p.id}`);
          renderProjectDrawer(fresh, 'time');
        } catch(e) { toast(e.message, 'error'); }
      });
    } catch { el.innerHTML = '<p class="error-hint">加载失败</p>'; }
  }
}

function openCreateTaskModal(projectId, projectName) {
  Modal.show(`新建任务 · ${projectName}`, `
    <div class="form-row"><span>任务标题 <i class="req">*</i></span><input name="title" placeholder="简洁描述任务目标" required></div>
    <div class="form-row"><span>描述</span><textarea name="description" rows="3" placeholder="任务背景、验收标准…"></textarea></div>
    <div class="form-cols">
      <div class="form-row"><span>优先级</span><select name="priority"><option value="medium">中 Medium</option><option value="high">高 High</option><option value="critical">紧急</option><option value="low">低 Low</option></select></div>
      <div class="form-row"><span>截止日期</span><input type="date" name="due_date"></div>
    </div>
    ${PersonPicker.html('assignee_person_id','负责人')}
  `, async (data) => {
    await API.post(`/v1/projects/${projectId}/tasks`, data);
    toast('任务已创建');
    const fresh = await API.get(`/v1/projects/${projectId}`);
    renderProjectDrawer(fresh, 'tasks');
  });
}

function openCreateRiskModal(projectId) {
  Modal.show('登记风险', `
    <div class="form-row"><span>风险描述 <i class="req">*</i></span><input name="title" placeholder="简要描述风险" required></div>
    <div class="form-cols">
      <div class="form-row"><span>发生概率</span><select name="probability"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
      <div class="form-row"><span>影响程度</span><select name="impact"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
    </div>
    <div class="form-row"><span>应对措施</span><textarea name="mitigation_plan" rows="3" placeholder="预防措施或应急方案…"></textarea></div>
  `, async (data) => {
    await API.post(`/v1/projects/${projectId}/risks`, data);
    toast('风险已登记');
    const fresh = await API.get(`/v1/projects/${projectId}`);
    renderProjectDrawer(fresh, 'risks');
  });
}

function openCreateMilestoneModal(projectId) {
  Modal.show('新建里程碑', `
    <div class="form-row"><span>里程碑名称 <i class="req">*</i></span><input name="title" placeholder="如：需求确认完成、测试通过" required></div>
    <div class="form-cols">
      <div class="form-row"><span>目标日期 <i class="req">*</i></span><input type="date" name="due_date" required></div>
      <div class="form-row"><span>状态</span><select name="status"><option value="planned">计划中</option><option value="completed">已完成</option></select></div>
    </div>
    <div class="form-row"><span>说明</span><textarea name="description" rows="2"></textarea></div>
  `, async (data) => {
    await API.post(`/v1/projects/${projectId}/milestones`, data);
    toast('里程碑已创建');
    const fresh = await API.get(`/v1/projects/${projectId}`);
    renderProjectDrawer(fresh, 'milestones');
  });
}

function openCreateProjectModal() {
  Modal.show('新建项目', `
    <div class="form-row"><span>项目名称 <i class="req">*</i></span><input name="name" placeholder="项目名称" required></div>
    <div class="form-row"><span>客户 / 类型 <i class="req">*</i></span><input name="customer_name" placeholder="客户名称或内部项目" required></div>
    <div class="form-cols">
      <div class="form-row"><span>项目编号</span><input name="code" placeholder="如 PRJ-001"></div>
      <div class="form-row"><span>类型</span><select name="type"><option value="delivery">客户交付</option><option value="internal">内部项目</option><option value="rd">研发</option></select></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>开始日期</span><input type="date" name="start_date"></div>
      <div class="form-row"><span>截止日期</span><input type="date" name="end_date"></div>
    </div>
    <div class="form-row"><span>预算（元）</span><input type="number" name="budget_yuan" placeholder="0" min="0"></div>
    ${PersonPicker.html('owner_person_id','项目负责人')}
  `, async (data) => {
    await API.post('/v1/projects', {
      name: data.name, customer_name: data.customer_name, code: data.code,
      type: data.type, start_date: data.start_date, end_date: data.end_date,
      owner_person_id: data.owner_person_id,
      budget_cents: Math.round((Number(data.budget_yuan)||0) * 100)
    });
    toast('项目已创建');
    window.renderView?.('projects');
  });
}

function openEditProjectModal(p) {
  Modal.show('编辑项目', `
    <div class="form-row"><span>项目名称 <i class="req">*</i></span><input name="name" value="${esc(p.name)}" required></div>
    <div class="form-row"><span>客户 / 类型 <i class="req">*</i></span><input name="customer_name" value="${esc(p.customer_name)}" required></div>
    <div class="form-cols">
      <div class="form-row"><span>状态</span><select name="status">
        ${Object.entries({ planning: '规划中', active: '进行中', at_risk: '有风险', completed: '已完成' }).map(([k, v]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
      <div class="form-row"><span>进度（%）</span><input type="number" name="progress" min="0" max="100" value="${Number(p.progress) || 0}"></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>开始日期</span><input type="date" name="start_date" value="${p.start_date ? String(p.start_date).slice(0, 10) : ''}"></div>
      <div class="form-row"><span>截止日期</span><input type="date" name="end_date" value="${p.end_date ? String(p.end_date).slice(0, 10) : ''}"></div>
    </div>
    <div class="form-row"><span>预算（元）</span><input type="number" name="budget_yuan" min="0" value="${Math.round(Number(p.budget_cents || 0) / 100)}"></div>
  `, async (data) => {
    await API.patch(`/v1/projects/${p.id}`, {
      name: data.name,
      customer_name: data.customer_name,
      status: data.status,
      progress: data.progress,
      start_date: data.start_date,
      end_date: data.end_date,
      budget_cents: Math.round((Number(data.budget_yuan) || 0) * 100),
    });
    toast('项目已更新');
    Drawer.hide();
    loadProjectsData();
    openProjectDetail(p.id);
  });
}

// ──────────────────────────────────────────────────────────────
// ── 战略 OKR 模块（全新）
// ──────────────────────────────────────────────────────────────
let _strategyState = { periods: [], selectedPeriodId: null };

async function loadStrategyData() {
  const root = document.getElementById('strategy-content');
  if (!root) return;
  root.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const { items: periods } = await API.get('/v1/strategy/periods');
    _strategyState.periods = periods;
    if (!_strategyState.selectedPeriodId && periods.length) {
      _strategyState.selectedPeriodId = periods[0].id;
    }
    renderStrategyPage(root);
  } catch(e) { root.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${e.message}</p>`; }
}

async function renderStrategyPage(root) {
  const { periods, selectedPeriodId } = _strategyState;
  if (!periods.length) {
    root.innerHTML = `
      <div class="okr-empty">
        <div style="font-size:36px;margin-bottom:12px">◈</div>
        <p style="font-size:12px;font-weight:600">还没有 OKR 周期</p>
        <p style="color:var(--muted);font-size:10px;margin-bottom:16px">创建第一个季度目标，将公司方向落地为可追踪的结果</p>
        <button class="btn primary" id="create-period-btn">＋ 创建 OKR 周期</button>
      </div>`;
    root.querySelector('#create-period-btn')?.addEventListener('click', openCreatePeriodModal);
    return;
  }

  // 获取当前周期的目标
  let objectives = [];
  if (selectedPeriodId) {
    try {
      const { items } = await API.get(`/v1/strategy/periods/${selectedPeriodId}/objectives`);
      objectives = items;
    } catch {}
  }

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div class="okr-period-tabs">
        ${periods.map(p => `<button class="okr-period-tab${p.id===selectedPeriodId?' active':''}" data-period-id="${p.id}">${esc(p.label)}</button>`).join('')}
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn ghost small" id="add-period-btn">＋ 新建周期</button>
        <button class="btn primary small" id="add-obj-btn">＋ 添加目标</button>
      </div>
    </div>
    <div id="okr-objectives">
      ${objectives.length ? objectives.map(o => renderObjectiveCard(o)).join('') : `
        <div class="okr-empty">
          <p style="font-size:11px;color:var(--muted)">当前周期还没有目标，点击「添加目标」开始</p>
        </div>`}
    </div>`;

  // 周期切换
  root.querySelectorAll('.okr-period-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _strategyState.selectedPeriodId = btn.dataset.periodId;
      renderStrategyPage(root);
    });
  });

  root.querySelector('#add-period-btn')?.addEventListener('click', openCreatePeriodModal);
  root.querySelector('#add-obj-btn')?.addEventListener('click', () => openCreateObjectiveModal(selectedPeriodId));

  // KR 行点击 → 详情抽屉
  root.querySelectorAll('[data-kr-id]').forEach(row => {
    row.addEventListener('click', () => openKRDetail(row.dataset.krId));
  });
  // 添加 KR 按钮
  root.querySelectorAll('[data-add-kr-obj]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openCreateKRModal(btn.dataset.addKrObj, btn.dataset.objId); });
  });
  // 打卡按钮
  root.querySelectorAll('[data-checkin-kr]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openCheckinModal(btn.dataset.checkinKr); });
  });
}

function renderObjectiveCard(o) {
  const krs = o.key_results || [];
  const overallProgress = krs.length ? Math.round(krs.reduce((s,k) => s + Number(k.progress||0), 0) / krs.length) : 0;
  return `
    <div class="okr-obj-card">
      <div class="okr-obj-head">
        <div>
          <div style="font-size:8px;color:var(--jade);font-weight:700;letter-spacing:.08em;margin-bottom:4px">${{company:'公司',department:'部门',individual:'个人'}[o.type]||o.type} · ${esc(o.owner_name||'—')}</div>
          <h3>${esc(o.title)}</h3>
          ${o.description ? `<p style="margin:4px 0 0;color:var(--muted);font-size:8px">${esc(o.description)}</p>` : ''}
        </div>
        <div style="text-align:center;min-width:52px">
          <div style="font:700 20px var(--mono);color:${overallProgress>=80?'#18a965':overallProgress>=50?'#b97518':'var(--muted)'}">${overallProgress}%</div>
          <div style="font-size:7px;color:var(--muted)">综合进度</div>
        </div>
      </div>
      <div class="okr-kr-list">
        ${krs.map(k => `
          <div class="okr-kr-row" data-kr-id="${k.id}">
            <div>
              <div class="okr-kr-title">${esc(k.title)}</div>
              <div class="okr-kr-progress">
                <div class="okr-kr-bar"><div class="okr-kr-bar-fill" style="width:${k.progress||0}%"></div></div>
                <div class="okr-kr-pct">${k.progress||0}%</div>
              </div>
              <div class="okr-kr-meta">
                <span>${k.current_value != null ? `当前 ${k.current_value}` : '—'} / 目标 ${k.target_value??'—'} ${k.unit||''}</span>
                <span>置信度 ${k.confidence||50}%</span>
              </div>
            </div>
            <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
              <button class="btn ghost small" data-checkin-kr="${k.id}">打卡</button>
            </div>
          </div>`).join('')}
        <button class="okr-add-btn" data-add-kr-obj="${o.id}">＋ 添加关键结果</button>
      </div>
    </div>`;
}

function openCreatePeriodModal() {
  const now = new Date();
  const y = now.getFullYear();
  const q = Math.ceil((now.getMonth()+1)/3);
  Modal.show('新建 OKR 周期', `
    <div class="form-row"><span>周期名称 <i class="req">*</i></span><input name="name" value="${y}年Q${q}" placeholder="如：2026年Q3" required></div>
    <div class="form-cols">
      <div class="form-row"><span>类型</span><select name="period_type"><option value="quarter">季度</option><option value="annual">年度</option><option value="monthly">月度</option></select></div>
      <div class="form-row"><span>状态</span><select name="status"><option value="active">进行中</option><option value="planning">规划中</option></select></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>开始日期 <i class="req">*</i></span><input type="date" name="start_date" required value="${y}-${String((q-1)*3+1).padStart(2,'0')}-01"></div>
      <div class="form-row"><span>结束日期 <i class="req">*</i></span><input type="date" name="end_date" required></div>
    </div>
  `, async (data) => {
    await API.post('/v1/strategy/periods', { label: data.name, period_type: data.period_type, start_date: data.start_date, end_date: data.end_date, status: data.status });
    toast('OKR 周期已创建');
    await loadStrategyData();
  });
}

function openCreateObjectiveModal(periodId) {
  if (!periodId) { toast('请先选择或创建 OKR 周期', 'error'); return; }
  Modal.show('添加目标 (O)', `
    <div class="form-row"><span>目标描述 <i class="req">*</i></span><input name="title" placeholder="公司级目标通常描述一个重要的方向或里程碑" required></div>
    <div class="form-row"><span>详细说明</span><textarea name="description" rows="3" placeholder="为什么这个目标重要？"></textarea></div>
    <div class="form-cols">
      <div class="form-row"><span>层级</span><select name="type"><option value="company">公司级</option><option value="department">部门级</option><option value="individual">个人级</option></select></div>
    </div>
    ${PersonPicker.html('owner_person_id','目标负责人',{required:true})}
  `, async (data) => {
    await API.post('/v1/strategy/objectives', { period_id: periodId, title: data.title, description: data.description, type: data.type, owner_person_id: data.owner_person_id });
    toast('目标已创建');
    await loadStrategyData();
  });
}

function openCreateKRModal(objectiveId) {
  Modal.show('添加关键结果 (KR)', `
    <div class="form-row"><span>KR 标题 <i class="req">*</i></span><input name="title" placeholder="可量化的结果描述，如：NPS 提升至 45 分" required></div>
    <div class="form-cols">
      <div class="form-row"><span>类型</span><select name="kr_type"><option value="numeric">数值型</option><option value="percentage">百分比</option><option value="milestone">里程碑</option><option value="boolean">是/否</option></select></div>
      <div class="form-row"><span>单位</span><input name="unit" placeholder="如：分、个、万元、%"></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>基线值</span><input type="number" name="baseline_value" placeholder="当前值" value="0"></div>
      <div class="form-row"><span>目标值 <i class="req">*</i></span><input type="number" name="target_value" placeholder="期望达到的值" required></div>
    </div>
  `, async (data) => {
    await API.post(`/v1/strategy/objectives/${objectiveId}/key-results`, data);
    toast('关键结果已添加');
    await loadStrategyData();
  });
}

function openCheckinModal(krId) {
  Modal.show('进度打卡', `
    <div class="form-row"><span>当前值 <i class="req">*</i></span><input type="number" name="current_value" placeholder="填写当前实际完成值" required></div>
    <div class="form-row"><span>置信度</span><select name="confidence">
      <option value="90">90% — 非常有把握</option>
      <option value="70" selected>70% — 有信心</option>
      <option value="50">50% — 尚可</option>
      <option value="30">30% — 有风险</option>
    </select></div>
    <div class="form-row"><span>本周进展</span><textarea name="note" rows="3" placeholder="本周做了什么？有什么需要帮助的？"></textarea></div>
    <div class="form-row"><span>阻塞项</span><input name="blockers" placeholder="列出阻碍进展的问题…"></div>
  `, async (data) => {
    await API.post(`/v1/strategy/key-results/${krId}/checkins`, { current_value: data.current_value, confidence: data.confidence, note: data.note, blockers: data.blockers });
    toast('打卡成功');
    await loadStrategyData();
  });
}

async function openKRDetail(krId) {
  Drawer.show('关键结果详情', '<p class="loading-text">加载中…</p>');
  try {
    const kr = await API.get(`/v1/strategy/key-results/${krId}`);
    Drawer.setBody(`
      <div style="margin-bottom:20px">
        <div style="font-size:8px;color:var(--jade);margin-bottom:6px">KR · ${esc(kr.objective_title||'')}</div>
        <h3 style="margin:0 0 8px;font-size:14px">${esc(kr.title)}</h3>
        <div class="okr-kr-progress" style="margin-bottom:8px">
          <div class="okr-kr-bar" style="height:8px"><div class="okr-kr-bar-fill" style="width:${kr.progress||0}%"></div></div>
          <div class="okr-kr-pct">${kr.progress||0}%</div>
        </div>
        <div style="display:flex;gap:16px;font-size:9px;color:var(--muted)">
          <span>基线 ${kr.baseline_value??0} ${kr.unit||''}</span>
          <span>当前 <b style="color:var(--ink)">${kr.current_value??0} ${kr.unit||''}</b></span>
          <span>目标 ${kr.target_value??'—'} ${kr.unit||''}</span>
        </div>
      </div>
      <div style="margin-bottom:16px">
        <button class="btn primary small" onclick="openCheckinModal('${krId}')">＋ 进度打卡</button>
        <button class="btn ghost small" style="margin-left:6px" onclick="openCreateInitiativeModal('${krId}')">＋ 创建执行项</button>
      </div>
      <div class="detail-section">
        <h4>打卡记录</h4>
        ${(kr.checkins||[]).map(c => `
          <div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <div style="display:flex;justify-content:space-between;margin-bottom:3px">
              <b>${esc(c.author_name||'—')}</b>
              <span style="color:var(--muted)">${ago(c.checked_at||c.created_at)}</span>
            </div>
            <div style="display:flex;gap:10px;color:var(--muted)">
              <span>值：<b style="color:var(--ink)">${c.value_at_checkin} ${kr.unit||''}</b></span>
              <span>置信度：${c.confidence}%</span>
            </div>
            ${c.summary ? `<p style="margin:4px 0 0;line-height:1.5">${esc(c.summary)}</p>` : ''}
          </div>`).join('') || '<p class="empty-hint">暂无打卡记录</p>'}
      </div>
      <div class="detail-section">
        <div class="section-head"><h4>执行项 (Initiatives)</h4></div>
        ${(kr.initiatives||[]).map(ini => `
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <div>
              <b style="font-size:10px">${esc(ini.title)}</b>
              <div style="display:flex;gap:8px;margin-top:3px;color:var(--muted)">
                <span>${esc(ini.owner_name||'—')}</span>
                <span>${fmtDate(ini.due_date)}</span>
              </div>
            </div>
            <span class="status-pill" style="font-size:7px">${{planned:'计划',in_progress:'进行中',completed:'完成',cancelled:'取消'}[ini.status]||ini.status}</span>
          </div>`).join('') || '<p class="empty-hint">暂无执行项</p>'}
        <button class="btn ghost small" style="width:100%;margin-top:8px" onclick="openCreateInitiativeModal('${krId}')">＋ 添加执行项</button>
      </div>`);
    window.openCheckinModal = openCheckinModal;
    window.openCreateInitiativeModal = openCreateInitiativeModal;
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

function openCreateInitiativeModal(krId) {
  Modal.show('创建执行项', `
    <div class="form-row"><span>执行项名称 <i class="req">*</i></span><input name="title" placeholder="具体行动计划" required></div>
    <div class="form-row"><span>说明</span><textarea name="description" rows="2"></textarea></div>
    <div class="form-cols">
      <div class="form-row"><span>优先级</span><select name="priority"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
      <div class="form-row"><span>截止日期</span><input type="date" name="due_date"></div>
    </div>
    ${PersonPicker.html('owner_person_id','负责人')}
  `, async (data) => {
    await API.post(`/v1/strategy/key-results/${krId}/initiatives`, data);
    toast('执行项已创建');
    openKRDetail(krId);
  });
}

// ──────────────────────────────────────────────────────────────
// ── CRM 销售模块
// ──────────────────────────────────────────────────────────────
const STAGE_MAP = { lead:'线索',qualified:'需求确认',proposal:'方案',negotiation:'商务谈判',won:'已赢单',lost:'已丢单' };
const ACT_MAP = { call:'电话',meeting:'拜访',email:'邮件',demo:'演示',proposal:'提案',note:'备注' };

let _crmTab = 'opps'; // 'opps' | 'accounts'

async function loadCRMData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  const toolbar = container.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('[data-crm-tab]')) {
    toolbar.innerHTML = `
      <div class="filter-tabs">
        <button class="${_crmTab==='opps'?'active':''}" data-crm-tab="opps">商机列表</button>
        <button class="${_crmTab==='accounts'?'active':''}" data-crm-tab="accounts">客户档案</button>
        <button class="${_crmTab==='crmconfig'?'active':''}" data-crm-tab="crmconfig">CRM 配置</button>
      </div>
      <div class="table-tools">
        <button onclick="window._crmSearch()">⌕ 搜索</button>
        <button>⇅ 筛选</button>
      </div>`;
    toolbar.querySelectorAll('[data-crm-tab]').forEach(btn => {
      btn.addEventListener('click', () => { _crmTab = btn.dataset.crmTab; loadCRMData(); });
    });
  } else {
    toolbar?.querySelectorAll('[data-crm-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.crmTab === _crmTab));
  }
  const wrap = container.querySelector('.data-table-wrap');
  if (_crmTab === 'crmconfig' && wrap) { await renderCRMConfig(wrap); return; }
  if (_crmTab === 'opps') await loadOpportunities(container);
  else if (_crmTab === 'accounts') await loadAccounts(container);
}

function ensureTable(container, cols) {
  let wrap = container.querySelector('.data-table-wrap');
  if (!wrap) return null;
  if (!wrap.querySelector('.data-table')) {
    wrap.innerHTML = `<table class="data-table"><thead><tr></tr></thead><tbody></tbody></table>`;
  }
  return wrap.querySelector('.data-table');
}

async function loadOpportunities(container) {
  try {
    const { items } = await API.get('/v1/crm/opportunities?limit=50');
    const open = (items || []).filter(o => !['won', 'lost'].includes(o.stage));
    const pipeline = open.reduce((s, o) => s + Number(o.amount_cents || 0), 0);
    const weighted = pipeline > 0
      ? open.reduce((s, o) => s + Number(o.amount_cents || 0) * Number(o.win_probability || 0), 0) / pipeline
      : 0;
    const crmStats = document.querySelectorAll('.module-metrics .metric-card strong');
    if (crmStats[0]) crmStats[0].textContent = money(pipeline);
    if (crmStats[1]) crmStats[1].textContent = String(open.length);
    if (crmStats[2]) crmStats[2].textContent = `${Math.round(weighted)}%`;
    API.get('/v1/finance/overview').then(f => {
      if (crmStats[3]) crmStats[3].textContent = money(f?.payments?.collected_total ?? 0);
    }).catch(() => { if (crmStats[3]) crmStats[3].textContent = '—'; });
    const table = ensureTable(container, 7);
    if (!table) return;
    table.querySelector('thead tr').innerHTML = '<th>商机</th><th>客户</th><th>负责人</th><th>金额</th><th>阶段</th><th>赢单率</th><th>预计签约</th>';
    const tbody = table.querySelector('tbody');
    if (!items?.length) { tbody.innerHTML = `<tr><td colspan="7"><p class="empty-hint" style="padding:20px">暂无商机</p></td></tr>`; return; }
    const colors = ['blue','green','amber','violet','teal'];
    tbody.innerHTML = items.map((o,i) => `
      <tr data-id="${o.id}" class="clickable-row">
        <td><div class="entity"><span class="project-code ${colors[i%5]}">${esc(o.customer_name).slice(0,2)}</span><b>${esc(o.name)}</b></div></td>
        <td>${esc(o.customer_name)}</td>
        <td><span class="person-chip">${avatar(o.owner_name)}</span>${esc(o.owner_name||'—')}</td>
        <td>${money(o.amount_cents)}</td>
        <td><span class="status-pill">${STAGE_MAP[o.stage]||o.stage}</span></td>
        <td>${o.win_probability}%</td>
        <td>${fmtDate(o.expected_close_date)}</td>
      </tr>`).join('');
    tbody.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openOpportunityDetail(tr.dataset.id)));
  } catch(e) { console.warn('crm opps:', e.message); }
}

async function loadAccounts(container) {
  try {
    const { items } = await API.get('/v1/crm/accounts?limit=50');
    const table = ensureTable(container, 6);
    if (!table) return;
    table.querySelector('thead tr').innerHTML = '<th>客户</th><th>行业</th><th>规模</th><th>年收入</th><th>负责人</th><th>商机数</th>';
    const tbody = table.querySelector('tbody');
    if (!items?.length) { tbody.innerHTML = `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无客户档案，点击「新建客户」开始</p></td></tr>`; return; }
    const colors = ['blue','green','amber','violet','teal'];
    tbody.innerHTML = items.map((a,i) => `
      <tr data-id="${a.id}" class="clickable-row">
        <td><div class="entity"><span class="project-code ${colors[i%5]}">${esc(a.name).slice(0,2)}</span><b>${esc(a.name)}</b></div></td>
        <td>${esc(a.industry||'—')}</td>
        <td>${esc(a.company_size||'—')}</td>
        <td>${money(a.annual_revenue_cents)}</td>
        <td><span class="person-chip">${avatar(a.owner_name)}</span>${esc(a.owner_name||'—')}</td>
        <td>${a.opp_count||0}</td>
      </tr>`).join('');
    tbody.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openAccountDetail(tr.dataset.id)));
  } catch(e) { console.warn('crm accounts:', e.message); }
}

async function renderCRMConfig(el) {
  try {
    const { settings } = await API.get('/v1/settings/crm').catch(() => ({ settings: {} }));
    const stages = settings.pipeline_stages || ['qualification','proposal','negotiation','contract'];
    const stageNames = { qualification:'需求确认', proposal:'方案提报', negotiation:'商务谈判', contract:'合同签署', won:'赢单', lost:'丢单' };
    el.innerHTML = `<div style="padding:20px">
      <h3 style="font-size:12px;margin-bottom:16px">CRM 系统配置</h3>
      <div class="panel" style="padding:16px;margin-bottom:16px">
        <h4 style="margin:0 0 12px;font-size:10px;color:var(--muted)">销售漏斗阶段</h4>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;align-items:center">
          ${stages.map((s,i) => `<span class="tag-chip" style="padding:6px 12px;font-weight:600">${i+1}. ${stageNames[s]||s}</span>${i<stages.length-1?'<span style="color:var(--muted)">→</span>':''}`).join('')}
          <span style="color:var(--muted)">→</span><span class="tag-chip" style="padding:6px 12px;background:var(--jade-soft);color:var(--jade)">赢单</span>
        </div>
        <p style="font-size:9px;color:var(--muted);margin-bottom:12px">当前销售阶段顺序如上，可通过修改下方配置调整。</p>
        <div class="form-row" style="margin-bottom:10px">
          <span>赢单概率默认值（%）</span>
          <input id="crm-default-prob" type="number" value="${settings.default_win_probability||60}" min="0" max="100" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%">
        </div>
        <div class="form-row" style="margin-bottom:10px">
          <span>商机提醒天数（超期未更新）</span>
          <input id="crm-stale-days" type="number" value="${settings.stale_opportunity_days||30}" min="1" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%">
        </div>
        <button class="btn primary small" id="save-crm-config">保存 CRM 配置</button>
      </div>
      <div class="panel" style="padding:16px">
        <h4 style="margin:0 0 12px;font-size:10px;color:var(--muted)">客户行业分类</h4>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${['零售','科技','制造','金融','医疗','教育','房地产','其他'].map(v => `<span class="tag-chip" style="padding:5px 10px">${v}</span>`).join('')}
        </div>
      </div>
    </div>`;
    el.querySelector('#save-crm-config')?.addEventListener('click', async () => {
      const s = {
        default_win_probability: Number(document.getElementById('crm-default-prob').value),
        stale_opportunity_days: Number(document.getElementById('crm-stale-days').value)
      };
      try { await API.patch('/v1/settings/crm', s); toast('CRM 配置已保存'); } catch(e) { toast(e.message,'error'); }
    });
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function openOpportunityDetail(id) {
  Drawer.show('商机详情', '<p class="loading-text">加载中…</p>');
  try {
    const o = await API.get(`/v1/crm/opportunities/${id}`);
    Drawer.setBody(`
      <div class="detail-header">
        <span class="project-code amber">${esc(o.customer_name).slice(0,2)}</span>
        <div><h3>${esc(o.name)}</h3><p>${esc(o.customer_name)}</p></div>
      </div>
      <div class="detail-stats">
        <div><small>合同金额</small><strong>${money(o.amount_cents)}</strong></div>
        <div><small>赢单率</small><strong>${o.win_probability}%</strong></div>
        <div><small>阶段</small><strong>${STAGE_MAP[o.stage]||o.stage}</strong></div>
        <div><small>预计签约</small><strong>${fmtDate(o.expected_close_date)}</strong></div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
        ${Object.keys(STAGE_MAP).filter(s => s !== o.stage && !['won','lost'].includes(o.stage)).map(s =>
          `<button class="btn ghost small" onclick="advanceStage('${id}','${s}')">→ ${STAGE_MAP[s]}</button>`
        ).join('')}
        ${o.stage !== 'won' ? `<button class="btn primary small" onclick="advanceStage('${id}','won')">赢单 ✓</button>` : ''}
        ${o.stage !== 'lost' ? `<button class="btn danger-ghost small" onclick="openLostModal('${id}')">丢单</button>` : ''}
        <button class="btn ghost small" type="button" id="edit-opportunity-btn">编辑商机</button>
      </div>
      <div class="detail-section">
        <div class="section-head"><h4>联系人 <span class="badge">${o.contacts?.length||0}</span></h4>
        <button class="btn ghost small" onclick="openAddContactModal('${id}')">＋ 添加</button></div>
        ${(o.contacts||[]).map(c => `
          <div class="contact-row">
            <span class="person-chip sm">${avatar(c.name)}</span>
            <div style="flex:1"><b>${esc(c.name)}</b><small>${esc(c.title||'')} ${esc(c.company||'')}</small></div>
            ${c.is_key_decision_maker ? '<em class="kdm">决策人</em>' : ''}
            ${c.email ? `<small style="color:var(--blue)">${esc(c.email)}</small>` : ''}
          </div>`).join('') || '<p class="empty-hint">暂无联系人</p>'}
      </div>
      <div class="detail-section">
        <div class="section-head"><h4>跟进记录 <span class="badge">${o.activities?.length||0}</span></h4>
        <button class="btn ghost small" onclick="openAddActivityModal('${id}')">＋ 记录</button></div>
        ${(o.activities||[]).slice(0,8).map(a => `
          <div class="activity-row">
            <span class="activity-type">${ACT_MAP[a.activity_type]||a.activity_type}</span>
            <div><b>${esc(a.title)}</b><small>${ago(a.occurred_at)} · ${esc(a.actor_name||'')}</small>${a.summary?`<p style="margin:3px 0 0;font-size:8px;color:var(--muted)">${esc(a.summary)}</p>`:''}</div>
          </div>`).join('') || '<p class="empty-hint">暂无跟进记录</p>'}
      </div>
      ${o.next_step ? `<div class="detail-section"><h4>下一步行动</h4><p style="font-size:9px">${esc(o.next_step)}</p></div>` : ''}
    `);
    document.getElementById('edit-opportunity-btn')?.addEventListener('click', () => openEditOpportunityModal(o));
    window.advanceStage = (oppId, stage) => {
      if (stage === 'won') {
        Modal.show('确认赢单', `
          <div class="form-row"><span>签约金额（元）</span><input type="number" name="amount_yuan" placeholder="最终签约金额"></div>
          <div class="form-row"><span>下一步</span><input name="next_step" placeholder="如：启动项目交付"></div>
        `, async (data) => {
          await API.post(`/v1/crm/opportunities/${oppId}/stage`, { stage: 'won', amount_cents: data.amount_yuan ? data.amount_yuan*100 : undefined, next_step: data.next_step });
          toast('恭喜赢单！');
          openOpportunityDetail(oppId);
        });
      } else {
        API.post(`/v1/crm/opportunities/${oppId}/stage`, { stage }).then(() => { toast('阶段已更新'); openOpportunityDetail(oppId); }).catch(e => toast(e.message,'error'));
      }
    };
    window.openLostModal = (oppId) => {
      Modal.show('丢单说明', `
        <div class="form-row"><span>丢单原因 <i class="req">*</i></span><select name="reason">
          <option value="price">价格原因</option><option value="competitor">竞争对手</option>
          <option value="timing">时机不对</option><option value="budget">预算冻结</option>
          <option value="requirement">需求不匹配</option><option value="other">其他</option>
        </select></div>
        <div class="form-row"><span>详情</span><textarea name="lost_reason" rows="3"></textarea></div>
      `, async (data) => {
        await API.post(`/v1/crm/opportunities/${oppId}/stage`, { stage: 'lost', lost_reason: `${data.reason}: ${data.lost_reason||''}` });
        toast('已标记丢单');
        openOpportunityDetail(oppId);
      });
    };
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

async function openAccountDetail(id) {
  Drawer.show('客户档案', '<p class="loading-text">加载中…</p>');
  try {
    const a = await API.get(`/v1/crm/accounts/${id}`);
    Drawer.setBody(`
      <div class="detail-header">
        <span class="project-code blue">${esc(a.name).slice(0,2)}</span>
        <div><h3>${esc(a.name)}</h3><p>${esc(a.industry||'—')} · ${esc(a.company_size||'—')}</p></div>
      </div>
      <div class="detail-stats">
        <div><small>年收入</small><strong>${money(a.annual_revenue_cents)}</strong></div>
        <div><small>商机数</small><strong>${(a.opportunities||[]).length}</strong></div>
        <div><small>信用等级</small><strong>${a.credit_rating||'—'}</strong></div>
        <div><small>负责人</small><strong>${esc(a.owner_name||'—')}</strong></div>
      </div>
      ${a.website ? `<p style="font-size:9px;color:var(--muted)">🌐 <a href="${safeUrl(a.website)}" target="_blank" style="color:var(--blue)">${esc(a.website)}</a></p>` : ''}
      <button class="btn ghost small" type="button" id="edit-account-btn" style="margin-bottom:10px">编辑客户档案</button>
      <div class="detail-section">
        <div class="section-head"><h4>相关商机 <span class="badge">${(a.opportunities||[]).length}</span></h4>
        <button class="btn ghost small" data-act="create-opp-account" data-id="${esc(a.id)}" data-name="${esc(a.name)}">＋ 新建商机</button></div>
        ${(a.opportunities||[]).map(o => `
          <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px;cursor:pointer" onclick="openOpportunityDetail('${o.id}')">
            <b style="font-size:10px">${esc(o.name)}</b>
            <span class="status-pill">${STAGE_MAP[o.stage]||o.stage}</span>
            <span>${money(o.amount_cents)}</span>
          </div>`).join('') || '<p class="empty-hint">暂无商机</p>'}
      </div>
      <div class="detail-section">
        <div class="section-head"><h4>联系人 <span class="badge">${(a.contacts||[]).length}</span></h4>
        <button class="btn ghost small" onclick="openAddAccountContactModal('${a.id}')">＋ 添加</button></div>
        ${(a.contacts||[]).map(c => `
          <div class="contact-row">
            <span class="person-chip sm">${avatar(c.name)}</span>
            <div style="flex:1"><b>${esc(c.name)}</b><small>${esc(c.title||'')}</small></div>
            ${c.is_key_decision_maker ? '<em class="kdm">决策人</em>' : ''}
          </div>`).join('') || '<p class="empty-hint">暂无联系人</p>'}
      </div>`);
    document.getElementById('edit-account-btn')?.addEventListener('click', () => openEditAccountModal(a));
    window.openCreateOppForAccount = (accountId, accountName) => {
      Modal.show(`新建商机 · ${accountName}`, `
        <div class="form-row"><span>商机名称 <i class="req">*</i></span><input name="name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>金额（元）</span><input type="number" name="amount_yuan" min="0"></div>
          <div class="form-row"><span>赢单率(%)</span><input type="number" name="win_probability" value="60" min="0" max="100"></div>
        </div>
        <div class="form-row"><span>预计签约</span><input type="date" name="expected_close_date"></div>
        ${PersonPicker.html('owner_person_id','销售负责人')}
      `, async (data) => {
        await API.post('/v1/crm/opportunities', { name: data.name, customer_name: accountName, account_id: accountId, amount_cents: (data.amount_yuan||0)*100, win_probability: data.win_probability, expected_close_date: data.expected_close_date, owner_person_id: data.owner_person_id });
        toast('商机已创建'); openAccountDetail(id);
      });
    };
    window.openAddAccountContactModal = (accId) => {
      Modal.show('添加联系人', `
        <div class="form-row"><span>姓名 <i class="req">*</i></span><input name="name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>职位</span><input name="title"></div>
          <div class="form-row"><span>邮箱</span><input type="email" name="email"></div>
        </div>
        <div class="form-row checkbox"><input type="checkbox" name="is_key_decision_maker"><span>关键决策人</span></div>
      `, async (data) => {
        await API.post(`/v1/crm/accounts/${accId}/contacts`, data);
        toast('联系人已添加'); openAccountDetail(id);
      });
    };
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

function openEditAccountModal(a) {
  Modal.show('编辑客户档案', `
    <div class="form-row"><span>客户名称 <i class="req">*</i></span><input name="name" value="${esc(a.name)}" required></div>
    <div class="form-cols">
      <div class="form-row"><span>行业</span><input name="industry" value="${esc(a.industry || '')}"></div>
      <div class="form-row"><span>规模</span><input name="company_size" value="${esc(a.company_size || '')}"></div>
    </div>
    <div class="form-row"><span>网站</span><input name="website" value="${esc(a.website || '')}"></div>
    <div class="form-cols">
      <div class="form-row"><span>年收入（元）</span><input type="number" name="revenue_yuan" min="0" value="${Math.round(Number(a.annual_revenue_cents || 0) / 100)}"></div>
      <div class="form-row"><span>信用等级</span><input name="credit_rating" value="${esc(a.credit_rating || '')}"></div>
    </div>
  `, async (data) => {
    await API.patch(`/v1/crm/accounts/${a.id}`, {
      name: data.name,
      industry: data.industry,
      company_size: data.company_size,
      website: data.website,
      annual_revenue_cents: Math.round((Number(data.revenue_yuan) || 0) * 100),
      credit_rating: data.credit_rating,
    });
    toast('客户档案已更新');
    openAccountDetail(a.id);
    loadCRMData();
  });
}

function openEditOpportunityModal(o) {
  Modal.show('编辑商机', `
    <div class="form-row"><span>商机名称 <i class="req">*</i></span><input name="name" value="${esc(o.name)}" required></div>
    <div class="form-row"><span>客户名称 <i class="req">*</i></span><input name="customer_name" value="${esc(o.customer_name)}" required></div>
    <div class="form-cols">
      <div class="form-row"><span>金额（元）</span><input type="number" name="amount_yuan" min="0" value="${Math.round(Number(o.amount_cents || 0) / 100)}"></div>
      <div class="form-row"><span>赢单率(%)</span><input type="number" name="win_probability" min="0" max="100" value="${Number(o.win_probability) || 0}"></div>
    </div>
    <div class="form-row"><span>预计签约</span><input type="date" name="expected_close_date" value="${o.expected_close_date ? String(o.expected_close_date).slice(0, 10) : ''}"></div>
    <div class="form-row"><span>下一步</span><input name="next_step" value="${esc(o.next_step || '')}"></div>
  `, async (data) => {
    await API.patch(`/v1/crm/opportunities/${o.id}`, {
      name: data.name,
      customer_name: data.customer_name,
      amount_cents: Math.round((Number(data.amount_yuan) || 0) * 100),
      win_probability: data.win_probability,
      expected_close_date: data.expected_close_date,
      next_step: data.next_step,
    });
    toast('商机已更新');
    openOpportunityDetail(o.id);
    loadCRMData();
  });
}

function openAddContactModal(oppId) {
  Modal.show('添加联系人', `
    <div class="form-row"><span>姓名 <i class="req">*</i></span><input name="name" required></div>
    <div class="form-cols">
      <div class="form-row"><span>职位</span><input name="title" placeholder="职位/职能"></div>
      <div class="form-row"><span>公司</span><input name="company"></div>
    </div>
    <div class="form-row"><span>邮箱</span><input type="email" name="email"></div>
    <div class="form-row checkbox"><input type="checkbox" name="is_key_decision_maker"><span>关键决策人</span></div>
  `, async (data) => {
    await API.post(`/v1/crm/opportunities/${oppId}/contacts`, data);
    toast('联系人已添加'); openOpportunityDetail(oppId);
  });
}
window.openAddContactModal = openAddContactModal;

function openAddActivityModal(oppId) {
  Modal.show('添加跟进记录', `
    <div class="form-row"><span>标题 <i class="req">*</i></span><input name="title" required></div>
    <div class="form-row"><span>类型</span><select name="activity_type">
      <option value="call">电话</option><option value="meeting">拜访</option>
      <option value="email">邮件</option><option value="demo">产品演示</option>
      <option value="proposal">提案</option><option value="note">备注</option>
    </select></div>
    <div class="form-row"><span>摘要</span><textarea name="summary" rows="3" placeholder="本次跟进的关键内容…"></textarea></div>
    <div class="form-cols">
      <div class="form-row"><span>跟进结果</span><input name="outcome" placeholder="客户反应、决策信号…"></div>
      <div class="form-row"><span>下一步行动</span><input name="next_action"></div>
    </div>
  `, async (data) => {
    await API.post(`/v1/crm/opportunities/${oppId}/activities`, data);
    toast('跟进记录已保存'); openOpportunityDetail(oppId);
  });
}
window.openAddActivityModal = openAddActivityModal;

// ──────────────────────────────────────────────────────────────
// ── HR 人才模块
// ──────────────────────────────────────────────────────────────
const CAND_STATUS = { new:'新简历',resume_screening:'简历筛选',phone_screening:'电话筛选',technical_interview:'技术面',hr_interview:'HR面',final_interview:'终面',offer_pending:'Offer拟定',offer_sent:'Offer已发',offer_accepted:'已接受',hired:'已入职',rejected:'已淘汰' };
const LEAVE_TYPE = { annual:'年假',sick:'病假',personal:'事假',marriage:'婚假',maternity:'产假',paternity:'陪产假',bereavement:'丧假',compensatory:'调休' };

let _hrTab = 'recruitment';

async function loadRecruitment(container) {
  try {
    const { items } = await API.get('/v1/hr/requisitions?limit=20');
    const table = ensureTable(container, 5);
    if (!table) return;
    table.querySelector('thead tr').innerHTML = '<th>岗位</th><th>招聘人数</th><th>候选人</th><th>状态</th><th>创建时间</th>';
    const tbody = table.querySelector('tbody');
    if (!items?.length) { tbody.innerHTML = `<tr><td colspan="5"><p class="empty-hint" style="padding:20px">暂无招聘需求</p></td></tr>`; return; }
    const colors = ['blue','green','amber','violet','teal'];
    tbody.innerHTML = items.map((r,i) => `
      <tr data-id="${r.id}" class="clickable-row">
        <td><div class="entity"><span class="project-code ${colors[i%5]}">${esc(r.title).slice(0,2)}</span><b>${esc(r.title)}</b></div></td>
        <td>${r.headcount}人</td>
        <td><span class="badge">${r.candidate_count||0}</span> 位候选人</td>
        <td><span class="status-pill">${{draft:'草稿',open:'招聘中',approved:'已审批',closed:'已关闭'}[r.status]||r.status}</span></td>
        <td>${ago(r.created_at)}</td>
      </tr>`).join('');
    tbody.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openRequisitionDetail(tr.dataset.id)));
  } catch(e) { console.warn('hr recruitment:', e.message); }
}

async function loadLeaveRequests(container) {
  try {
    const { items } = await API.get('/v1/hr/leave-requests?limit=50');
    const table = ensureTable(container, 6);
    if (!table) return;
    table.querySelector('thead tr').innerHTML = '<th>申请人</th><th>假期类型</th><th>时间</th><th>天数</th><th>状态</th><th>操作</th>';
    const tbody = table.querySelector('tbody');
    if (!items?.length) { tbody.innerHTML = `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无请假申请</p></td></tr>`; return; }
    tbody.innerHTML = items.map(lr => `
      <tr>
        <td><span class="person-chip">${avatar(lr.person_name)}</span>${esc(lr.person_name||'—')}</td>
        <td><span class="leave-type-tag">${LEAVE_TYPE[lr.leave_type]||lr.leave_type}</span></td>
        <td>${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)}</td>
        <td>${lr.days}天</td>
        <td><span class="status-pill ${lr.status==='rejected'?'warning':lr.status==='approved'?'':''}">${{pending:'待审批',approved:'已批准',rejected:'已拒绝'}[lr.status]||lr.status}</span></td>
        <td>${lr.status==='pending'&&can('hr.leave.approve')?`<button class="btn ghost small" onclick="approveLeave('${lr.id}','approved')">批准</button> <button class="btn danger-ghost small" onclick="approveLeave('${lr.id}','rejected')">拒绝</button>`:'—'}</td>
      </tr>`).join('');
    window.approveLeave = async (id, status) => {
      try { await API.patch(`/v1/hr/leave-requests/${id}`, { status }); toast(status==='approved'?'已批准':'已拒绝'); loadHRData(); } catch(e) { toast(e.message,'error'); }
    };
  } catch(e) { console.warn('hr leave:', e.message); }
}

async function openRequisitionDetail(reqId) {
  Drawer.show('招聘需求', '<p class="loading-text">加载中…</p>');
  try {
    const r = await API.get(`/v1/hr/requisitions/${reqId}`);
    const kanbanStages = ['new','phone_screening','technical_interview','hr_interview','offer_sent'];
    Drawer.setBody(`
      <div class="detail-header">
        <span class="project-code violet">JD</span>
        <div><h3>${esc(r.title)}</h3><p>需求人数 ${r.headcount}人 · ${{draft:'草稿',open:'招聘中',approved:'已审批',closed:'已关闭'}[r.status]||r.status}</p></div>
      </div>
      ${r.reason ? `<p class="detail-reason">${esc(r.reason)}</p>` : ''}
      <div style="display:flex;gap:6px;margin-bottom:16px">
        <button class="btn ghost small" onclick="openAddCandidateModal('${reqId}')">＋ 录入候选人</button>
      </div>
      <div class="detail-section">
        <h4>候选人看板 <span class="badge">${r.candidates?.length||0}</span></h4>
        <div class="candidate-kanban">
          ${kanbanStages.map(s => {
            const label = {new:'新简历',phone_screening:'电话筛',technical_interview:'技术面',hr_interview:'HR面',offer_sent:'Offer中'}[s];
            const cands = (r.candidates||[]).filter(c => c.status === s);
            return `<div class="kanban-col">
              <div class="kanban-col-head">${label} <span class="badge">${cands.length}</span></div>
              ${cands.map(c => `<div class="kanban-card" onclick="openCandidateDetail('${c.id}')">
                <b>${esc(c.name)}</b>
                <small>${esc(c.current_company||c.source||'')}</small>
              </div>`).join('') || '<div class="kanban-empty">—</div>'}
            </div>`;
          }).join('')}
        </div>
      </div>`);
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

async function openCandidateDetail(candidateId) {
  Drawer.show('候选人', '<p class="loading-text">加载中…</p>');
  try {
    const c = await API.get(`/v1/hr/candidates/${candidateId}`);
    Drawer.setBody(`
      <div class="detail-header">
        <span class="project-code teal">${avatar(c.name)}</span>
        <div><h3>${esc(c.name)}</h3><p>${esc(c.current_title||'')} · ${esc(c.current_company||'')}</p></div>
      </div>
      <div class="detail-stats">
        <div><small>状态</small><strong>${CAND_STATUS[c.status]||c.status}</strong></div>
        <div><small>经验</small><strong>${c.years_of_experience?c.years_of_experience+'年':'—'}</strong></div>
        <div><small>来源</small><strong>${{active_sourcing:'主动寻访',referral:'内推',job_board:'招聘平台',linkedin:'LinkedIn',headhunter:'猎头',campus:'校招'}[c.source]||c.source}</strong></div>
        <div><small>邮箱</small><strong style="font-size:9px">${esc(c.email||'—')}</strong></div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn ghost small" onclick="pushCandidateStage('${c.id}')">推进阶段</button>
        <button class="btn primary small" data-act="create-offer" data-id="${esc(c.id)}" data-name="${esc(c.name)}">发起 Offer</button>
        <button class="btn danger-ghost small" onclick="updateCandidateStatus('${c.id}','rejected')">淘汰</button>
        <button class="btn ghost small" onclick="openOnboarding('${c.id}')">查看入职清单</button>
      </div>
      <div class="detail-section">
        <h4>面试记录</h4>
        ${(c.interviews||[]).map(iv => `
          <div class="interview-row">
            <b>第${iv.round}轮</b>
            <span class="status-pill">${{scheduled:'已安排',completed:'已完成',cancelled:'已取消'}[iv.status]||iv.status}</span>
            <small>${new Date(iv.scheduled_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small>
          </div>`).join('') || '<p class="empty-hint">暂无面试记录</p>'}
      </div>`);
    window.pushCandidateStage = (id) => {
      const nextStages = Object.keys(CAND_STATUS).filter(s => !['hired','rejected'].includes(s));
      Modal.show('推进到下一阶段', `
        <div class="form-row"><span>新状态</span><select name="status">
          ${nextStages.map(s => `<option value="${s}">${CAND_STATUS[s]}</option>`).join('')}
        </select></div>
      `, async (data) => {
        await API.patch(`/v1/hr/candidates/${id}`, { status: data.status });
        toast('状态已更新'); openCandidateDetail(id);
      });
    };
    window.openOnboarding = async (cid) => {
      Drawer.setBody('<p class="loading-text">加载入职清单…</p>');
      try {
        const { items } = await API.get(`/v1/hr/candidates/${cid}/onboarding`);
        Drawer.setBody(`
          <h3 style="margin-bottom:16px">入职清单 <span class="badge">${items.filter(i=>i.status==='completed').length}/${items.length}</span></h3>
          ${items.map(t => `
            <div class="onboarding-check ${t.status==='completed'?'done':''}">
              <input type="checkbox" ${t.status==='completed'?'checked':''} onchange="toggleOnboarding('${t.id}',this.checked)">
              <span class="category-dot" style="background:${{it:'var(--blue)',legal:'#b97518',team:'var(--jade)',training:'#8b5cf6',hr:'var(--ink)'}[t.category]||'var(--muted)'}"></span>
              <span style="flex:1">${esc(t.title)}</span>
              <small style="color:var(--muted)">${{it:'IT',legal:'法务',team:'团队',training:'培训',hr:'HR'}[t.category]||t.category}</small>
            </div>`).join('')}
          <button class="btn ghost small" style="margin-top:12px" onclick="openCandidateDetail('${cid}')">← 返回</button>`);
        window.toggleOnboarding = async (taskId, checked) => {
          try { await API.patch(`/v1/hr/onboarding-tasks/${taskId}`, { status: checked ? 'completed' : 'pending' }); toast(checked?'已完成':'已重置'); } catch(e) { toast(e.message,'error'); }
        };
      } catch { Drawer.setBody('<p class="error-hint">加载失败</p>'); }
    };
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

function openAddCandidateModal(reqId) {
  Modal.show('录入候选人', `
    <div class="form-row"><span>姓名 <i class="req">*</i></span><input name="name" required></div>
    <div class="form-cols">
      <div class="form-row"><span>当前公司</span><input name="current_company"></div>
      <div class="form-row"><span>当前职位</span><input name="current_title"></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>邮箱</span><input type="email" name="email"></div>
      <div class="form-row"><span>工作年限</span><input type="number" name="years_of_experience" min="0" max="40"></div>
    </div>
    <div class="form-row"><span>来源</span><select name="source">
      <option value="active_sourcing">主动寻访</option><option value="referral">内推</option>
      <option value="job_board">招聘平台</option><option value="linkedin">LinkedIn</option>
      <option value="headhunter">猎头</option><option value="campus">校招</option>
    </select></div>
    <div class="form-row"><span>简历链接</span><input name="resume_url" placeholder="https://…"></div>
  `, async (data) => {
    await API.post('/v1/hr/candidates', { ...data, requisition_id: reqId });
    toast('候选人已录入'); openRequisitionDetail(reqId);
  });
}

function openCreateOfferModal(candidateId, candidateName) {
  Modal.show(`发起 Offer · ${candidateName}`, `
    <div class="form-row"><span>职位名称 <i class="req">*</i></span><input name="position_title" required></div>
    <div class="form-row"><span>部门</span><input name="department"></div>
    <div class="form-cols">
      <div class="form-row"><span>年薪（元）<i class="req">*</i></span><input type="number" name="base_salary_annual" required min="0"></div>
      <div class="form-row"><span>年终奖（元）</span><input type="number" name="bonus_annual" min="0"></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>期望入职日期</span><input type="date" name="expected_start_date"></div>
      <div class="form-row"><span>Offer 有效期</span><input type="date" name="offer_expires_at"></div>
    </div>
    <p style="font-size:8px;color:var(--muted);padding:8px;background:var(--jade-soft);border-radius:6px">Offer 发出后将通知候选人（飞书配置后自动推送）</p>
  `, async (data) => {
    await API.post(`/v1/hr/candidates/${candidateId}/offers`, data);
    toast('Offer 已创建，状态更新为待发送');
    openCandidateDetail(candidateId);
  });
}

async function updateCandidateStatus(candidateId, status) {
  try { await API.patch(`/v1/hr/candidates/${candidateId}`, { status }); toast('状态已更新'); openCandidateDetail(candidateId); }
  catch(e) { toast(e.message, 'error'); }
}

// ──────────────────────────────────────────────────────────────
// ── 财务管理模块
// ──────────────────────────────────────────────────────────────
const EXP_CAT = { travel:'差旅',meals:'餐饮',office:'办公',software:'软件',marketing:'市场',training:'培训',operations:'运营',other:'其他' };

let _financeTab = 'overview';

async function loadFinanceData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  const toolbar = container.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('[data-fin-tab]')) {
    toolbar.innerHTML = `
      <div class="filter-tabs">
        <button class="${_financeTab==='overview'?'active':''}" data-fin-tab="overview">财务总览</button>
        <button class="${_financeTab==='expenses'?'active':''}" data-fin-tab="expenses">费用报销</button>
        <button class="${_financeTab==='budgets'?'active':''}" data-fin-tab="budgets">预算管理</button>
        <button class="${_financeTab==='invoices'?'active':''}" data-fin-tab="invoices">发票管理</button>
        <button class="${_financeTab==='payments'?'active':''}" data-fin-tab="payments">收款计划</button>
        <button class="${_financeTab==='finconfig'?'active':''}" data-fin-tab="finconfig">财务配置</button>
      </div>`;
    toolbar.querySelectorAll('[data-fin-tab]').forEach(btn => {
      btn.addEventListener('click', () => { _financeTab = btn.dataset.finTab; loadFinanceData(); });
    });
  } else {
    toolbar?.querySelectorAll('[data-fin-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.finTab === _financeTab));
  }
  const table = container.querySelector('.data-table-wrap');
  if (!table) return;

  if (_financeTab === 'overview') await renderFinanceOverview(table);
  else if (_financeTab === 'expenses') await renderExpenses(table);
  else if (_financeTab === 'budgets') await renderBudgets(table);
  else if (_financeTab === 'invoices') await renderInvoices(table);
  else if (_financeTab === 'payments') await renderPayments(table);
  else await renderFinanceConfig(table);
}

async function renderFinanceOverview(el) {
  try {
    const overview = await API.get('/v1/finance/overview');
    const p = overview.payments, ex = overview.expenses, inv = overview.invoices;
    const finStats = document.querySelectorAll('.module-metrics .metric-card strong');
    // 没有银行账户聚合，就明确显示“未接入”，不用“—”让用户以为是加载失败。
    if (finStats[0]) { finStats[0].textContent = '未接入'; finStats[0].title = '银行账户/资金池尚未接入，接入后显示可用余额'; }
    if (finStats[1]) finStats[1].textContent = money(p?.collected_total ?? 0);
    if (finStats[2]) finStats[2].textContent = money(ex?.month_expenses ?? 0);
    if (finStats[3]) finStats[3].textContent = money(inv?.outstanding_receivable ?? 0);
    el.innerHTML = `
      <div style="padding:20px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
        <div class="panel" style="padding:16px">
          <div class="eyebrow" style="margin-bottom:8px"><span></span>收款</div>
          <div style="font:600 22px var(--mono);margin:8px 0">${money(p?.collected_total)}</div>
          <div style="font-size:9px;color:var(--muted)">已收款合计</div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line-soft)">
            <div style="display:flex;justify-content:space-between;font-size:9px">
              <span>30天内到期</span><b>${money(p?.upcoming_receivable)}</b>
            </div>
            ${p?.overdue_count > 0 ? `<div style="margin-top:6px;color:var(--red);font-size:9px">⚠ ${p.overdue_count} 笔逾期未收款</div>` : ''}
          </div>
        </div>
        <div class="panel" style="padding:16px">
          <div class="eyebrow" style="margin-bottom:8px"><span></span>费用</div>
          <div style="font:600 22px var(--mono);margin:8px 0">${money(ex?.month_expenses)}</div>
          <div style="font-size:9px;color:var(--muted)">本月已报销</div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line-soft)">
            <div style="display:flex;justify-content:space-between;font-size:9px">
              <span>待审批</span><b>${money(ex?.pending_expenses)}</b>
            </div>
          </div>
        </div>
        <div class="panel" style="padding:16px">
          <div class="eyebrow" style="margin-bottom:8px"><span></span>应收</div>
          <div style="font:600 22px var(--mono);margin:8px 0">${money(inv?.outstanding_receivable)}</div>
          <div style="font-size:9px;color:var(--muted)">未收发票金额</div>
        </div>
      </div>`;
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${e.message}</p>`; }
}

let _financeDetailRows = { expense: [], invoice: [], payment: [] };

async function openFinanceDetail(kind, idx) {
  const row = _financeDetailRows[kind]?.[Number(idx)];
  if (!row) return;
  if (kind === 'expense') {
    Drawer.show('报销详情', '<p class="loading-text">加载中…</p>');
    try {
      const e = await API.get(`/v1/finance/expenses/${row.id}`);
      Drawer.setBody(`
        <div class="detail-header"><span class="project-code amber">¥</span><div><h3>${esc(e.description || '报销')}</h3><p>${esc(e.submitter_name || '')} · ${fmtDate(e.expense_date)}</p></div></div>
        <div class="detail-stats">
          <div><small>金额</small><strong>${money(e.amount_cents)}</strong></div>
          <div><small>类别</small><strong>${esc(EXP_CAT[e.category] || e.category)}</strong></div>
          <div><small>状态</small><strong>${esc({ draft: '草稿', submitted: '待审批', approved: '已批准', rejected: '已拒绝', paid: '已报销' }[e.status] || e.status)}</strong></div>
          <div><small>预算</small><strong>${e.budget_id ? '已关联' : '未关联'}</strong></div>
        </div>
        <div class="detail-section"><h4>审批与凭证</h4>
          <p style="font-size:10px;line-height:1.8;color:var(--muted)">提交时间：${new Date(e.created_at).toLocaleString('zh-CN')}<br>
          审批人：${esc(e.approver_name || '待指派')}<br>通过时间：${e.approved_at ? new Date(e.approved_at).toLocaleString('zh-CN') : '—'}<br>
          凭证：${(e.receipt_urls || []).length ? esc((e.receipt_urls || []).join('、')) : '未上传'}</p>
        </div>`);
    } catch (err) { Drawer.setBody(`<p class="error-hint">加载失败：${esc(err.message)}</p>`); }
    return;
  }
  const isInvoice = kind === 'invoice';
  Drawer.show(isInvoice ? '发票详情' : '收款计划详情', `
    <div class="detail-header"><span class="project-code ${isInvoice ? 'blue' : 'green'}">${isInvoice ? '票' : '¥'}</span>
      <div><h3>${esc(isInvoice ? (row.invoice_number || '发票') : row.customer_name)}</h3>
      <p>${esc(isInvoice ? row.counterparty_name : row.milestone)}</p></div></div>
    <div class="detail-stats">
      <div><small>金额</small><strong>${money(row.amount_cents)}</strong></div>
      <div><small>${isInvoice ? '已核销' : '预计到账'}</small><strong>${isInvoice ? money(row.paid_cents) : fmtDate(row.due_date)}</strong></div>
      <div><small>状态</small><strong>${esc(row.status)}</strong></div>
      <div><small>${isInvoice ? '到期日' : '项目'}</small><strong>${isInvoice ? fmtDate(row.due_date) : esc(row.project_name || '—')}</strong></div>
    </div>
    <div class="detail-section"><h4>说明</h4><p style="font-size:10px;color:var(--muted)">${esc(row.notes || row.payment_terms || '—')}</p></div>`);
}

async function renderExpenses(el) {
  try {
    const { items } = await API.get('/v1/finance/expenses?limit=50');
    _financeDetailRows.expense = items || [];
    el.innerHTML = `<table class="data-table"><thead><tr><th>申请人</th><th>类别</th><th>金额</th><th>日期</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${!items?.length ? `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无报销记录</p></td></tr>` :
      items.map((e, i) => `<tr>
        <td><span class="person-chip">${avatar(e.submitter_name)}</span>${esc(e.submitter_name||'—')}</td>
        <td>${EXP_CAT[e.category]||e.category}</td>
        <td><b>${money(e.amount_cents)}</b></td>
        <td>${fmtDate(e.expense_date)}</td>
        <td><span class="status-pill ${e.status==='rejected'?'warning':''}">${{submitted:'待审批',approved:'已批准',rejected:'已拒绝',paid:'已报销',draft:'草稿'}[e.status]||e.status}</span></td>
        <td><button class="btn ghost small" data-fin-kind="expense" data-fin-idx="${i}">详情</button>${e.status==='submitted'&&can('finance.approve')?` <button class="btn ghost small" onclick="approveExpense('${e.id}',true)">批准</button> <button class="btn danger-ghost small" onclick="approveExpense('${e.id}',false)">拒绝</button>`:''}</td>
      </tr>`).join('')}</tbody></table>`;
    window.approveExpense = async (id, approved) => {
      try { await API.post(`/v1/finance/expenses/${id}/approve`, { approved }); toast(approved?'已批准':'已拒绝'); loadFinanceData(); } catch(e) { toast(e.message,'error'); }
    };
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function renderBudgets(el) {
  try {
    const year = new Date().getFullYear();
    const { items } = await API.get(`/v1/finance/budgets?year=${year}`);
    if (!items?.length) { el.innerHTML = `<div style="padding:20px"><p class="empty-hint">本年度暂无预算，点击「设置预算」开始</p></div>`; return; }
    el.innerHTML = `<div style="padding:20px">
      ${items.map(b => {
        const used = Number(b.actual_spent_cents||0);
        const total = Number(b.total_amount_cents||1);
        const pctUsed = Math.min(100, Math.round(used/total*100));
        const isOver = pctUsed >= 100;
        return `<div class="budget-bar-row">
          <div class="budget-bar-info">
            <span class="budget-bar-label">${EXP_CAT[b.category]||b.category} <small style="color:var(--muted);font-weight:normal">${esc(b.org_unit_name||'全公司')}</small></span>
            <span class="budget-bar-amounts">${money(used)} / ${money(total)} ${isOver?'<b style="color:var(--red)">超支</b>':''}</span>
          </div>
          <div class="budget-track"><div class="budget-fill${isOver?' over':''}" style="width:${pctUsed}%"></div></div>
          <div style="font-size:8px;color:var(--muted);margin-top:3px">${pctUsed}% 已使用 · 剩余 ${money(b.remaining_cents)}</div>
        </div>`;
      }).join('')}
    </div>`;
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function renderInvoices(el) {
  try {
    const { items } = await API.get('/v1/finance/invoices?limit=50');
    const canWo = can('finance.manage');
    _financeDetailRows.invoice = items || [];
    el.innerHTML = `<table class="data-table"><thead><tr><th>发票号</th><th>类型</th><th>对方</th><th>金额</th><th>到期日</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${!items?.length ? `<tr><td colspan="7"><p class="empty-hint" style="padding:20px">暂无发票</p></td></tr>` :
      items.map((inv, i) => `<tr>
        <td><b>${esc(inv.invoice_number||'—')}</b></td>
        <td>${inv.invoice_type==='receivable'?'应收':'应付'}</td>
        <td>${esc(inv.counterparty_name)}</td>
        <td>${money(inv.amount_cents)}${inv.paid_cents>0?`<br><small style="color:var(--muted)">已核 ${money(inv.paid_cents)}</small>`:''}</td>
        <td>${fmtDate(inv.due_date)}</td>
        <td><span class="status-pill ${inv.status==='overdue'?'warning':''}">${{draft:'草稿',sent:'已发出',partial:'部分收款',paid:'已付清',overdue:'已逾期',cancelled:'已取消'}[inv.status]||inv.status}</span></td>
        <td><button class="btn ghost small" data-fin-kind="invoice" data-fin-idx="${i}">详情</button>${canWo && inv.invoice_type==='receivable' && ['sent','partial','overdue','disputed'].includes(inv.status)
          ? ` <button data-writeoff="${esc(inv.id)}" style="font-size:9px;color:var(--blue);background:none;border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer">一键核销</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function renderPayments(el) {
  try {
    const { items } = await API.get('/v1/finance/payments?limit=50');
    _financeDetailRows.payment = items || [];
    el.innerHTML = `<table class="data-table"><thead><tr><th>客户</th><th>里程碑</th><th>金额</th><th>预计到账</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${!items?.length ? `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无收款计划</p></td></tr>` :
      items.map((p, i) => `<tr>
        <td><b>${esc(p.customer_name)}</b></td>
        <td>${esc(p.milestone)}</td>
        <td>${money(p.amount_cents)}</td>
        <td>${fmtDate(p.due_date)}</td>
        <td><span class="status-pill ${p.status==='overdue'?'warning':''}">${{planned:'待收款',invoiced:'已开票',paid:'已收款',overdue:'已逾期',cancelled:'已取消'}[p.status]||p.status}</span></td>
        <td><button class="btn ghost small" data-fin-kind="payment" data-fin-idx="${i}">详情</button></td>
      </tr>`).join('')}</tbody></table>`;
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function renderFinanceConfig(el) {
  try {
    const { settings } = await API.get('/v1/settings/finance').catch(() => ({ settings: {} }));
    el.innerHTML = `<div style="padding:20px">
      <h3 style="font-size:12px;margin-bottom:16px">财务系统配置</h3>
      <div class="panel" style="padding:16px;margin-bottom:16px">
        <h4 style="margin:0 0 12px;font-size:10px;color:var(--muted)">审批设置</h4>
        <div class="form-row" style="margin-bottom:10px">
          <span>报销单审批阈值（元）<small style="color:var(--muted)"> — 超过此金额需要额外审批</small></span>
          <input id="fin-approval-threshold" type="number" value="${Math.round((settings.approval_threshold_cents||500000)/100)}" min="0" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%">
        </div>
        <div class="form-row" style="margin-bottom:10px">
          <span>报销提交截止日（每月几号）</span>
          <input id="fin-expense-deadline" type="number" value="${settings.expense_deadline_day||25}" min="1" max="28" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%">
        </div>
        <div class="form-row" style="margin-bottom:10px">
          <span>发票到期提醒（提前天数）</span>
          <input id="fin-invoice-warn" type="number" value="${settings.invoice_expiry_warn_days||7}" min="1" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%">
        </div>
        <button class="btn primary small" id="save-fin-config">保存财务配置</button>
      </div>
      <div class="panel" style="padding:16px">
        <h4 style="margin:0 0 12px;font-size:10px;color:var(--muted)">费用类别</h4>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          ${Object.entries(EXP_CAT).map(([k,v]) => `<span class="tag-chip" style="padding:5px 10px">${v}</span>`).join('')}
        </div>
        <p style="font-size:9px;color:var(--muted)">费用类别在报销提交时从下拉列表选择，暂不支持自定义。</p>
      </div>
    </div>`;
    el.querySelector('#save-fin-config')?.addEventListener('click', async () => {
      const s = {
        approval_threshold_cents: Number(document.getElementById('fin-approval-threshold').value) * 100,
        expense_deadline_day: Number(document.getElementById('fin-expense-deadline').value),
        invoice_expiry_warn_days: Number(document.getElementById('fin-invoice-warn').value)
      };
      try { await API.patch('/v1/settings/finance', s); toast('财务配置已保存'); } catch(e) { toast(e.message,'error'); }
    });
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

// ──────────────────────────────────────────────────────────────
// ── IT 资产模块
// ──────────────────────────────────────────────────────────────
let _itTab = 'assets';

async function renderAssets(el) {
  try {
    const { items } = await API.get('/v1/it/assets?limit=50');
    el.innerHTML = `<table class="data-table"><thead><tr><th>资产名称</th><th>类别</th><th>持有人</th><th>状态</th><th>许可到期</th><th>健康度</th></tr></thead>
      <tbody>${!items?.length ? `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无资产记录</p></td></tr>` :
      items.map(a => `<tr data-id="${a.id}" class="clickable-row">
        <td><div class="entity"><span class="project-code blue">${esc((a.asset_code||'A').slice(0,2))}</span><div><b>${esc(a.name)}</b><small style="color:var(--muted);display:block">${esc(a.asset_code)}</small></div></div></td>
        <td>${esc({hardware:'硬件',software:'软件',saas:'SaaS',network:'网络',certificate:'证书',other:'其他'}[a.category]||a.category)}</td>
        <td>${esc(a.assigned_person_name||a.assigned_org_name||'未分配')}</td>
        <td><span class="status-pill ${a.status==='retired'?'warning':''}">${{in_use:'使用中',spare:'备用',maintenance:'维修中',retired:'已退役'}[a.status]||a.status}</span></td>
        <td>${fmtDate(a.license_expires_at)}</td>
        <td><span class="status-pill ${['warning','critical'].includes(a.health_status)?'warning':''}">${{healthy:'健康',attention:'关注',warning:'预警',critical:'严重'}[a.health_status]||'—'}</span></td>
      </tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openAssetDetail(tr.dataset.id)));
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function renderTickets(el) {
  try {
    const { items } = await API.get('/v1/it/tickets?limit=50');
    el.innerHTML = `<table class="data-table"><thead><tr><th>工单</th><th>类别</th><th>申请人</th><th>分配给</th><th>优先级</th><th>状态</th></tr></thead>
      <tbody>${!items?.length ? `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无工单</p></td></tr>` :
      items.map(t => `<tr data-id="${t.id}" class="clickable-row">
        <td><div class="entity"><b>${esc(t.title)}</b></div><small style="color:var(--muted)">${t.ticket_number}</small></td>
        <td>${esc(t.category)}</td>
        <td>${esc(t.requester_name||'—')}</td>
        <td>${esc(t.assignee_name||'未分配')}</td>
        <td><span class="status-pill ${t.priority==='critical'?'warning':''}">${{low:'低',medium:'中',high:'高',critical:'紧急'}[t.priority]||t.priority}</span></td>
        <td><span class="status-pill ${t.status==='open'?'warning':''}">${{open:'待处理',in_progress:'处理中',resolved:'已解决',closed:'已关闭'}[t.status]||t.status}</span></td>
      </tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openTicketDetail(tr.dataset.id)));
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function renderLicenses(el) {
  try {
    const { items } = await API.get('/v1/it/licenses?limit=50');
    el.innerHTML = `<table class="data-table"><thead><tr><th>软件</th><th>厂商</th><th>类型</th><th>席位</th><th>到期时间</th><th>状态</th></tr></thead>
      <tbody>${!items?.length ? `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无许可证记录</p></td></tr>` :
      items.map(l => `<tr data-id="${l.id}" class="clickable-row">
        <td><b>${esc(l.software_name)}</b></td>
        <td>${esc(l.vendor||'—')}</td>
        <td>${esc({subscription:'订阅',perpetual:'永久',per_seat:'按席',volume:'批量'}[l.license_type]||l.license_type)}</td>
        <td>
          <span style="font:600 11px var(--mono)">${l.used_seats||0}</span>
          <span style="color:var(--muted)"> / ${l.total_seats}</span>
          <span style="color:var(--jade)"> (空余 ${l.available_seats||0})</span>
        </td>
        <td>${fmtDate(l.expiry_date)}</td>
        <td><span class="status-pill ${l.status==='expired'?'warning':''}">${{active:'有效',expired:'已过期',cancelled:'已取消'}[l.status]||l.status}</span></td>
      </tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openLicenseDetail(tr.dataset.id)));
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function openAssetDetail(id) {
  Drawer.show('资产详情', '<p class="loading-text">加载中…</p>');
  try {
    const a = await API.get(`/v1/it/assets/${id}`);
    Drawer.setBody(`
      <div class="detail-header">
        <span class="project-code blue">${esc((a.asset_code||'A').slice(0,2))}</span>
        <div><h3>${esc(a.name)}</h3><p>${esc(a.vendor||'')} ${esc(a.model||'')} · ${esc(a.location||'—')}</p></div>
      </div>
      <div class="detail-stats">
        <div><small>类别</small><strong>${esc(a.category)}</strong></div>
        <div><small>序列号</small><strong style="font-size:8px">${esc(a.serial_number||'—')}</strong></div>
        <div><small>购买价</small><strong>${money(a.purchase_cost_cents)}</strong></div>
        <div><small>健康度</small><strong>${{healthy:'健康',attention:'关注',warning:'预警',critical:'严重'}[a.health_status]||'—'}</strong></div>
      </div>
      <div class="detail-section"><h4>分配情况</h4>
        <p style="font-size:9px">${esc(a.assigned_person_name||a.assigned_org_name||'未分配')}</p>
        ${PersonPicker.html('assign_person_id','重新分配给')}
        <button class="btn ghost small" id="reassign-btn" style="margin-top:6px">更新分配</button>
      </div>`);
    const body = Drawer._el.querySelector('.drawer-body');
    PersonPicker.init(body);
    body.querySelector('#reassign-btn')?.addEventListener('click', async () => {
      const pid = body.querySelector('[name=assign_person_id]')?.value;
      if (!pid) { toast('请选择成员', 'error'); return; }
      try { await API.patch(`/v1/it/assets/${id}`, { assigned_person_id: pid }); toast('分配已更新'); openAssetDetail(id); } catch(e) { toast(e.message,'error'); }
    });
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

async function openTicketDetail(id) {
  Drawer.show('工单详情', '<p class="loading-text">加载中…</p>');
  try {
    const t = await API.get(`/v1/it/tickets/${id}`);
    Drawer.setBody(`
      <div class="detail-header">
        <span class="project-code ${t.priority==='critical'?'red':t.priority==='high'?'amber':'blue'}">${t.priority==='critical'?'紧':t.priority==='high'?'高':'工'}</span>
        <div><h3>${esc(t.title)}</h3><p>${t.ticket_number} · ${esc(t.requester_name||'—')} 提交</p></div>
      </div>
      ${t.description ? `<p style="font-size:9px;line-height:1.6;color:var(--muted)">${esc(t.description)}</p>` : ''}
      <div class="detail-stats">
        <div><small>类别</small><strong>${esc(t.category)}</strong></div>
        <div><small>分配给</small><strong>${esc(t.assignee_name||'未分配')}</strong></div>
        <div><small>状态</small><strong>${{open:'待处理',in_progress:'处理中',resolved:'已解决',closed:'已关闭'}[t.status]||t.status}</strong></div>
        <div><small>资产</small><strong style="font-size:9px">${esc(t.asset_name||'—')}</strong></div>
      </div>
      <div style="display:flex;gap:6px;margin-top:16px">
        ${t.status==='open'?`<button class="btn ghost small" onclick="updateTicket('${id}','in_progress')">接单处理</button>`:''}
        ${['open','in_progress'].includes(t.status)?`<button class="btn primary small" onclick="openResolveModal('${id}')">标记解决</button>`:''}
      </div>`);
    window.updateTicket = async (tid, status) => {
      try { await API.patch(`/v1/it/tickets/${tid}`, { status }); toast('状态已更新'); openTicketDetail(tid); } catch(e) { toast(e.message,'error'); }
    };
    window.openResolveModal = (tid) => {
      Modal.show('解决工单', `
        <div class="form-row"><span>解决说明 <i class="req">*</i></span><textarea name="resolution_notes" rows="4" placeholder="详述解决方案或操作步骤" required></textarea></div>
      `, async (data) => {
        await API.patch(`/v1/it/tickets/${tid}`, { status: 'resolved', resolution_notes: data.resolution_notes });
        toast('工单已解决'); openTicketDetail(tid);
      });
    };
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

async function openLicenseDetail(id) {
  Drawer.show('软件许可证', '<p class="loading-text">加载中…</p>');
  try {
    const [lic, { items: assignments }] = await Promise.all([
      API.get(`/v1/it/licenses`).then(r => r.items?.find(l => l.id === id) || {}),
      API.get(`/v1/it/licenses/${id}/assignments`)
    ]);
    Drawer.setBody(`
      <div style="margin-bottom:20px">
        <h3>${esc(lic.software_name||'—')}</h3>
        <p style="color:var(--muted);font-size:9px">${esc(lic.vendor||'')} · ${esc({subscription:'订阅',perpetual:'永久',per_seat:'按席位',volume:'批量'}[lic.license_type]||lic.license_type||'—')}</p>
        <div class="seat-bar">
          ${Array.from({length: lic.total_seats||0}, (_,i) => `<div class="seat-dot${i >= (lic.used_seats||0) ? ' free' : ''}"></div>`).join('')}
        </div>
        <div style="font-size:9px;color:var(--muted);margin-top:6px">${lic.used_seats||0}/${lic.total_seats} 席位已使用 · 到期 ${fmtDate(lic.expiry_date)}</div>
      </div>
      <div class="detail-section">
        <div class="section-head"><h4>席位分配</h4></div>
        ${assignments.map(a => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <span class="person-chip">${avatar(a.person_name)}</span>
            <span style="flex:1">${esc(a.person_name)}</span>
            <small style="color:var(--muted)">${ago(a.assigned_at)}</small>
          </div>`).join('') || '<p class="empty-hint">暂无分配</p>'}
        ${PersonPicker.html('assign_person','分配给成员')}
        <button class="btn ghost small" id="assign-license-btn" style="margin-top:6px">分配席位</button>
      </div>`);
    const body = Drawer._el.querySelector('.drawer-body');
    PersonPicker.init(body);
    body.querySelector('#assign-license-btn')?.addEventListener('click', async () => {
      const pid = body.querySelector('[name=assign_person]')?.value;
      if (!pid) { toast('请选择成员', 'error'); return; }
      try { await API.post(`/v1/it/licenses/${id}/assignments`, { person_id: pid }); toast('席位已分配'); openLicenseDetail(id); } catch(e) { toast(e.message,'error'); }
    });
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

// ──────────────────────────────────────────────────────────────
// ── 知识库模块
// ──────────────────────────────────────────────────────────────
async function loadKnowledgeData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  const toolbar = container.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('.knowledge-search-input')) {
    toolbar.innerHTML = `
      <div class="filter-tabs">
        <button class="active" data-know-tab="all">全部条目</button>
        <button data-know-tab="search">搜索</button>
      </div>
      <div class="table-tools">
        <input class="knowledge-search-input" type="text" placeholder="全文搜索…" style="padding:5px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:9px;outline:0" id="knowledge-search">
        <button onclick="triggerKnowledgeSearch()">⌕</button>
      </div>`;
    document.getElementById('knowledge-search')?.addEventListener('keydown', e => { if (e.key === 'Enter') triggerKnowledgeSearch(); });
  }
  await loadKnowledgeItems(container.querySelector('.data-table-wrap'));
}

window.triggerKnowledgeSearch = async () => {
  const q = document.getElementById('knowledge-search')?.value?.trim();
  if (!q) return;
  const el = document.querySelector('.data-table-wrap');
  if (!el) return;
  el.innerHTML = '<p class="loading-text" style="padding:20px">搜索中…</p>';
  try {
    const { results } = await API.get(`/v1/knowledge/search?q=${encodeURIComponent(q)}`);
    if (!results?.length) { el.innerHTML = '<p class="empty-hint" style="padding:20px">没有找到相关内容</p>'; return; }
    el.innerHTML = `<table class="data-table"><thead><tr><th>标题</th><th>摘要</th><th>更新时间</th></tr></thead>
      <tbody>${results.map(ki => `<tr data-id="${ki.id}" class="clickable-row">
        <td><b>${esc(ki.title)}</b></td>
        <td style="white-space:normal;max-width:300px;font-size:8px;color:var(--muted)">${esc((ki.snippet||'').replace(/<[^>]+>/g,'').slice(0,120))}…</td>
        <td>${ago(ki.updated_at)}</td>
      </tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openKnowledgeDetail(tr.dataset.id)));
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">搜索失败：${e.message}</p>`; }
};

async function loadKnowledgeItems(el) {
  if (!el) return;
  try {
    const { items } = await API.get('/v1/knowledge/items?limit=50');
    el.innerHTML = `<table class="data-table"><thead><tr><th>标题</th><th>类型</th><th>负责人</th><th>标签</th><th>评分</th><th>状态</th></tr></thead>
      <tbody>${!items?.length ? `<tr><td colspan="6"><p class="empty-hint" style="padding:20px">暂无知识条目</p></td></tr>` :
      items.map(ki => `<tr data-id="${ki.id}" class="clickable-row">
        <td><b>${esc(ki.title)}</b></td>
        <td>${esc({markdown:'文档',link:'链接',feishu_doc:'飞书文档',video:'视频',pdf:'PDF'}[ki.content_type]||ki.content_type)}</td>
        <td>${esc(ki.owner_name||'—')}</td>
        <td>${(ki.tags||[]).slice(0,3).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') || '—'}</td>
        <td>${ki.rating_avg > 0 ? `★ ${Number(ki.rating_avg).toFixed(1)}` : '—'}</td>
        <td><span class="status-pill ${ki.index_status!=='indexed'?'warning':''}">${{indexed:'已索引',pending:'待索引',failed:'失败',excluded:'已排除'}[ki.index_status]||ki.index_status}</span></td>
      </tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('.clickable-row').forEach(tr => tr.addEventListener('click', () => openKnowledgeDetail(tr.dataset.id)));
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function openKnowledgeDetail(id) {
  Drawer.show('知识详情', '<p class="loading-text">加载中…</p>');
  try {
    const [ki, { items: versions }] = await Promise.all([
      API.get(`/v1/knowledge/items/${id}`),
      API.get(`/v1/knowledge/items/${id}/versions`)
    ]);
    Drawer.setBody(`
      <div style="margin-bottom:16px">
        <h3 style="margin:0 0 8px">${esc(ki.title)}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          ${(ki.tags||[]).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('')}
        </div>
        <div style="font-size:9px;color:var(--muted)">分类：${esc(ki.category_name||'—')} · 负责人：${esc(ki.owner_name||'—')} · 更新：${ago(ki.updated_at)}</div>
      </div>
      ${ki.content ? `<div style="font-size:10px;line-height:1.7;margin-bottom:16px;padding:12px;background:var(--paper-deep);border-radius:8px;max-height:200px;overflow:auto">${esc(ki.content).slice(0,1000)}${ki.content.length>1000?'…':''}</div>` : ''}
      ${ki.source_url ? `<p style="font-size:9px"><a href="${safeUrl(ki.source_url)}" target="_blank" style="color:var(--blue)">→ 查看原文</a></p>` : ''}
      <button class="btn danger-ghost small" type="button" id="delete-knowledge-btn" style="margin-bottom:12px">删除条目</button>
      <div style="margin-bottom:16px">
        <div style="font-size:9px;margin-bottom:6px">评分：${ki.rating_avg > 0 ? `★ ${Number(ki.rating_avg).toFixed(1)} (${ki.rating_count}人)` : '暂无评分'}</div>
        <div style="display:flex;gap:4px">
          ${[1,2,3,4,5].map(n => `<button class="btn ghost small" onclick="rateKnowledge('${id}',${n})">${n}★</button>`).join('')}
        </div>
      </div>
      <div class="detail-section">
        <h4>版本历史 <span class="badge">${versions.length}</span></h4>
        ${versions.slice(0,5).map(v => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <span>v${v.version_number} · ${esc(v.author_name||'—')}</span>
            <span style="color:var(--muted)">${ago(v.created_at)}</span>
          </div>`).join('') || '<p class="empty-hint">暂无历史版本</p>'}
      </div>`);
    document.getElementById('delete-knowledge-btn')?.addEventListener('click', async () => {
      if (!confirm(`确定删除知识条目「${ki.title}」？删除后不可在列表中恢复。`)) return;
      try {
        await API.del(`/v1/knowledge/items/${id}`);
        toast('知识条目已删除');
        Drawer.hide();
        loadKnowledgeData();
      } catch (e) { toast(e.message || '删除失败（仅负责人或管理员可删除）', 'error'); }
    });
    window.rateKnowledge = async (kid, rating) => {
      try { await API.post(`/v1/knowledge/items/${kid}/ratings`, { rating }); toast(`已评 ${rating} 星`); openKnowledgeDetail(kid); } catch(e) { toast(e.message,'error'); }
    };
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

// ──────────────────────────────────────────────────────────────
// ── HR 花名册 & 人员管理（全面增强）
// ──────────────────────────────────────────────────────────────

const EMP_STATUS = { preboarding:'入职中', active:'在职', leave:'休假中', terminated:'已离职' };
const EMP_TYPE = { employee:'全职', part_time:'兼职', contractor:'外包', intern:'实习', advisor:'顾问' };
const LEAVE_TYPE_NAMES = { annual:'年假', sick:'病假', personal:'事假', marriage:'婚假', maternity:'产假', paternity:'陪产假', bereavement:'丧假', compensatory:'调休' };

// 覆盖原来的 loadHRData，增加花名册和配置 Tab
async function loadHRData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  const toolbar = container.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('[data-hr-tab]')) {
    toolbar.innerHTML = `
      <div class="filter-tabs">
        <button class="${_hrTab==='recruitment'?'active':''}" data-hr-tab="recruitment">招聘看板</button>
        <button class="${_hrTab==='roster'?'active':''}" data-hr-tab="roster">员工花名册</button>
        <button class="${_hrTab==='leave'?'active':''}" data-hr-tab="leave">请假管理</button>
        <button class="${_hrTab==='orgchart'?'active':''}" data-hr-tab="orgchart">组织架构</button>
        <button class="${_hrTab==='config'?'active':''}" data-hr-tab="config">HR 配置</button>
      </div>
      <div class="table-tools"><button>⌕ 搜索</button><button>⇅ 筛选</button></div>`;
    toolbar.querySelectorAll('[data-hr-tab]').forEach(btn => {
      btn.addEventListener('click', () => { _hrTab = btn.dataset.hrTab; loadHRData(); });
    });
  } else {
    toolbar?.querySelectorAll('[data-hr-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.hrTab === _hrTab));
  }
  const wrap = container.querySelector('.data-table-wrap');
  if (!wrap) return;
  // 顶部指标独立于当前 Tab，避免切到招聘/名册时出现一排“—”。
  API.get('/v1/hr/employees?limit=100').then(({ items }) => {
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    const list = items || [];
    if (stats[0]) stats[0].textContent = String(list.length);
    if (stats[3]) {
      const soon = list.filter(e => e.probation_end && new Date(e.probation_end) <= new Date(Date.now() + 60 * 86400000)).length;
      stats[3].textContent = String(soon);
    }
  }).catch(() => {});
  Promise.allSettled([API.get('/v1/hr/requisitions?limit=100'), API.get('/v1/hr/candidates?limit=100')]).then(([req, cand]) => {
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    if (stats[1] && req.status === 'fulfilled') {
      stats[1].textContent = String((req.value.items || []).filter(r => ['open', 'approved', 'sourcing', 'interviewing'].includes(r.status)).length);
    }
    if (stats[2] && cand.status === 'fulfilled') {
      stats[2].textContent = String((cand.value.items || []).filter(c => !['rejected', 'withdrawn', 'hired'].includes(c.status)).length);
    }
  }).catch(() => {});
  if (_hrTab === 'recruitment') await loadRecruitment(container);
  else if (_hrTab === 'roster') await loadEmployeeRoster(wrap);
  else if (_hrTab === 'leave') await loadLeaveRequests(container);
  else if (_hrTab === 'orgchart') await renderOrgChart(wrap);
  else await renderHRConfig(wrap);
}

async function loadEmployeeRoster(el) {
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const { items } = await API.get('/v1/hr/employees?limit=100');
    if (!items?.length) {
      el.innerHTML = `<div style="padding:20px"><p class="empty-hint">暂无员工记录，点击「新增员工」添加</p></div>`;
      return;
    }
    el.innerHTML = `<table class="data-table"><thead><tr>
      <th>姓名</th><th>工号</th><th>部门</th><th>职位</th><th>直属上级</th><th>雇佣类型</th><th>入职日期</th><th>状态</th>
    </tr></thead><tbody>
    ${items.map(e => `<tr data-emp-id="${e.id}" class="clickable-row">
      <td><div class="entity"><span class="person-chip">${avatar(e.display_name)}</span><div><b>${esc(e.display_name)}</b><small style="color:var(--muted);display:block">${esc(e.primary_email||'')}</small></div></div></td>
      <td style="font:500 9px var(--mono)">${esc(e.employee_number||'—')}</td>
      <td>${esc(e.org_unit_name||'—')}</td>
      <td>${esc(e.position_name||'—')}</td>
      <td>${e.manager_name ? `<span class="person-chip sm">${avatar(e.manager_name)}</span>${esc(e.manager_name)}` : '—'}</td>
      <td>${EMP_TYPE[e.employment_type]||e.employment_type||'—'}</td>
      <td>${fmtDate(e.start_date)}</td>
      <td><span class="status-pill ${e.status==='terminated'?'warning':''}">${EMP_STATUS[e.status]||e.status}</span></td>
    </tr>`).join('')}
    </tbody></table>`;
    el.querySelectorAll('[data-emp-id]').forEach(tr => tr.addEventListener('click', () => openEmployeeDetail(tr.dataset.empId)));
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${e.message}</p>`; }
}

async function openEmployeeDetail(empId) {
  Drawer.show('员工档案', '<p class="loading-text">加载中…</p>');
  try {
    const emp = await API.get(`/v1/hr/employees/${empId}`);
    const [orgUnits] = await Promise.all([API.get('/v1/org-units').catch(() => ({ items: [] }))]);

    Drawer.setBody(`
      <div class="detail-header">
        <span class="person-chip" style="width:44px;height:44px;font-size:16px;flex-shrink:0">${avatar(emp.display_name)}</span>
        <div>
          <h3 style="margin:0 0 4px">${esc(emp.display_name)}</h3>
          <p style="margin:0;font-size:9px;color:var(--muted)">${esc(emp.position_name||'—')} · ${esc(emp.org_unit_name||'—')}</p>
          <span class="status-pill" style="margin-top:4px;display:inline-block">${EMP_STATUS[emp.status]||emp.status}</span>
        </div>
      </div>
      <div class="detail-stats">
        <div><small>工号</small><strong style="font-size:10px;font-family:var(--mono)">${esc(emp.employee_number||'—')}</strong></div>
        <div><small>雇佣类型</small><strong>${EMP_TYPE[emp.employment_type]||'—'}</strong></div>
        <div><small>入职日期</small><strong>${fmtDate(emp.start_date)}</strong></div>
        <div><small>试用期至</small><strong>${fmtDate(emp.probation_end_date)}</strong></div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
        <button class="btn ghost small" data-act="edit-employee" data-id="${esc(emp.id)}" data-name="${esc(emp.display_name)}">编辑信息</button>
        <button class="btn ghost small" onclick="openAddContractModal('${emp.id}')">新建合同</button>
        <button class="btn ghost small" data-act="transfer-employee" data-id="${esc(emp.id)}" data-name="${esc(emp.display_name)}">调动/晋升</button>
        ${emp.status !== 'terminated' ? `<button class="btn danger-ghost small" data-act="offboard-employee" data-id="${esc(emp.id)}" data-name="${esc(emp.display_name)}">办理离职</button>` : ''}
      </div>

      <div class="detail-section">
        <h4>基本信息</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:9px">
          <div><small style="color:var(--muted);display:block">邮箱</small><span>${esc(emp.primary_email||'—')}</span></div>
          <div><small style="color:var(--muted);display:block">手机</small><span>${esc(emp.mobile||'—')}</span></div>
          <div><small style="color:var(--muted);display:block">直属上级</small><span>${emp.manager_name ? `<span class="person-chip sm">${avatar(emp.manager_name)}</span> ${esc(emp.manager_name)}` : '—'}</span></div>
          <div><small style="color:var(--muted);display:block">办公地点</small><span>${esc(emp.work_location||'—')}</span></div>
          <div><small style="color:var(--muted);display:block">紧急联系人</small><span>${esc(emp.emergency_contact_name||'—')}</span></div>
          <div><small style="color:var(--muted);display:block">紧急联系电话</small><span>${esc(emp.emergency_contact_phone||'—')}</span></div>
        </div>
        ${emp.notes ? `<p style="margin-top:8px;font-size:9px;color:var(--muted);line-height:1.6">${esc(emp.notes)}</p>` : ''}
      </div>

      <div class="detail-section">
        <div class="section-head"><h4>合同记录 <span class="badge">${(emp.contracts||[]).length}</span></h4>
        <button class="btn ghost small" onclick="openAddContractModal('${emp.id}')">＋ 新建</button></div>
        ${(emp.contracts||[]).length ? emp.contracts.map(c => `
          <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <div><b>${esc({full_time:'正式合同',part_time:'兼职合同',contractor:'外包协议',intern:'实习协议',probation:'试用期合同'}[c.contract_type]||c.contract_type)}</b>
            <small style="color:var(--muted);display:block">${fmtDate(c.start_date)} → ${c.end_date ? fmtDate(c.end_date) : '无固定期限'}</small></div>
            <span>${money(c.base_salary_cents)}/月</span>
            <span class="status-pill" style="font-size:7px">${{active:'有效',expired:'已到期',terminated:'已解除'}[c.status]||c.status}</span>
          </div>`).join('') : '<p class="empty-hint">暂无合同</p>'}
      </div>

      <div class="detail-section">
        <div class="section-head"><h4>请假记录 <span class="badge">${(emp.leave_history||[]).length}</span></h4></div>
        ${(emp.leave_history||[]).length ? emp.leave_history.slice(0,6).map(lr => `
          <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:9px">
            <span class="leave-type-tag">${LEAVE_TYPE_NAMES[lr.leave_type]||lr.leave_type}</span>
            <span>${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)}</span>
            <span>${lr.days}天</span>
            <span class="status-pill ${lr.status==='rejected'?'warning':''}">${{pending:'待审批',approved:'已批准',rejected:'已拒绝'}[lr.status]||lr.status}</span>
          </div>`).join('') : '<p class="empty-hint">暂无请假记录</p>'}
      </div>`);

    // 绑定内联操作函数
    window.openEditEmployeeModal = (id, name) => {
      Modal.show(`编辑员工信息 · ${name}`, `
        <div class="form-cols">
          <div class="form-row"><span>雇佣类型</span><select name="employment_type">
            ${Object.entries(EMP_TYPE).map(([k,v]) => `<option value="${k}"${emp.employment_type===k?' selected':''}>${v}</option>`).join('')}
          </select></div>
          <div class="form-row"><span>状态</span><select name="status">
            ${Object.entries(EMP_STATUS).map(([k,v]) => `<option value="${k}"${emp.status===k?' selected':''}>${v}</option>`).join('')}
          </select></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>办公地点</span><input name="work_location" value="${esc(emp.work_location||'')}"></div>
          <div class="form-row"><span>试用期截止</span><input type="date" name="probation_end_date" value="${emp.probation_end_date?.slice(0,10)||''}"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>紧急联系人</span><input name="emergency_contact_name" value="${esc(emp.emergency_contact_name||'')}"></div>
          <div class="form-row"><span>紧急电话</span><input name="emergency_contact_phone" value="${esc(emp.emergency_contact_phone||'')}"></div>
        </div>
        <div class="form-row"><span>备注</span><textarea name="notes" rows="3">${esc(emp.notes||'')}</textarea></div>
        ${PersonPicker.html('manager_person_id','直属上级')}
      `, async (data) => {
        await API.patch(`/v1/hr/employees/${id}`, data);
        toast('信息已更新'); openEmployeeDetail(id);
      });
    };
    window.openTransferModal = (id, name) => {
      Modal.show(`调动 / 晋升 · ${name}`, `
        <div class="form-row"><span>新部门</span><select name="org_unit_id">
          <option value="">不变</option>
          ${(orgUnits.items||[]).map(ou => `<option value="${ou.id}">${esc(ou.name)}</option>`).join('')}
        </select></div>
        ${PersonPicker.html('manager_person_id','新直属上级')}
        <div class="form-row"><span>生效日期</span><input type="date" name="effective_date" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="form-row"><span>调动原因</span><textarea name="notes" rows="2" placeholder="晋升/部门调整/业务需要…"></textarea></div>
      `, async (data) => {
        const upd = {};
        if (data.org_unit_id) upd.org_unit_id = data.org_unit_id;
        if (data.manager_person_id) upd.manager_person_id = data.manager_person_id;
        if (data.notes) upd.notes = data.notes;
        await API.patch(`/v1/hr/employees/${id}`, upd);
        toast('调动信息已更新'); openEmployeeDetail(id);
      });
    };
    window.openOffboardModal = (id, name) => {
      Modal.show(`办理离职 · ${name}`, `
        <div class="form-row"><span>最后工作日 <i class="req">*</i></span><input type="date" name="termination_date" required></div>
        <div class="form-row"><span>离职原因 <i class="req">*</i></span><select name="termination_reason">
          <option value="resignation">主动离职</option>
          <option value="mutual_agreement">协商解除</option>
          <option value="contract_expiry">合同到期</option>
          <option value="performance">绩效不达标</option>
          <option value="layoff">裁员</option>
          <option value="other">其他</option>
        </select></div>
        <div class="form-row"><span>备注</span><textarea name="notes" rows="2"></textarea></div>
        <p style="font-size:8px;padding:8px;background:#fef2f1;border-radius:6px;color:var(--red)">
          ⚠ 离职后该员工将无法登录系统，请确认已完成工作交接。
        </p>
      `, async (data) => {
        await API.patch(`/v1/hr/employees/${id}`, { status: 'terminated', termination_date: data.termination_date, termination_reason: data.termination_reason, notes: data.notes });
        toast('离职手续已记录'); openEmployeeDetail(id);
      });
    };
    window.openAddContractModal = (id) => {
      Modal.show('新建合同', `
        <div class="form-row"><span>合同类型 <i class="req">*</i></span><select name="contract_type">
          <option value="full_time">正式合同</option><option value="part_time">兼职合同</option>
          <option value="contractor">外包协议</option><option value="intern">实习协议</option>
        </select></div>
        <div class="form-cols">
          <div class="form-row"><span>开始日期 <i class="req">*</i></span><input type="date" name="start_date" required></div>
          <div class="form-row"><span>结束日期（无固定留空）</span><input type="date" name="end_date"></div>
        </div>
        <div class="form-row"><span>月薪（元）</span><input type="number" name="salary_yuan" min="0" placeholder="0"></div>
      `, async (data) => {
        await API.post(`/v1/hr/employees/${id}/contracts`, { contract_type: data.contract_type, start_date: data.start_date, end_date: data.end_date || null, base_salary_cents: data.salary_yuan ? data.salary_yuan*100 : null });
        toast('合同已创建'); openEmployeeDetail(id);
      });
    };
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

async function renderOrgChart(el) {
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const { items } = await API.get('/v1/hr/org-chart');
    if (!items?.length) { el.innerHTML = '<div style="padding:20px"><p class="empty-hint">暂无部门结构，请先在「HR 配置」中建立组织架构</p></div>'; return; }

    // 构建树结构
    const byId = Object.fromEntries(items.map(ou => [ou.id, { ...ou, children: [] }]));
    const roots = [];
    items.forEach(ou => { if (ou.parent_id && byId[ou.parent_id]) byId[ou.parent_id].children.push(byId[ou.id]); else roots.push(byId[ou.id]); });

    function renderNode(node, depth = 0) {
      return `<div class="org-node" style="margin-left:${depth*20}px">
        <div class="org-node-row">
          <span class="org-node-icon">${{department:'◫',team:'⊞',division:'◈',company:'⌂'}[node.type]||'◎'}</span>
          <span class="org-node-name">${esc(node.name)}</span>
          <span class="badge">${node.headcount||0}人</span>
          <button class="btn ghost small" data-act="add-org-unit" data-id="${esc(node.id)}" data-name="${esc(node.name)}">＋ 下级</button>
        </div>
        ${node.children.map(c => renderNode(c, 0)).join('')}
      </div>`;
    }

    el.innerHTML = `<div style="padding:20px">
      <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
        <button class="btn ghost small" onclick="openAddOrgUnitModal(null,'根部门')">＋ 新建顶级部门</button>
      </div>
      ${roots.map(r => renderNode(r)).join('')}
    </div>`;

    window.openAddOrgUnitModal = (parentId, parentName) => {
      Modal.show(`${parentId ? '添加下级部门 · '+parentName : '新建顶级部门'}`, `
        <div class="form-row"><span>部门名称 <i class="req">*</i></span><input name="name" required></div>
        <div class="form-row"><span>类型</span><select name="type">
          <option value="department">部门</option>
          <option value="team">小组</option>
          <option value="division">事业部</option>
          <option value="company">子公司</option>
        </select></div>
      `, async (data) => {
        await API.post('/v1/org-units', { ...data, parent_id: parentId });
        toast('部门已创建'); renderOrgChart(el);
      });
    };
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${e.message}</p>`; }
}

async function renderHRConfig(el) {
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const [{ items: policies }, { items: positions }] = await Promise.all([
      API.get('/v1/hr/leave-policies'),
      API.get('/v1/hr/job-positions')
    ]);

    el.innerHTML = `<div style="padding:20px">

      <!-- 假期政策 -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:12px">假期政策配置</h3>
      </div>
      <div class="panel" style="padding:0;margin-bottom:24px">
        <table class="data-table">
          <thead><tr><th>假期类型</th><th>年度额度（天）</th><th>可结转（天）</th><th>最短提前申请</th><th>需要审批</th><th>操作</th></tr></thead>
          <tbody>
          ${(policies.length ? policies : Object.keys(LEAVE_TYPE_NAMES).map(t => ({ leave_type: t }))).map(p => `
            <tr>
              <td><b>${LEAVE_TYPE_NAMES[p.leave_type]||p.leave_type}</b></td>
              <td>${p.annual_entitlement_days ?? 0}天</td>
              <td>${p.carry_over_max_days ?? 0}天</td>
              <td>${p.min_notice_days ?? 0}天</td>
              <td>${p.requires_approval !== false ? '是' : '否'}</td>
              <td><button class="btn ghost small" onclick="openEditLeavePolicyModal('${p.leave_type}')">编辑</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <!-- 职位体系 -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:12px">职位体系</h3>
        <button class="btn ghost small" onclick="openCreateJobPositionModal()">＋ 新建职位</button>
      </div>
      <div class="panel" style="padding:0">
        <table class="data-table">
          <thead><tr><th>职位名称</th><th>级别</th><th>部门</th><th>薪资区间</th><th>编制</th><th>状态</th></tr></thead>
          <tbody>
          ${positions.length ? positions.map(p => `
            <tr>
              <td><b>${esc(p.title)}</b>${p.code?`<small style="color:var(--muted);display:block">${esc(p.code)}</small>`:''}</td>
              <td><span class="tag-chip">${esc(p.level||'—')}</span></td>
              <td>${esc(p.department||'—')}</td>
              <td style="font-size:9px">${p.salary_min_cents ? `${money(p.salary_min_cents)}~${money(p.salary_max_cents)}/月` : '—'}</td>
              <td>${p.headcount_budget||1}人</td>
              <td><span class="status-pill ${!p.is_active?'warning':''}">${p.is_active?'启用':'停用'}</span></td>
            </tr>`).join('') : '<tr><td colspan="6"><p class="empty-hint" style="padding:16px">暂无职位，点击右上角新建</p></td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

    window.openEditLeavePolicyModal = (type) => {
      const current = policies.find(p => p.leave_type === type) || {};
      Modal.show(`编辑假期政策 · ${LEAVE_TYPE_NAMES[type]||type}`, `
        <div class="form-cols">
          <div class="form-row"><span>年度额度（天）</span><input type="number" name="annual_entitlement_days" value="${current.annual_entitlement_days??0}" min="0" step="0.5"></div>
          <div class="form-row"><span>最大结转（天）</span><input type="number" name="carry_over_max_days" value="${current.carry_over_max_days??0}" min="0" step="0.5"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>最少提前申请（天）</span><input type="number" name="min_notice_days" value="${current.min_notice_days??0}" min="0"></div>
          <div class="form-row"><span>最多连续请假（天）</span><input type="number" name="max_consecutive_days" value="${current.max_consecutive_days||''}" min="0"></div>
        </div>
        <div class="form-cols">
          <div class="form-row checkbox"><input type="checkbox" name="allow_half_day" ${current.allow_half_day!==false?'checked':''}><span>允许半天请假</span></div>
          <div class="form-row checkbox"><input type="checkbox" name="requires_approval" ${current.requires_approval!==false?'checked':''}><span>需要审批</span></div>
        </div>
        <div class="form-row"><span>说明</span><input name="description" value="${esc(current.description||'')}"></div>
      `, async (data) => {
        await API.patch(`/v1/hr/leave-policies/${type}`, data);
        toast('假期政策已更新'); renderHRConfig(el);
      });
    };
    window.openCreateJobPositionModal = () => {
      Modal.show('新建职位', `
        <div class="form-cols">
          <div class="form-row"><span>职位名称 <i class="req">*</i></span><input name="title" required></div>
          <div class="form-row"><span>职位编码</span><input name="code" placeholder="如 SE-P5"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>职级</span><select name="level">
            <option value="">不设置</option>
            ${['P1','P2','P3','P4','P5','P6','P7','P8','M1','M2','M3','M4','M5','Director','VP','C-Level'].map(l => `<option value="${l}">${l}</option>`).join('')}
          </select></div>
          <div class="form-row"><span>所属部门</span><input name="department"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>最低月薪（元）</span><input type="number" name="min_yuan" min="0"></div>
          <div class="form-row"><span>最高月薪（元）</span><input type="number" name="max_yuan" min="0"></div>
        </div>
        <div class="form-row"><span>编制人数</span><input type="number" name="headcount_budget" value="1" min="1"></div>
        <div class="form-row"><span>职责描述</span><textarea name="description" rows="3"></textarea></div>
      `, async (data) => {
        await API.post('/v1/hr/job-positions', { title: data.title, code: data.code, level: data.level||null, department: data.department, salary_min_cents: data.min_yuan ? data.min_yuan*100 : null, salary_max_cents: data.max_yuan ? data.max_yuan*100 : null, headcount_budget: data.headcount_budget, description: data.description });
        toast('职位已创建'); renderHRConfig(el);
      });
    };
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${e.message}</p>`; }
}

// ──────────────────────────────────────────────────────────────
// ── IT 供应商管理（全面增强）
// ──────────────────────────────────────────────────────────────

const VENDOR_CAT = { hardware:'硬件', software:'软件', saas:'SaaS', network:'网络', services:'服务', general:'通用' };

// 覆盖 IT loadITData，增加供应商 Tab
async function loadITData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  const toolbar = container.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('[data-it-tab]')) {
    toolbar.innerHTML = `
      <div class="filter-tabs">
        <button class="${_itTab==='assets'?'active':''}" data-it-tab="assets">资产台账</button>
        <button class="${_itTab==='tickets'?'active':''}" data-it-tab="tickets">服务工单</button>
        <button class="${_itTab==='licenses'?'active':''}" data-it-tab="licenses">软件许可</button>
        <button class="${_itTab==='vendors'?'active':''}" data-it-tab="vendors">供应商</button>
        <button class="${_itTab==='itconfig'?'active':''}" data-it-tab="itconfig">IT 配置</button>
      </div>
      <div class="table-tools"><button>⇅ 筛选</button></div>`;
    toolbar.querySelectorAll('[data-it-tab]').forEach(btn => {
      btn.addEventListener('click', () => { _itTab = btn.dataset.itTab; loadITData(); });
    });
  } else {
    toolbar?.querySelectorAll('[data-it-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.itTab === _itTab));
  }
  const wrap = container.querySelector('.data-table-wrap');
  if (!wrap) return;

  if (_itTab === 'assets') await renderAssets(wrap);
  else if (_itTab === 'tickets') await renderTickets(wrap);
  else if (_itTab === 'licenses') await renderLicenses(wrap);
  else if (_itTab === 'vendors') await renderVendors(wrap);
  else await renderITConfig(wrap);
}

async function renderVendors(el) {
  try {
    const { items } = await API.get('/v1/it/vendors');
    el.innerHTML = `<table class="data-table"><thead><tr>
      <th>供应商</th><th>类别</th><th>联系人</th><th>合同金额</th><th>合同到期</th><th>SLA响应</th><th>状态</th>
    </tr></thead><tbody>
    ${!items?.length ? `<tr><td colspan="7"><p class="empty-hint" style="padding:20px">暂无供应商记录</p></td></tr>` :
    items.map(v => `<tr data-vendor-id="${v.id}" class="clickable-row">
      <td><div class="entity"><span class="project-code blue">${esc(v.name).slice(0,2)}</span>
        <div><b>${esc(v.name)}</b><small style="color:var(--muted)">${esc(v.website||'')}</small></div></div></td>
      <td>${VENDOR_CAT[v.category]||v.category}</td>
      <td>${v.contact_name ? `<b>${esc(v.contact_name)}</b><small style="color:var(--muted);display:block">${esc(v.contact_email||'')}</small>` : '—'}</td>
      <td>${money(v.contract_value_cents)}</td>
      <td>${fmtDate(v.contract_end_date)}</td>
      <td>${v.sla_response_hours ? v.sla_response_hours+'h' : '—'}</td>
      <td><span class="status-pill ${v.status==='blacklisted'?'warning':v.status==='inactive'?'warning':''}">${{active:'合作中',inactive:'暂停',blacklisted:'黑名单'}[v.status]||v.status}</span></td>
    </tr>`).join('')}
    </tbody></table>`;
    el.querySelectorAll('[data-vendor-id]').forEach(tr => tr.addEventListener('click', () => openVendorDetail(tr.dataset.vendorId)));
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

async function openVendorDetail(vendorId) {
  Drawer.show('供应商详情', '<p class="loading-text">加载中…</p>');
  try {
    const { items: vendors } = await API.get('/v1/it/vendors');
    const v = vendors.find(x => x.id === vendorId);
    if (!v) { Drawer.setBody('<p class="error-hint">未找到供应商</p>'); return; }
    Drawer.setBody(`
      <div class="detail-header">
        <span class="project-code blue">${esc(v.name).slice(0,2)}</span>
        <div><h3>${esc(v.name)}</h3><p>${VENDOR_CAT[v.category]||v.category}</p></div>
      </div>
      <div class="detail-stats">
        <div><small>合同金额</small><strong>${money(v.contract_value_cents)}</strong></div>
        <div><small>合同期</small><strong style="font-size:9px">${fmtDate(v.contract_start_date)} → ${fmtDate(v.contract_end_date)}</strong></div>
        <div><small>SLA 响应</small><strong>${v.sla_response_hours ? v.sla_response_hours+'小时' : '未设置'}</strong></div>
        <div><small>状态</small><strong>${{active:'合作中',inactive:'暂停',blacklisted:'黑名单'}[v.status]||v.status}</strong></div>
      </div>
      <div class="detail-section">
        <h4>联系信息</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:9px">
          <div><small style="color:var(--muted)">联系人</small><b>${esc(v.contact_name||'—')}</b></div>
          <div><small style="color:var(--muted)">联系邮件</small><a href="mailto:${esc(v.contact_email||'')}" style="color:var(--blue)">${esc(v.contact_email||'—')}</a></div>
          <div><small style="color:var(--muted)">联系电话</small><span>${esc(v.contact_phone||'—')}</span></div>
          <div><small style="color:var(--muted)">网站</small>${v.website?`<a href="${safeUrl(v.website)}" target="_blank" style="color:var(--blue)">${esc(v.website)}</a>`:'—'}</div>
        </div>
      </div>
      <div class="detail-section">
        <h4>关联资产 <span class="badge">${v.asset_count||0}</span></h4>
        <p style="font-size:9px;color:var(--muted)">该供应商提供的资产数量：${v.asset_count||0}项</p>
      </div>
      ${v.notes ? `<div class="detail-section"><h4>备注</h4><p style="font-size:9px;line-height:1.6">${esc(v.notes)}</p></div>` : ''}
      <div style="display:flex;gap:6px;margin-top:16px">
        <button class="btn ghost small" onclick="openEditVendorModal('${v.id}')">编辑供应商</button>
        <button class="btn ${v.status==='active'?'danger-ghost':'ghost'} small" onclick="toggleVendorStatus('${v.id}','${v.status==='active'?'inactive':'active'}')">
          ${v.status==='active'?'暂停合作':'恢复合作'}
        </button>
      </div>`);
    window.openEditVendorModal = (id) => {
      Modal.show('编辑供应商', `
        <div class="form-row"><span>供应商名称 <i class="req">*</i></span><input name="name" value="${esc(v.name)}" required></div>
        <div class="form-cols">
          <div class="form-row"><span>类别</span><select name="category">
            ${Object.entries(VENDOR_CAT).map(([k,val]) => `<option value="${k}"${v.category===k?' selected':''}>${val}</option>`).join('')}
          </select></div>
          <div class="form-row"><span>SLA响应（小时）</span><input type="number" name="sla_response_hours" value="${v.sla_response_hours||''}" min="1"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>联系人</span><input name="contact_name" value="${esc(v.contact_name||'')}"></div>
          <div class="form-row"><span>联系邮件</span><input type="email" name="contact_email" value="${esc(v.contact_email||'')}"></div>
        </div>
        <div class="form-row"><span>联系电话</span><input name="contact_phone" value="${esc(v.contact_phone||'')}"></div>
        <div class="form-row"><span>网站</span><input name="website" value="${esc(v.website||'')}"></div>
        <div class="form-cols">
          <div class="form-row"><span>合同金额（元）</span><input type="number" name="contract_yuan" value="${Math.round((v.contract_value_cents||0)/100)}" min="0"></div>
          <div class="form-row"><span>付款条款</span><input name="payment_terms" value="${esc(v.payment_terms||'')}"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>合同开始</span><input type="date" name="contract_start_date" value="${v.contract_start_date?.slice(0,10)||''}"></div>
          <div class="form-row"><span>合同结束</span><input type="date" name="contract_end_date" value="${v.contract_end_date?.slice(0,10)||''}"></div>
        </div>
        <div class="form-row"><span>备注</span><textarea name="notes" rows="2">${esc(v.notes||'')}</textarea></div>
      `, async (data) => {
        await API.patch(`/v1/it/vendors/${id}`, { ...data, contract_value_cents: data.contract_yuan ? data.contract_yuan*100 : null });
        toast('供应商已更新'); openVendorDetail(id);
      });
    };
    window.toggleVendorStatus = async (id, newStatus) => {
      try { await API.patch(`/v1/it/vendors/${id}`, { status: newStatus }); toast('状态已更新'); openVendorDetail(id); } catch(e) { toast(e.message,'error'); }
    };
  } catch(e) { Drawer.setBody(`<p class="error-hint">加载失败：${e.message}</p>`); }
}

async function renderITConfig(el) {
  try {
    const [{ settings: itSettings }] = await Promise.all([
      API.get('/v1/settings/it').catch(() => ({ settings: {} }))
    ]);
    el.innerHTML = `<div style="padding:20px">
      <h3 style="font-size:12px;margin-bottom:16px">IT 系统配置</h3>
      <div class="panel" style="padding:16px;margin-bottom:16px">
        <h4 style="margin:0 0 12px;font-size:10px;color:var(--muted)">服务台设置</h4>
        <div class="form-row" style="margin-bottom:10px"><span>服务台邮箱</span><input id="it-helpdesk-email" value="${esc(itSettings.helpdesk_email||'')}" placeholder="it@company.com" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%"></div>
        <div class="form-row" style="margin-bottom:10px"><span>高优工单 SLA（小时）</span><input id="it-sla-high" type="number" value="${itSettings.sla_high_hours||4}" min="1" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%"></div>
        <div class="form-row" style="margin-bottom:10px"><span>中优工单 SLA（小时）</span><input id="it-sla-medium" type="number" value="${itSettings.sla_medium_hours||24}" min="1" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%"></div>
        <div class="form-row" style="margin-bottom:10px"><span>许可证到期提醒（天前）</span><input id="it-license-warn" type="number" value="${itSettings.license_expiry_warn_days||30}" min="7" style="padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;width:100%"></div>
        <button class="btn primary small" id="save-it-config">保存 IT 配置</button>
      </div>
      <div class="panel" style="padding:16px">
        <h4 style="margin:0 0 12px;font-size:10px;color:var(--muted)">资产类别</h4>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          ${['硬件设备','软件/SaaS','网络设备','服务器','移动设备','证书/域名','周边配件','其他'].map(c => `<span class="tag-chip" style="padding:5px 10px">${c}</span>`).join('')}
        </div>
        <p style="font-size:9px;color:var(--muted)">资产类别通过「登记资产」表单的类别字段管理，暂不支持自定义。</p>
      </div>
    </div>`;
    el.querySelector('#save-it-config')?.addEventListener('click', async () => {
      const settings = {
        helpdesk_email: document.getElementById('it-helpdesk-email').value,
        sla_high_hours: Number(document.getElementById('it-sla-high').value),
        sla_medium_hours: Number(document.getElementById('it-sla-medium').value),
        license_expiry_warn_days: Number(document.getElementById('it-license-warn').value)
      };
      try { await API.patch('/v1/settings/it', settings); toast('IT 配置已保存'); } catch(e) { toast(e.message,'error'); }
    });
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败</p>`; }
}

// ──────────────────────────────────────────────────────────────
// ── AI 智能体
// ──────────────────────────────────────────────────────────────
let currentConversationId = null;
async function sendAIMessage(message) {
  const mainFlow = document.querySelector('#ai-main-flow');
  const chatFlow = mainFlow || document.querySelector('.chat-flow');
  if (!chatFlow) return;
  if (mainFlow) mainFlow.querySelector('.ai-welcome-message')?.remove();
  const userBubble = document.createElement('div');
  userBubble.className = 'user-message';
  userBubble.innerHTML = `<p>${esc(message)}</p>`;
  chatFlow.append(userBubble);
  const thinkingBubble = document.createElement('div');
  thinkingBubble.className = 'assistant-message thinking';
  thinkingBubble.innerHTML = `<span class="ai-orb thinking-orb">✦</span><p class="loading-text">正在理解问题并查询数据…（最长 45 秒）</p>`;
  chatFlow.append(thinkingBubble);
  chatFlow.scrollTop = chatFlow.scrollHeight;
  const toolLabels = { query_projects: '项目', query_crm: '客户/商机', query_hr: '人事', query_finance: '财务', search_knowledge: '知识库', get_workspace_overview: '经营总览', query_dashboard: '经营看板', query_team_overview: '团队' };
  let streamed = "";
  const streamTools = [];
  let streamCitations = [];
  const renderToolChips = () => streamTools.length
    ? `<div class="ai-tool-chips">${[...new Set(streamTools)].map(t => `<span>已查询 ${esc(toolLabels[t] || t)}</span>`).join('')}</div>`
    : "";
  const renderCitations = (items) => (items || []).length
    ? `<div class="ai-citations">${items.map(c => `<button type="button" class="ai-citation" data-ai-citation="${esc(c.type)}" data-ai-id="${esc(c.id)}">${esc(c.title)} ↗</button>`).join('')}</div>`
    : "";
  try {
    const res = await fetch('/v1/ai/chat/stream', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, conversation_id: currentConversationId, context_module: location.hash.slice(1) || 'overview' }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    }
    if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) throw new Error('stream_unsupported');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalMessage = "";
    const consume = (block) => {
      let event = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) return;
      let data; try { data = JSON.parse(dataLines.join("\n")); } catch { return; }
      if (event === "meta" && data.conversation_id) currentConversationId = data.conversation_id;
      else if (event === "delta" && data.text) {
        streamed += data.text;
        thinkingBubble.className = 'assistant-message';
        thinkingBubble.innerHTML = `<p>${esc(streamed)}</p>`;
        chatFlow.scrollTop = chatFlow.scrollHeight;
      } else if (event === "tool" && data.name) {
        if (!streamTools.includes(data.name)) streamTools.push(data.name);
        thinkingBubble.innerHTML = `<p>${esc(streamed)}</p>${renderToolChips()}`;
      } else if (event === "done") {
        finalMessage = data.message || streamed;
        streamCitations = data.citations || [];
        if (data.budget?.percent >= 80) toast(`AI 本月预算已使用 ${Math.round(data.budget.percent)}%`, 'error');
      } else if (event === "error") {
        const err = new Error(data.error || 'ai_stream_error');
        err.code = data.error;
        err.hint = data.message;
        throw err;
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consume(block.replace(/\r/g, ""));
    }
    if (buffer.trim()) consume(buffer.replace(/\r/g, ""));
    thinkingBubble.className = 'assistant-message';
    thinkingBubble.innerHTML = `<p>${aiText(finalMessage || streamed || 'AI 未返回内容')}</p>${renderToolChips()}${renderCitations(streamCitations)}`;
  } catch(e) {
    // 旧服务端/代理不支持 SSE 时，退回一次性接口；业务错误不重试。
    const canFallback = e.message === 'stream_unsupported' || (e.status && ![400, 401, 403, 429, 503].includes(e.status));
    if (canFallback) {
      try {
        const result = await API.post('/v1/ai/chat', { message, conversation_id: currentConversationId, context_module: location.hash.slice(1) || 'overview' });
        currentConversationId = result.conversation_id;
        thinkingBubble.className = 'assistant-message';
        const tools = (result.tools_used || []).length ? `<div class="ai-tool-chips">${result.tools_used.map(t => `<span>已查询 ${esc(toolLabels[t] || t)}</span>`).join('')}</div>` : '';
        thinkingBubble.innerHTML = `<p>${aiText(result.message || '')}</p>${tools}${renderCitations(result.citations)}`;
        chatFlow.scrollTop = chatFlow.scrollHeight;
        return;
      } catch (fallbackError) { e = fallbackError; }
    }
    thinkingBubble.className = 'assistant-message error';
    const notConfigured = e.code === 'ai_not_configured' || e.message === 'ai_not_configured' || e.message === 'model_api_key_required' || /未配置/.test(e.message);
    const hint = notConfigured
      ? 'AI 模型尚未配置。请联系管理员在「管理设置 → AI 模型与预算」中设置。'
      : e.code === 'ai_budget_exceeded' ? (e.hint || 'AI 本月预算已用尽，请联系管理员调整预算。')
      : (e.code === 'ai_timeout' || e.message === 'ai_timeout' ? 'AI 响应超时，请稍后重试或把问题拆小一点。' : (e.hint || e.message || 'AI 暂时无法响应，请稍后重试。'));
    thinkingBubble.innerHTML = `<p style="color:var(--muted)">${esc(hint)}</p>
      ${notConfigured ? '' : `<button type="button" class="btn ghost small" data-ai-retry="${esc(message)}" style="margin-top:8px">重试</button>`}`;
  }
  chatFlow.scrollTop = chatFlow.scrollHeight;
  if (mainFlow) chatFlow.closest('.ai-thread-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function handleModuleAIAnalysis(module, question) {
  try {
    toast('AI 正在分析…');
    const result = await API.post('/v1/ai/analyze', { module, question });
    Modal.show(`AI 分析 · ${document.querySelector('.module-hero h1')?.textContent?.trim() || module}`, `
      <div style="max-height:400px;overflow-y:auto;font-size:10px;line-height:1.8">
        ${aiText(result.analysis || 'AI 暂未返回结果')}
      </div>`, null, { hideSubmit: true });
  } catch(e) {
    toast(e.message === 'ai_not_configured' ? 'AI 模型尚未配置，请联系管理员设置 MODEL_API_KEY' : ('AI 分析失败：' + e.message), 'error');
  }
}

// ──────────────────────────────────────────────────────────────
// ── 审批中心
// ──────────────────────────────────────────────────────────────
const APPROVAL_MODULE = { hr:'人事', finance:'财务', it:'IT', all:'全部' };
const APPROVAL_STATUS = { pending:'待审批', approved:'已通过', rejected:'已拒绝', withdrawn:'已撤回', cancelled:'已取消' };
let _approvalTab = 'pending';
let _approvalFlowEditor = null;

async function loadApprovalsData() {
  const el = document.getElementById('approvals-content');
  if (!el) return;

  Promise.allSettled([
    API.get('/v1/approvals/pending'), API.get('/v1/approvals/my-requests'),
    API.get('/v1/approvals?limit=100'), API.get('/v1/approval-flows'),
  ]).then(([pending, mine, all, flows]) => {
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    if (stats[0] && pending.status === 'fulfilled') stats[0].textContent = String((pending.value.items || []).length);
    if (stats[1] && mine.status === 'fulfilled') stats[1].textContent = String((mine.value.items || []).length);
    if (stats[2] && all.status === 'fulfilled') {
      const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
      stats[2].textContent = String((all.value.items || []).filter(a => a.status === 'approved' && a.resolved_at && new Date(a.resolved_at) >= since).length);
    }
    if (stats[3] && flows.status === 'fulfilled') stats[3].textContent = String((flows.value.items || []).filter(f => f.is_active).length);
  }).catch(() => {});

  // Build tabs toolbar if not already there
  const panel = el.closest('.module-table-panel');
  let toolbar = panel?.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('[data-approval-tab]')) {
    toolbar.innerHTML = `
      <div class="filter-tabs">
        <button data-approval-tab="pending" class="${_approvalTab==='pending'?'active':''}">待我审批</button>
        <button data-approval-tab="mine" class="${_approvalTab==='mine'?'active':''}">我发起的</button>
        <button data-approval-tab="all" class="${_approvalTab==='all'?'active':''}">全部记录</button>
        <button data-approval-tab="flows" class="${_approvalTab==='flows'?'active':''}">审批流配置</button>
      </div>
      <div class="table-tools"><button type="button">⌕ 搜索</button></div>`;
    toolbar.querySelectorAll('[data-approval-tab]').forEach(btn => {
      btn.addEventListener('click', () => { _approvalTab = btn.dataset.approvalTab; loadApprovalsData(); });
    });
  } else if (toolbar) {
    toolbar.querySelectorAll('[data-approval-tab]').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.approvalTab === _approvalTab));
  }

  if (_approvalTab === 'flows') { await renderApprovalFlows(el); return; }

  el.innerHTML = `<p class="loading-text" style="padding:20px">加载中…</p>`;

  try {
    let url = '/v1/approvals/pending';
    if (_approvalTab === 'mine') url = '/v1/approvals/my-requests';
    else if (_approvalTab === 'all') url = '/v1/approvals';

    const { items } = await API.get(url);

    if (!items.length) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">
        <div style="font-size:32px;margin-bottom:12px">${_approvalTab==='pending'?'✓':'◇'}</div>
        <h3 style="font-size:14px;margin:0 0 4px">${_approvalTab==='pending'?'暂无待处理审批':'暂无申请记录'}</h3>
        <p style="font-size:11px;margin:0">所有审批都会在这里汇总显示</p>
      </div>`;
      // Update badge
      const badge = document.getElementById('approval-badge');
      if (badge) badge.style.display = 'none';
      return;
    }

    // Update pending badge
    if (_approvalTab === 'pending') {
      const badge = document.getElementById('approval-badge');
      if (badge) { badge.style.display = items.length ? '' : 'none'; }
    }

    const cols = _approvalTab === 'pending'
      ? ['申请内容','申请人','审批流','步骤','申请时间','操作']
      : ['申请内容','状态','审批流','步骤进度','申请时间','结果'];

    el.innerHTML = `<table class="data-table">
      <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${items.map(item => {
        const statusPill = `<span class="status-pill ${item.status==='rejected'?'warning':item.status==='approved'?'':''}">
          ${APPROVAL_STATUS[item.status] ?? item.status}</span>`;
        const stepProgress = `${item.current_step}/${item.total_steps}`;
        const timeStr = new Date(item.created_at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});
        const summary = typeof item.summary === 'object' ? item.summary : {};

        if (_approvalTab === 'pending') {
          return `<tr data-approval-id="${esc(item.id)}" style="cursor:pointer">
            <td><div class="entity"><span class="project-code blue">${(item.flow_name||'').slice(0,2)}</span>
              <b>${esc(item.title)}</b></div></td>
            <td><span class="person-chip">${(item.requester_name||'?').slice(0,1)}</span>${esc(item.requester_name||'—')}</td>
            <td>${esc(item.flow_name||'—')}</td>
            <td>${stepProgress}</td>
            <td>${timeStr}</td>
            <td>
              <button class="btn" style="padding:4px 10px;font-size:10px;background:var(--jade);color:#fff;border:none;border-radius:6px;cursor:pointer"
                onclick="approvalDecide('${esc(item.id)}','approved')">同意</button>
              <button class="btn" style="padding:4px 10px;font-size:10px;background:#fee2e2;color:#dc2626;border:none;border-radius:6px;cursor:pointer;margin-left:4px"
                onclick="approvalDecide('${esc(item.id)}','rejected')">拒绝</button>
            </td>
          </tr>`;
        } else {
          const resolvedAt = item.resolved_at
            ? new Date(item.resolved_at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})
            : '—';
          return `<tr data-approval-id="${esc(item.id)}" style="cursor:pointer">
            <td><div class="entity"><span class="project-code ${item.status==='approved'?'green':item.status==='rejected'?'amber':'blue'}">${(item.flow_name||'').slice(0,2)}</span>
              <b>${esc(item.title)}</b></div></td>
            <td>${statusPill}</td>
            <td>${esc(item.flow_name||'—')}</td>
            <td>${stepProgress}</td>
            <td>${timeStr}</td>
            <td>${resolvedAt}</td>
          </tr>`;
        }
      }).join('')}</tbody>
    </table>
    <footer class="table-footer"><span>共 ${items.length} 条记录</span></footer>`;
  } catch(e) {
    el.innerHTML = `<p class="loading-text" style="padding:20px;color:var(--warning)">加载失败：${esc(e.message)}</p>`;
  }
}

async function renderApprovalFlows(el) {
  el.innerHTML = `<p class="loading-text" style="padding:20px">加载审批流配置…</p>`;
  try {
    const { items } = await API.get('/v1/approval-flows');
    const stepTypeLabel = { manager:'直属上级', role:'管理员', person:'指定人员' };
    el.innerHTML = `<div style="padding:16px">
      <h4 style="margin:0 0 12px;font-size:10px;color:var(--muted)">审批流配置 · 可为每个业务场景指定审批链</h4>
      ${items.map(flow => {
        const steps = Array.isArray(flow.steps) ? flow.steps : JSON.parse(flow.steps || '[]');
        return `<div style="border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <b style="font-size:13px">${esc(flow.name)}</b>
              <span style="font-size:10px;color:var(--muted);margin-left:8px;background:var(--jade-soft);padding:2px 6px;border-radius:4px">${esc(flow.module)}</span>
              ${!flow.is_active ? '<span style="font-size:10px;color:#dc2626;margin-left:4px">已停用</span>' : ''}
            </div>
            <button style="font-size:10px;color:var(--jade);background:none;border:none;cursor:pointer"
              onclick="editApprovalFlow('${esc(flow.code)}')">编辑审批链</button>
          </div>
          ${flow.description ? `<p style="font-size:11px;color:var(--muted);margin:6px 0 10px">${esc(flow.description)}</p>` : ''}
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${steps.map((s, i) => `
              <span style="display:flex;align-items:center;gap:4px">
                <span style="background:var(--jade-soft);color:var(--jade);border-radius:20px;padding:3px 10px;font-size:11px">
                  ${i+1}. ${esc(s.label || stepTypeLabel[s.type] || s.type)}
                </span>
                ${i < steps.length - 1 ? '<span style="color:var(--muted)">→</span>' : ''}
              </span>
            `).join('')}
            ${flow.auto_approve_if_no_approver ? '<span style="font-size:10px;color:var(--muted)">(无审批人时自动通过)</span>' : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  } catch(e) {
    el.innerHTML = `<p style="padding:20px;color:var(--warning)">加载失败：${esc(e.message)}</p>`;
  }
}

async function openApprovalDetail(id) {
  Drawer.show('审批详情', '<p class="loading-text">加载中…</p>');
  let a;
  try { a = await API.get(`/v1/approvals/${id}`); }
  catch (e) { Drawer.setBody(`<p class="error-hint">加载失败：${esc(e.message)}</p>`); return; }
  const actions = a.actions || [];
  const summary = typeof a.summary === 'object' ? a.summary : {};
  const rows = Object.entries(summary).filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:10px"><span style="color:var(--muted)">${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('');
  Drawer.setBody(`
    <div class="detail-header"><span class="project-code blue">${esc((a.flow_name || '审').slice(0, 2))}</span>
      <div><h3>${esc(a.title)}</h3><p>${esc(a.requester_name || '')} · ${esc(a.flow_name || '')}</p></div></div>
    <div class="detail-stats">
      <div><small>状态</small><strong>${esc(APPROVAL_STATUS[a.status] || a.status)}</strong></div>
      <div><small>当前步骤</small><strong>${a.current_step}/${a.total_steps}</strong></div>
      <div><small>资源类型</small><strong>${esc(a.resource_type || '—')}</strong></div>
      <div><small>发起时间</small><strong>${new Date(a.created_at).toLocaleString('zh-CN')}</strong></div>
    </div>
    ${a.status === 'pending' ? `<div style="display:flex;gap:8px;margin:0 0 12px">
      <button class="btn ghost small" type="button" id="appr-transfer">转交</button>
      <button class="btn ghost small" type="button" id="appr-addsign">加签</button>
    </div>` : ''}
    <div class="detail-section"><h4>申请内容</h4>${rows || '<p class="empty-hint">—</p>'}</div>
    <div class="detail-section"><h4>审批链</h4>
      ${actions.length ? actions.map(x => `<div style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line-soft)">
        <span class="badge">${x.step_order}</span>
        <div style="flex:1"><b style="font-size:10px">${esc(x.approver_name || '待指派')}</b>
        <p style="font-size:9px;color:var(--muted);margin:2px 0">${esc(x.status)}${x.decided_at ? ' · ' + new Date(x.decided_at).toLocaleString('zh-CN') : ''}${x.comment ? ' · ' + esc(x.comment) : ''}</p></div>
      </div>`).join('') : '<p class="empty-hint">暂无审批动作</p>'}
    </div>
  `);
  document.getElementById('appr-transfer')?.addEventListener('click', () => {
    Modal.show('转交审批', `
      <p style="font-size:10px;color:var(--muted);margin-bottom:10px">转交后由新审批人处理当前步骤，原审批人仍会留在审计记录中。</p>
      ${PersonPicker.html('person_id', '转交给')}
      <div class="form-row"><span>转交说明</span><input name="reason" placeholder="如：出差期间由同事代办"></div>
    `, async (data) => {
      if (!data.person_id) throw new Error('请选择审批人');
      await API.post(`/v1/approvals/${id}/transfer`, { person_id: data.person_id, reason: data.reason });
      toast('审批已转交');
      openApprovalDetail(id);
    });
  });
  document.getElementById('appr-addsign')?.addEventListener('click', () => {
    Modal.show('加签', `
      <p style="font-size:10px;color:var(--muted);margin-bottom:10px">加签会在当前步骤前/后插入一位审批人。</p>
      ${PersonPicker.html('person_id', '加签给')}
      <div class="form-row"><span>位置</span><select name="position"><option value="after">当前审批人之后</option><option value="before">当前审批人之前</option></select></div>
      <div class="form-row"><span>说明</span><input name="reason" placeholder="为什么要加签"></div>
    `, async (data) => {
      if (!data.person_id) throw new Error('请选择审批人');
      await API.post(`/v1/approvals/${id}/add-sign`, { person_id: data.person_id, position: data.position, reason: data.reason });
      toast('已加签');
      openApprovalDetail(id);
    });
  });
}

window.approvalDecide = async (id, decision) => {
  const submit = async (comment) => {
    try {
      await API.post(`/v1/approvals/${id}/decide`, { decision, comment });
      toast(decision === 'approved' ? '审批已通过' : '审批已拒绝');
      loadApprovalsData();
    } catch(e) { toast(e.message, 'error'); }
  };
  if (decision !== 'rejected') return submit(null);
  Modal.show('拒绝审批', `
    <p style="font-size:10px;color:var(--muted);margin-bottom:10px">拒绝原因会同步给申请人，请写清楚需要补充或修改的内容。</p>
    <div class="form-row"><span>拒绝原因</span><textarea name="comment" rows="4" placeholder="如：缺少报价单，请补充后重新提交"></textarea></div>
  `, async (data) => { await submit(data.comment || null); });
};

window.editApprovalFlow = (code) => {
  API.get('/v1/approval-flows').then(({ items }) => {
    const flow = items.find(f => f.code === code);
    if (!flow) return;
    const steps = Array.isArray(flow.steps) ? flow.steps : JSON.parse(flow.steps || '[]');
    const stepTypeLabel = { manager:'直属上级', role:'管理员', person:'指定人员' };
    Modal.show(`编辑审批链 — ${flow.name}`, `
      <p style="font-size:11px;color:var(--muted);margin-bottom:12px">${esc(flow.description || '')}</p>
      <div id="approval-steps-editor" style="margin-bottom:12px">
        ${steps.map((s, i) => `
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px" data-step-idx="${i}">
            <span style="font-size:10px;color:var(--muted);min-width:16px">${i+1}</span>
            <select name="step_type_${i}" style="flex:1;padding:6px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:11px">
              <option value="manager" ${s.type==='manager'?'selected':''}>直属上级</option>
              <option value="role" ${s.type==='role'?'selected':''}>管理员</option>
              <option value="person" ${s.type==='person'?'selected':''}>指定人员</option>
            </select>
            <input name="step_label_${i}" value="${esc(s.label)}" placeholder="步骤名称"
              style="flex:2;padding:6px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:11px">
            <input type="number" name="step_min_amount_${i}" value="${s.min_amount_cents ? Math.round(Number(s.min_amount_cents) / 100) : ''}"
              placeholder="金额≥(元)" title="只有金额达到该值时这一步才生效；留空表示始终生效"
              style="width:92px;padding:6px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:11px">
          </div>
        `).join('')}
      </div>
      <div class="form-cols" style="margin-bottom:8px">
        <div class="form-row"><span>超时提醒（小时）</span><input type="number" name="timeout_hours" min="1" value="${flow.timeout_hours || 48}"></div>
      </div>
      <div class="form-row checkbox" style="margin-bottom:8px">
        <input type="checkbox" name="auto_approve_if_no_approver" ${flow.auto_approve_if_no_approver ? 'checked' : ''}>
        <span>无审批人时自动通过</span>
      </div>
      <div class="form-row checkbox">
        <input type="checkbox" name="is_active" ${flow.is_active ? 'checked' : ''}>
        <span>审批流已启用</span>
      </div>
    `, async (data) => {
      const newSteps = steps.map((s, i) => {
        const minYuan = Number(data[`step_min_amount_${i}`]);
        return {
          order: i + 1,
          type: data[`step_type_${i}`] || 'manager',
          label: data[`step_label_${i}`] || `第${i+1}步`,
          ...(s.person_id ? { person_id: s.person_id } : {}),
          ...(minYuan > 0 ? { min_amount_cents: Math.round(minYuan * 100) } : {}),
        };
      });
      await API.patch(`/v1/approval-flows/${code}`, {
        steps: newSteps,
        timeout_hours: Number(data.timeout_hours) || 48,
        auto_approve_if_no_approver: 'auto_approve_if_no_approver' in data,
        is_active: 'is_active' in data
      });
      toast('审批流已更新');
      loadApprovalsData();
    });
  }).catch(e => toast(e.message, 'error'));
};

// Poll for pending approvals count every 2 minutes to update badge
setInterval(async () => {
  try {
    const { items } = await API.get('/v1/approvals/pending');
    const badge = document.getElementById('approval-badge');
    if (badge) badge.style.display = items.length ? '' : 'none';
  } catch {}
}, 120_000);

// ──────────────────────────────────────────────────────────────
// ── 经营总览（首页）真实数据加载
// ──────────────────────────────────────────────────────────────
async function loadOverviewData() {
  const [projRes, apprRes, finRes, crmRes, orgRes, payRes] = await Promise.allSettled([
    API.get('/v1/projects?limit=100'),
    API.get('/v1/approvals/pending'),
    API.get('/v1/finance/overview'),
    API.get('/v1/crm/opportunities?limit=100'),
    API.get('/v1/org/tree'),
    API.get('/v1/finance/payments?limit=5')
  ]);
  const projects = projRes.status === 'fulfilled' ? (projRes.value.items || []) : [];
  const pending  = apprRes.status === 'fulfilled' ? (apprRes.value.items || []) : [];
  const fin      = finRes.status  === 'fulfilled' ? finRes.value : null;
  const opps     = crmRes.status  === 'fulfilled' ? (crmRes.value.items || []) : [];
  const org      = orgRes.status  === 'fulfilled' ? orgRes.value : null;
  const payments = payRes.status  === 'fulfilled' ? (payRes.value.items || []) : [];

  renderOverviewMetrics(projects, fin, opps, org);
  renderOverviewProjects(projects);
  renderOverviewDecisions(pending, projects);
  renderOverviewCash(fin, payments);
  renderOverviewAIRail(projects, pending, opps);
}

function renderOverviewMetrics(projects, fin, opps, org) {
  const cards = document.querySelectorAll('.metric-grid:not(.module-metrics) .metric-card');
  if (!cards.length) return;
  if (fin?.payments && cards[0]) {
    cards[0].querySelector('strong').textContent = money(fin.payments.collected_total);
  }
  if (cards[1]) {
    const pipeline = opps.filter(o => !['won','lost'].includes(o.stage)).reduce((s,o) => s + Number(o.amount_cents||0), 0);
    cards[1].querySelector('strong').textContent = money(pipeline);
    const info = cards[1].querySelector('.metric-top i');
    if (info) info.innerHTML = `<b>${opps.filter(o => !['won','lost'].includes(o.stage)).length}</b> 个活跃商机`;
  }
  if (projects.length && cards[2]) {
    const healthy = projects.filter(p => !['at_risk','cancelled'].includes(p.status)).length;
    cards[2].querySelector('strong').innerHTML = `${Math.round(healthy/projects.length*100)}<span class="unit">%</span>`;
    const info = cards[2].querySelector('.metric-top i');
    if (info) info.innerHTML = `<b>${healthy}</b> / ${projects.length} 正常`;
  }
  if (cards[3] && org) {
    const count = (nodes) => (nodes || []).reduce((sum, n) => sum + Number(n.headcount || 0) + count(n.children), 0);
    cards[3].querySelector('strong').textContent = `${count(org.roots)}人`;
  }
}

function renderOverviewProjects(projects) {
  const list = document.querySelector('.project-panel .project-list');
  if (!list) return;
  const btn = document.querySelector('.project-panel .panel-head button');
  if (btn) btn.textContent = `查看全部 ${projects.length} 个 →`;
  const active = projects.filter(p => ['active','at_risk','planning','on_hold'].includes(p.status));
  if (!active.length) {
    list.innerHTML = '<p class="empty-hint" style="padding:16px;color:var(--muted);font-size:9px">暂无进行中的项目，前往项目管理创建第一个项目。</p>';
    return;
  }
  const colors = ['blue','green','amber','violet','teal'];
  const typeLabel = { delivery:'交付项目', internal:'内部项目', rd:'研发项目' };
  list.innerHTML = active.slice(0,4).map((p,i) => `
    <button class="project-row" type="button" data-proj-id="${p.id}">
      <span class="project-code ${colors[i%5]}">${esc((p.code||p.name||'P').slice(0,2))}</span>
      <span class="project-main"><b>${esc(p.name)}</b><small><i>${esc(typeLabel[p.type]||p.customer_name||'内部项目')}</i> · 截止 ${fmtDate(p.end_date)}</small></span>
      <span class="project-progress"><i><b style="width:${p.progress||0}%"></b></i><small>${p.progress||0}%</small></span>
      <em class="${p.status==='at_risk'?'risk':'steady'}">${PROJ_STATUS[p.status]||p.status}</em>
    </button>`).join('');
  list.querySelectorAll('[data-proj-id]').forEach(b => b.addEventListener('click', () => openProjectDetail(b.dataset.projId)));
}

function renderOverviewDecisions(pending, projects) {
  const strip = document.querySelector('.decision-strip');
  if (!strip) return;
  const list = strip.querySelector('.decision-list');
  const heading = strip.querySelector('.decision-heading strong');
  const more = strip.querySelector('.more-decisions');
  const items = [];
  pending.forEach(a => items.push({
    priority: 'high', title: esc(a.title || '待审批事项'),
    sub: `${esc(a.requester_name||'')} 发起 · ${esc(a.flow_name||'审批')}`,
    action: () => window.renderView?.('approvals')
  }));
  projects.filter(p => p.status === 'at_risk').forEach(p => items.push({
    priority: 'medium', title: `${esc(p.name)} 存在交付风险`,
    sub: `进度 ${p.progress||0}% · 截止 ${fmtDate(p.end_date)}`,
    action: () => openProjectDetail(p.id)
  }));
  if (heading) heading.textContent = items.length ? `${items.length} 件事需要你的判断` : '暂无待你决策的事项';
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<p class="empty-hint" style="padding:12px;color:var(--muted);font-size:9px">当前没有需要你处理的决策，经营状态平稳。</p>';
    if (more) more.style.display = 'none';
    return;
  }
  const shown = items.slice(0,2);
  list.innerHTML = shown.map((it,i) => `
    <button type="button" data-dec-idx="${i}"><i class="priority ${it.priority}">${it.priority==='high'?'高':'中'}</i><span><b>${it.title}</b><small>${it.sub}</small></span><em>处理 →</em></button>`).join('');
  list.querySelectorAll('[data-dec-idx]').forEach(b => b.addEventListener('click', () => shown[+b.dataset.decIdx].action()));
  if (more) {
    const rest = items.length - shown.length;
    if (rest > 0) { more.style.display = ''; more.innerHTML = `还有 ${rest} 项 <span>↓</span>`; more.onclick = () => window.renderView?.('approvals'); }
    else more.style.display = 'none';
  }
}

function renderOverviewCash(fin, payments = []) {
  const summary = document.querySelector('.cash-panel .cash-summary');
  if (!summary || !fin) return;
  const wan = c => { const v = Number(c || 0) / 1e6; return v ? v.toFixed(1) : '0'; };
  const upcoming = payments.filter(p => ['planned', 'invoiced', 'overdue'].includes(p.status)).slice(0, 3);
  summary.innerHTML = `
    <div><small>预计流入（30天应收）</small><strong>+ ${wan(fin.payments?.upcoming_receivable)} 万</strong></div>
    <div><small>待付支出（报销/应付）</small><strong>${Number(fin.expenses?.pending_expenses || 0) ? '- ' : ''}${wan(fin.expenses?.pending_expenses)} 万</strong></div>
    ${upcoming.length ? `<div style="grid-column:1/-1;margin-top:8px;border-top:1px solid var(--line-soft);padding-top:8px">
      ${upcoming.map(p => `<button type="button" data-cash-payment="${esc(p.id)}" style="width:100%;display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:9px;background:none;border:0;text-align:left;cursor:pointer"><span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.customer_name)} · ${esc(p.milestone)}</span><b>${money(p.amount_cents)} · ${fmtDate(p.due_date)}</b></button>`).join('')}
    </div>` : ''}`;
}

function renderOverviewAIRail(projects, pending, opps) {
  const flow = document.querySelector('.ai-rail .chat-flow .assistant-message');
  if (!flow) return;
  const atRisk = projects.filter(p => p.status === 'at_risk').length;
  const closing = opps.filter(o => ['negotiation','proposal'].includes(o.stage)).length;
  const items = [];
  if (pending.length) items.push(`<b>${pending.length} 项审批待你处理</b>可在审批中心集中批复。`);
  if (atRisk)         items.push(`<b>${atRisk} 个项目存在交付风险</b>建议优先查看进度与资源。`);
  if (closing)        items.push(`<b>${closing} 个商机进入关键阶段</b>及时跟进有助于本月回款。`);
  if (!items.length) {
    flow.innerHTML = `<p>你好。当前经营状态整体平稳，没有需要立即处理的风险项。有任何问题都可以直接问我。</p>`;
    return;
  }
  flow.innerHTML = `<p>你好。我梳理了当前 <strong>${items.length} 个值得关注的点</strong>：</p><ol>${items.map((t,i)=>`<li><span>${String(i+1).padStart(2,'0')}</span><p>${t}</p></li>`).join('')}</ol>`;
}

// ──────────────────────────────────────────────────────────────
// ── 成员与权限（RBAC）管理
// ──────────────────────────────────────────────────────────────
const RBAC_LABELS = { tenant_admin:'企业管理员', hr_manager:'人事管理员', finance_manager:'财务管理员', manager:'部门主管', employee:'普通员工' };
function rbacLabel(code) { return RBAC_LABELS[code] || code; }
let _rbacMembers = [];
let _rbacCatalog = [];

async function loadRbacPanel() {
  const el = document.getElementById('rbac-panel');
  if (!el) return;
  // 刷新当前用户能力（供全局按权限渲染）
  try { window.FeishuHQ.caps = await API.get('/v1/me/capabilities'); } catch {}
  if (!can('people.manage_roles')) {
    const roles = (window.FeishuHQ?.caps?.roles || []).filter(r => r !== 'employee');
    el.innerHTML = `<header class="panel-head"><div><span class="section-kicker">ACCESS CONTROL</span><h2>成员与权限</h2></div></header>
      <p class="empty-hint" style="padding:16px;color:var(--muted);font-size:9px">仅企业管理员可管理成员岗位权限。你当前的角色：<b>${roles.map(rbacLabel).join('、') || '普通员工'}</b>。</p>`;
    return;
  }
  el.innerHTML = `<header class="panel-head"><div><span class="section-kicker">ACCESS CONTROL</span><h2>成员与权限</h2></div></header><p class="loading-text" style="padding:16px">加载中…</p>`;
  try {
    const [{ items }, { roles: catalog }] = await Promise.all([
      API.get('/v1/rbac/members'),
      API.get('/v1/rbac/catalog')
    ]);
    _rbacMembers = items; _rbacCatalog = catalog;
    renderRbacMembers(el);
  } catch(e) { el.innerHTML = `<p class="error-hint" style="padding:16px">加载失败：${esc(e.message)}</p>`; }
}

function renderRbacMembers(el) {
  el.innerHTML = `
    <header class="panel-head"><div><span class="section-kicker">ACCESS CONTROL</span><h2>成员与权限</h2></div>
      <span style="font-size:9px;color:var(--muted)">${_rbacMembers.length} 位成员</span></header>
    <div style="padding:0 16px 16px">
      <p style="font-size:9px;color:var(--muted);margin:0 0 12px">为成员分配岗位角色，角色决定其可执行的敏感操作（薪资、财务审批、员工管理等）。默认所有人仅有普通员工的自助权限。</p>
      <table class="data-table"><thead><tr><th>成员</th><th>岗位角色</th><th style="width:80px"></th></tr></thead>
      <tbody>${_rbacMembers.map((m,i) => {
        const roles = (m.roles||[]).filter(r => r !== 'employee');
        return `<tr>
          <td><div class="entity"><span class="person-chip">${avatar(m.display_name)}</span><div><b>${esc(m.display_name)}</b><small style="color:var(--muted);display:block">${esc(m.primary_email||'')}</small></div></div></td>
          <td>${roles.length ? roles.map(r=>`<span class="tag-chip">${rbacLabel(r)}</span>`).join(' ') : '<span style="color:var(--muted)">普通员工</span>'}</td>
          <td><button class="btn ghost small" data-rbac-idx="${i}">编辑角色</button></td>
        </tr>`;
      }).join('')}</tbody></table>
    </div>`;
  el.querySelectorAll('[data-rbac-idx]').forEach(b => b.addEventListener('click', () => openRoleEditor(_rbacMembers[+b.dataset.rbacIdx])));
}

function openRoleEditor(member) {
  const current = new Set(member.roles || []);
  Modal.show(`编辑角色 · ${member.display_name}`, `
    <p style="font-size:9px;color:var(--muted);margin-bottom:10px">勾选该成员的岗位角色；不勾选则为普通员工（仅本人自助权限）。</p>
    ${_rbacCatalog.map(r => `
      <label class="form-row checkbox" style="align-items:flex-start;gap:8px">
        <input type="checkbox" name="role_${r.code}" ${current.has(r.code)?'checked':''}>
        <span><b>${esc(r.label)}</b><small style="display:block;color:var(--muted)">${esc(r.description)}</small></span>
      </label>`).join('')}
  `, async (data) => {
    const roles = _rbacCatalog.map(r => r.code).filter(code => data[`role_${code}`]);
    await API.put(`/v1/rbac/members/${member.id}/roles`, { roles });
    toast('角色权限已更新');
    loadRbacPanel();
  });
}
window.openRoleEditor = openRoleEditor;

// ──────────────────────────────────────────────────────────────
// ── 模块数据加载器映射
// ──────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// 高层看板 / 合同与订阅 / 研发中心（docs/15 P2 · 真实数据，无写死）
// ═══════════════════════════════════════════════════════════════

function simpleTable(headers, rows) {
  return `<table class="data-table"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${headers.length}"><p class="loading-text" style="padding:20px">暂无数据</p></td></tr>`
  }</tbody></table>`;
}

async function loadDashboardData() {
  const wrap = document.querySelector('#dashboard-content');
  if (!wrap) return;
  wrap.innerHTML = `<p class="loading-text" style="padding:20px">正在加载经营数据…</p>`;
  let d;
  try { d = await API.get('/v1/dashboard/executive'); }
  catch (e) {
    wrap.innerHTML = `<p class="error-hint" style="padding:20px">${e.status === 403 ? '高层看板仅管理层角色（企业管理员 / 部门主管 / 人事 / 财务）可见。' : '加载失败：' + esc(e.message)}</p>`;
    return;
  }
  const stats = document.querySelectorAll('.module-metrics .metric-card strong');
  const f = d.finance || {};
  if (stats[0]) stats[0].textContent = money(f.month_collected_cents);
  if (stats[1]) stats[1].textContent = money(f.month_expense_cents);
  if (stats[2]) stats[2].textContent = money(f.outstanding_ar_cents);
  if (stats[3]) stats[3].textContent = String(d.approvals_pending ?? 0);
  const card = (title, rows) => `<div class="panel" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px"><span></span>${esc(title)}</div>${rows.map(r=>`<div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-bottom:1px solid var(--line-soft)"><span style="color:var(--muted)">${esc(r[0])}</span><b>${r[1]}</b></div>`).join('')}</div>`;
  const subs = d.subscriptions, mfg = d.manufacturing, del = d.delivery;
  const cols = [];
  cols.push(card('销售与订阅', [
    ['销售漏斗', money(d.sales?.pipeline_cents)],
    ['开放商机', String(d.sales?.open_opportunities ?? 0)],
    ['90 天赢单率', d.sales?.win_rate_90d_pct != null ? d.sales.win_rate_90d_pct + '%' : '—'],
    ...(subs ? [['MRR', money(subs.mrr_cents)], ['ARR', money(subs.arr_cents)], ['活跃订阅', String(subs.active_count)], ['30 天内待续约', String(subs.renewals_due_30d ?? 0)]] : [['订阅', '—']]),
  ]));
  if (mfg) cols.push(card('制造 KPI（实时派生）', [
    ['未结工单', String(mfg.open_work_orders)],
    ['质量良率', mfg.quality_yield_pct != null ? mfg.quality_yield_pct + '%' : '—'],
    ['准交率 OTD', mfg.otd_pct != null ? mfg.otd_pct + '%' : '—'],
    ['未结采购单', String(mfg.open_purchase_orders)],
    ['未结不合格处置', String(mfg.open_ncrs)],
  ]));
  if (del) cols.push(card('研发交付', [
    ['开放缺陷', String(del.open_defects)],
    ['严重缺陷(blocker/critical)', String(del.critical_defects)],
    ['需求池待分办', String(del.backlog_requirements)],
    ['活跃迭代', String(del.active_iterations)],
    ['近 30 天发布', String(del.releases_30d)],
  ]));
  cols.push(card('财务 · 人力 · IT', [
    ['应收 0-30 天', money(f.ar_aging_cents?.d_0_30)],
    ['应收 31-60 天', money(f.ar_aging_cents?.d_31_60)],
    ['应收 61-90 天', money(f.ar_aging_cents?.d_61_90)],
    ['应收 90 天以上', money(f.ar_aging_cents?.d_over_90)],
    ['在职人数', String(d.hr?.headcount ?? 0)],
    ['开放招聘 / 活跃候选人', `${d.hr?.open_requisitions ?? 0} / ${d.hr?.active_candidates ?? 0}`],
    ['IT 开放工单', String(d.it?.open_tickets ?? 0)],
  ]));
  const alerts = (d.leave_alerts || []).map(a=>`<div style="font-size:10px;color:var(--red);padding:2px 0">⚠ ${esc(a.person_name)} 的${esc(a.leave_type)}假余额透支（剩余 ${a.remaining_days} 天，已用 ${a.used_days} 天）</div>`).join('');
  wrap.innerHTML = `<div style="padding:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">${cols.join('')}</div>
    ${alerts ? `<div class="panel" style="padding:14px;margin:0 20px 20px"><div class="eyebrow" style="margin-bottom:8px"><span></span>假期余额告警</div>${alerts}</div>` : ''}
    <p style="padding:0 20px 16px;font-size:9px;color:var(--muted)">数据生成于 ${esc(d.generated_at || '')} · 制造 / 研发 / 订阅板块按本企业实际数据自动裁剪 · 也可让 AI 助理执行 query_dashboard 获取同口径数据</p>`;
}

let _contractsTab = 'contracts';
async function loadContractsData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  const toolbar = container.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('[data-con-tab]')) {
    toolbar.innerHTML = `<div class="filter-tabs">
      <button class="${_contractsTab==='contracts'?'active':''}" data-con-tab="contracts">合同</button>
      <button class="${_contractsTab==='subs'?'active':''}" data-con-tab="subs">订阅与 MRR</button>
    </div>`;
    toolbar.querySelectorAll('[data-con-tab]').forEach(btn => btn.addEventListener('click', () => { _contractsTab = btn.dataset.conTab; loadContractsData(); }));
  }
  const table = container.querySelector('.data-table-wrap');
  if (!table) return;
  if (_contractsTab === 'contracts') await renderContracts(table);
  else await renderSubscriptions(table);
}

const CONTRACT_STATUS = { draft: '草稿', reviewing: '评审中', approved: '已批准', signed: '已签署', closed: '已结案', rejected: '已否决', terminated: '已终止' };
async function renderContracts(el) {
  try {
    const [list, metrics] = await Promise.all([API.get('/v1/sales/contracts'), API.get('/v1/sales/subscriptions/metrics').catch(()=>null)]);
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    const signedTotal = (list.items || []).filter(c => ['signed','closed'].includes(c.status)).reduce((s,c)=>s+Number(c.amount_cents||0),0);
    const activeCount = (list.items || []).filter(c => c.status === 'signed').length;
    if (stats[0]) stats[0].textContent = money(signedTotal);
    if (stats[1]) stats[1].textContent = String(activeCount);
    if (stats[2] && metrics) stats[2].textContent = money(metrics.mrr_cents);
    if (stats[3] && metrics) stats[3].textContent = money(metrics.arr_cents);
    el.innerHTML = `<div style="padding:12px 0"><button data-tpl-create style="font-size:10px;color:#fff;background:var(--blue);border:0;border-radius:7px;padding:7px 12px;cursor:pointer">＋ 从模板创建合同</button></div>
    ` + simpleTable(['合同编号', '标题 / 客户', '类型', '金额', '状态', '签署日', '操作'], (list.items || []).map(c => [
      `<b>${esc(c.contract_no)}</b>`,
      `${esc(c.title)}<br><small style="color:var(--muted)">${esc(c.account_name || '')}${c.payment_plan_count ? ' · ' + c.payment_plan_count + ' 期收款' : ''}</small>`,
      esc(c.contract_type), money(c.amount_cents),
      esc(CONTRACT_STATUS[c.status] || c.status), fmtDate(c.sign_date),
      `<button class="btn ghost small" data-contract-id="${esc(c.id)}">详情</button>`,
    ]));
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

async function openContractDetail(id) {
  Drawer.show('合同详情', '<p class="loading-text">加载中…</p>');
  let c;
  try { c = await API.get(`/v1/sales/contracts/${id}`); }
  catch (e) { Drawer.setBody(`<p class="error-hint">加载失败：${esc(e.message)}</p>`); return; }
  const plans = c.payment_plans || [];
  const planTotal = plans.reduce((s, p) => s + Number(p.amount_cents || 0), 0);
  Drawer.setBody(`
    <div class="detail-header"><span class="project-code blue">${esc((c.contract_no || 'CT').slice(0, 4))}</span>
      <div><h3>${esc(c.title)}</h3><p>${esc(c.account_name || '')} · ${esc(CONTRACT_STATUS[c.status] || c.status)}</p></div></div>
    <div class="detail-stats">
      <div><small>合同金额</small><strong>${money(c.amount_cents)}</strong></div>
      <div><small>已排收款</small><strong>${money(planTotal)}</strong></div>
      <div><small>签署日</small><strong>${fmtDate(c.sign_date)}</strong></div>
      <div><small>负责人</small><strong>${esc(c.owner_name || '—')}</strong></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${c.status === 'draft' ? `<button class="btn primary small" id="contract-submit">提交审批</button>` : ''}
      ${c.status === 'approved' ? `<button class="btn primary small" id="contract-sign">登记签署</button>` : ''}
      ${['approved','signed'].includes(c.status) ? `<button class="btn ghost small" id="contract-add-plan">新增收款计划</button>` : ''}
    </div>
    <div class="detail-section"><h4>收款计划 <span class="badge">${plans.length}</span></h4>
      ${plans.length ? plans.map(p => `<div style="display:flex;justify-content:space-between;font-size:10px;padding:6px 0;border-bottom:1px solid var(--line-soft)">
        <span>${fmtDate(p.due_date)} · ${esc(p.milestone)}</span><b>${money(p.amount_cents)}</b>
        <span class="status-pill">${esc({ planned: '待收款', invoiced: '已开票', paid: '已收款', overdue: '已逾期', cancelled: '已取消' }[p.status] || p.status)}</span></div>`).join('') : '<p class="empty-hint">尚未安排收款计划</p>'}
    </div>
    <div class="detail-section"><h4>条款与说明</h4>
      <p style="font-size:10px;line-height:1.8;color:var(--muted)">付款条款：${esc(c.payment_terms || '—')}<br>
      合同期：${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}<br>备注：${esc(c.notes || '—')}</p></div>`);
  document.getElementById('contract-submit')?.addEventListener('click', async () => {
    try { await API.post(`/v1/sales/contracts/${id}/submit`, {}); toast('已提交审批'); openContractDetail(id); loadContractsData(); }
    catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('contract-sign')?.addEventListener('click', async () => {
    try { await API.post(`/v1/sales/contracts/${id}/sign`, {}); toast('已登记签署'); openContractDetail(id); loadContractsData(); }
    catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('contract-add-plan')?.addEventListener('click', () => {
    Modal.show('新增收款计划', `
      <div class="form-cols">
        <div class="form-row"><span>金额（元）<i class="req">*</i></span><input type="number" name="amount_yuan" min="0" required></div>
        <div class="form-row"><span>到期日 <i class="req">*</i></span><input type="date" name="due_date" required></div>
      </div>
      <div class="form-row"><span>里程碑名称 <i class="req">*</i></span><input name="milestone_title" required placeholder="如：首期款 / 验收款"></div>
    `, async (data) => {
      await API.post(`/v1/sales/contracts/${id}/payment-plans`, { lines: [{
        amount_cents: Math.round((Number(data.amount_yuan) || 0) * 100),
        due_date: data.due_date,
        milestone_title: data.milestone_title,
      }] });
      toast('收款计划已新增');
      openContractDetail(id);
      loadContractsData();
    });
  });
}

async function renderSubscriptions(el) {
  try {
    const [list, metrics] = await Promise.all([API.get('/v1/sales/subscriptions'), API.get('/v1/sales/subscriptions/metrics')]);
    const SUB_STATUS = { trialing: '试用', active: '生效', paused: '暂停', churned: '流失' };
    el.innerHTML = `
      <div style="padding:16px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
        <div class="panel" style="padding:12px"><small style="color:var(--muted)">MRR</small><div style="font:600 20px var(--mono)">${money(metrics.mrr_cents)}</div></div>
        <div class="panel" style="padding:12px"><small style="color:var(--muted)">ARR（年化）</small><div style="font:600 20px var(--mono)">${money(metrics.arr_cents)}</div></div>
        <div class="panel" style="padding:12px"><small style="color:var(--muted)">活跃订阅 / 席位</small><div style="font:600 20px var(--mono)">${metrics.active_count} / ${metrics.active_seats}</div></div>
        <div class="panel" style="padding:12px"><small style="color:var(--muted)">流失率</small><div style="font:600 20px var(--mono)">${metrics.churn_rate_pct}%</div></div>
      </div>
      <div style="padding:12px 0"><button id="create-subscription" class="btn primary small">＋ 新建订阅</button></div>
      <div class="data-table-wrap">${simpleTable(['订阅编号', '客户 / 套餐', '席位', 'MRR', '续约日', '状态'], (list.items || []).map(s => [
        `<b>${esc(s.subscription_no)}</b>`, `${esc(s.account_name)}<br><small style="color:var(--muted)">${esc(s.plan_name)}</small>`,
        String(s.seats), money(s.mrr_cents), fmtDate(s.renewal_date), esc(SUB_STATUS[s.status] || s.status),
      ]))}</div>`;
    document.getElementById('create-subscription')?.addEventListener('click', () => {
      Modal.show('新建订阅', `
        <div class="form-row"><span>客户 <i class="req">*</i></span><select name="account_id" id="sub-account" required><option value="">加载客户中…</option></select></div>
        <div class="form-row"><span>套餐名称 <i class="req">*</i></span><input name="plan_name" required placeholder="如：专业版（年付）"></div>
        <div class="form-cols">
          <div class="form-row"><span>席位</span><input type="number" name="seats" min="1" value="10"></div>
          <div class="form-row"><span>月费 MRR（元）<i class="req">*</i></span><input type="number" name="mrr_yuan" min="0" required></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>计费周期</span><select name="billing_cycle"><option value="monthly">月付</option><option value="annual">年付</option></select></div>
          <div class="form-row"><span>开始日期</span><input type="date" name="start_date"></div>
        </div>
        <div class="form-row"><span>续约日</span><input type="date" name="renewal_date"></div>
      `, async (data) => {
        await API.post('/v1/sales/subscriptions', {
          account_id: data.account_id, plan_name: data.plan_name, seats: data.seats,
          billing_cycle: data.billing_cycle, mrr_cents: Math.round((Number(data.mrr_yuan) || 0) * 100),
          start_date: data.start_date, renewal_date: data.renewal_date,
        });
        toast('订阅已创建');
        loadContractsData();
      });
      API.get('/v1/crm/accounts?limit=200').then(({ items }) => {
        const sel = document.getElementById('sub-account');
        if (sel) sel.innerHTML = '<option value="">请选择客户</option>' + (items || []).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
      });
    });
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

let _devTab = 'requirements';
async function loadDevData() {
  const container = document.querySelector('#content .module-page');
  if (!container) return;
  const toolbar = container.querySelector('.table-toolbar');
  if (toolbar && !toolbar.querySelector('[data-dev-tab]')) {
    toolbar.innerHTML = `<div class="filter-tabs">
      <button class="${_devTab==='requirements'?'active':''}" data-dev-tab="requirements">需求池</button>
      <button class="${_devTab==='defects'?'active':''}" data-dev-tab="defects">缺陷跟踪</button>
      <button class="${_devTab==='iterations'?'active':''}" data-dev-tab="iterations">迭代 Sprint</button>
      <button class="${_devTab==='versions'?'active':''}" data-dev-tab="versions">版本发布</button>
    </div>`;
    toolbar.querySelectorAll('[data-dev-tab]').forEach(btn => btn.addEventListener('click', () => { _devTab = btn.dataset.devTab; loadDevData(); }));
  }
  // 顶部指标一次性取全，不依赖当前 Tab。
  Promise.allSettled([
    API.get('/v1/sw/requirements/stats'), API.get('/v1/sw/defects/stats'),
    API.get('/v1/sw/iterations'), API.get('/v1/sw/versions'),
  ]).then(([req, def, it, ver]) => {
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    if (stats[0] && req.status === 'fulfilled') {
      const by = Object.fromEntries((req.value.by_status || []).map(r => [r.status, Number(r.count)]));
      stats[0].textContent = String((by.new || 0) + (by.triaged || 0));
    }
    if (stats[1] && def.status === 'fulfilled') {
      stats[1].textContent = String((def.value.by_status || []).filter(r => !['closed', 'rejected'].includes(r.status)).reduce((s, r) => s + Number(r.count), 0));
    }
    if (stats[2] && it.status === 'fulfilled') stats[2].textContent = String((it.value.items || []).filter(i => i.status === 'active').length);
    if (stats[3] && ver.status === 'fulfilled') {
      stats[3].textContent = String((ver.value.items || []).filter(v => v.status === 'released' && v.released_at && Date.now() - new Date(v.released_at).getTime() < 30 * 86400000).length);
    }
  }).catch(() => {});
  const devActionLabels = { requirements: '提需求', defects: '提缺陷', iterations: '新建迭代', versions: '新建版本' };
  const devCreateBtn = container.querySelector('.module-create');
  if (devCreateBtn) devCreateBtn.textContent = `＋ ${devActionLabels[_devTab] || '新建'}`;
  const table = container.querySelector('.data-table-wrap');
  if (!table) return;
  if (_devTab === 'requirements') await renderRequirements(table);
  else if (_devTab === 'defects') await renderDefects(table);
  else if (_devTab === 'iterations') await renderIterations(table);
  else await renderVersions(table);
}

const REQ_STATUS = { new: '新需求', triaged: '已分办', queued: '已排队', doing: '进行中', done: '完成', rejected: '已拒绝' };
const DEFECT_STATUS = { new: '新建', confirmed: '已确认', in_progress: '修复中', fixed: '已修复', verified: '已验证', closed: '已关闭', rejected: '非缺陷' };
const SEVERITY = { blocker: '致命', critical: '严重', major: '一般', minor: '轻微', trivial: '微弱' };

async function renderRequirements(el) {
  try {
    const [list, stats] = await Promise.all([API.get('/v1/sw/requirements'), API.get('/v1/sw/requirements/stats').catch(()=>null)]);
    const cards = document.querySelectorAll('.module-metrics .metric-card strong');
    const byStatus = Object.fromEntries((stats?.by_status || []).map(r => [r.status, r.count]));
    if (cards[0]) cards[0].textContent = String((byStatus.new ?? 0) + (byStatus.triaged ?? 0));
    el.innerHTML = simpleTable(['编号', '标题 / 来源', '优先级', '故事点', '负责人', '状态'], (list.items || []).map(r => [
      `<b>${esc(r.code)}</b>`, `${esc(r.title)}<br><small style="color:var(--muted)">${esc(r.source)}${r.project_name ? ' · ' + esc(r.project_name) : ''}</small>`,
      esc(r.priority), r.story_points != null ? String(r.story_points) : '—', esc(r.owner_name || '—'), esc(REQ_STATUS[r.status] || r.status),
    ]));
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

async function renderDefects(el) {
  try {
    const [list, stats] = await Promise.all([API.get('/v1/sw/defects'), API.get('/v1/sw/defects/stats').catch(()=>null)]);
    const cards = document.querySelectorAll('.module-metrics .metric-card strong');
    const open = (stats?.by_status || []).filter(r => !['closed','rejected'].includes(r.status)).reduce((s,r)=>s+r.count,0);
    if (cards[1]) cards[1].textContent = String(open);
    el.innerHTML = simpleTable(['编号', '标题 / 环境', '严重级别', '指派给', '状态', '关联版本'], (list.items || []).map(d => [
      `<b>${esc(d.code)}</b>`, `${esc(d.title)}${d.environment ? `<br><small style="color:var(--muted)">${esc(d.environment)}</small>` : ''}`,
      esc(SEVERITY[d.severity] || d.severity), esc(d.assignee_name || '—'), esc(DEFECT_STATUS[d.status] || d.status),
      `${d.found_in_version_id ? '发现' : '—'} / ${d.fixed_in_version_id ? '修复' : '—'}`,
    ]));
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

async function renderIterations(el) {
  try {
    const list = await API.get('/v1/sw/iterations');
    const IT_STATUS = { planned: '计划中', active: '进行中', completed: '已完成', cancelled: '已取消' };
    const cards = document.querySelectorAll('.module-metrics .metric-card strong');
    const active = (list.items || []).filter(i => i.status === 'active').length;
    if (cards[2]) cards[2].textContent = String(active);
    el.innerHTML = simpleTable(['迭代', '项目 / 目标', '容量点', '完成点', '起止', '状态', '看板'], (list.items || []).map(i => [
      `<b>${esc(i.name)}</b>`, `${esc(i.project_name || '')}${i.goal ? `<br><small style="color:var(--muted)">${esc(i.goal)}</small>` : ''}`,
      String(i.capacity_points), `${i.done_points ?? 0} / ${i.total_points ?? 0}`,
      `${fmtDate(i.start_date)} ~ ${fmtDate(i.end_date)}`, esc(IT_STATUS[i.status] || i.status),
      `<button data-board="${esc(i.id)}" style="font-size:9px;color:var(--blue);background:none;border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer">看板</button>`,
    ]));
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

async function renderVersions(el) {
  try {
    const list = await API.get('/v1/sw/versions');
    const V_STATUS = { planned: '计划中', releasing: '发布中', released: '已发布', rolled_back: '已回滚' };
    const cards = document.querySelectorAll('.module-metrics .metric-card strong');
    const released30 = (list.items || []).filter(v => v.status === 'released' && v.released_at && Date.now() - new Date(v.released_at) < 30*86400000).length;
    if (cards[3]) cards[3].textContent = String(released30);
    el.innerHTML = simpleTable(['版本号', '项目 / 迭代', '状态', '发布时间', '发布说明'], (list.items || []).map(v => [
      `<b>${esc(v.version_number)}</b>`, `${esc(v.project_name || '')}${v.iteration_name ? ' · ' + esc(v.iteration_name) : ''}`,
      esc(V_STATUS[v.status] || v.status), v.released_at ? ago(v.released_at) : '—', esc((v.release_notes || '—').slice(0, 60)),
    ]));
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}


// ═══ 我的工作台（docs/17 岗位细节）：岗位聚合 + 快捷入口 ═══
async function loadWorkbenchData() {
  const wrap = document.querySelector('#workbench-content');
  if (!wrap) return;
  wrap.innerHTML = `<p class="loading-text" style="padding:20px">正在装配你的岗位工作台…</p>`;
  // 团队数据与工作台并行取，避免先等 workbench 再串行等 teams。
  const teamPromise = API.get('/v1/teams/my').catch(() => null);
  let wb;
  try { wb = await API.get('/v1/workbench'); }
  catch (e) { wrap.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; return; }
  const stats = document.querySelectorAll('.module-metrics .metric-card strong');
  const annual = (wb.cards?.my_leave_balances || []).find(b => b.leave_type === 'annual');
  if (stats[0]) stats[0].textContent = String(wb.cards?.approvals_waiting_me ?? 0);
  if (stats[1]) stats[1].textContent = String((wb.cards?.my_tasks?.list || []).length);
  if (stats[2]) stats[2].textContent = String(wb.cards?.my_tasks?.due_this_week ?? 0);
  if (stats[3]) stats[3].textContent = wb.cards?.attendance_today?.check_in ? (wb.cards.attendance_today.check_out ? '已打上下班' : '已上班') : '未打卡';

  const p = wb.person || {};
  const persona = p.demo_persona;
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-bottom:1px solid var(--line-soft)"><span style="color:var(--muted)">${esc(k)}</span><b>${v}</b></div>`;
  const card = (title, inner, jump) => `<div class="panel" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px"><span></span>${esc(title)}</div>${inner}${jump ? `<button data-view-jump="${jump}" style="margin-top:10px;font-size:9px;color:var(--blue);background:none;border:0;cursor:pointer;padding:0">前往处理 →</button>` : ''}</div>`;
  const cols = [];

  cols.push(`<div class="panel" style="padding:16px;grid-column:1/-1"><div style="display:flex;gap:12px;align-items:center">
    <div style="width:42px;height:42px;border-radius:10px;display:grid;place-items:center;font-size:16px;color:#fff;background:var(--blue)">${esc((p.name || '?').slice(0,1))}</div>
    <div style="flex:1"><b style="font-size:13px">${esc(p.name || '')}</b> <span style="font-size:9px;color:var(--muted)">${esc((p.role_labels || []).join(' / ')) || '—'}</span>
    <div style="font-size:9px;color:var(--muted)">${esc(p.org || '')}${persona ? ' · ' + esc(persona.title) : ''}</div>
    ${persona ? `<p style="margin-top:6px;font-size:9px;color:var(--muted);line-height:1.5">${esc(persona.duty)}</p>` : ''}</div>
    <div>${row('年假余额', annual ? (Number(annual.remaining_days) + ' 天') : '未配置')}${row('待审报销', money(wb.cards?.my_expenses?.pending_cents))}</div>
  </div></div>`);

  const tasks = wb.cards?.my_tasks?.list || [];
  cols.push(card('我的任务（' + tasks.length + '）', tasks.length
    ? tasks.map(t => `<div style="padding:6px 0;border-bottom:1px solid var(--line-soft)"><b style="font-size:10px">${esc(t.title)}</b><div style="font-size:9px;color:var(--muted)">${esc(t.project_name || '')} · ${esc({ todo: '待开始', in_progress: '进行中', done: '已完成', blocked: '阻塞', cancelled: '已取消' }[t.status] || t.status)}${t.due_date ? ' · 截止 ' + fmtDate(t.due_date) : ''}</div></div>`).join('')
    : '<p style="font-size:10px;color:var(--muted)">暂无开放任务</p>', 'projects'));

  if (wb.sections?.manager) {
    const m = wb.sections.manager;
    cols.push(card('待我审批（' + (m.pending_approvals || []).length + '）', (m.pending_approvals || []).length
      ? m.pending_approvals.map(a => `<div style="padding:6px 0;border-bottom:1px solid var(--line-soft)"><b style="font-size:10px">${esc(a.title)}</b><div style="font-size:9px;color:var(--muted)">${esc(a.requester_name || '')} · ${esc(a.resource_type)}</div></div>`).join('')
      : '<p style="font-size:10px;color:var(--muted)">没有待审批事项</p>', 'approvals'));
    cols.push(card('管理与团队', [
      ['团队开放任务', String(m.team_open_tasks ?? 0)],
      ['30 天内里程碑', String((m.milestones_due_30d || []).length)],
    ].map(([k, v]) => row(k, v)).join('') +
      ((m.milestones_due_30d || []).slice(0, 3).map(x => `<div style="font-size:9px;color:var(--muted);padding:3px 0">· ${esc(x.name)}（${esc(x.project_name || '')}，${fmtDate(x.due_date)}）</div>`).join('')), 'projects'));
    // 团队成员 → 个人全景（docs/19）
    try {
      const tm = await teamPromise;
      if (tm?.members?.length) {
        cols.push(card(`我的团队（${tm.members.length}）`, tm.members.map(mem =>
          `<button data-panorama="${esc(mem.person_id)}" style="width:100%;text-align:left;padding:6px 0;background:none;border:0;border-bottom:1px solid var(--line-soft);cursor:pointer">
            <b style="font-size:10px">${esc(mem.display_name)}</b>
            <span style="font-size:9px;color:var(--muted);margin-left:6px">在途 ${mem.open_tasks} · 完成 ${mem.done_30d} · 缺陷 ${mem.open_defects}</span>
            <span style="float:right;font-size:9px;color:var(--blue)">全景 →</span></button>`).join('')));
      }
    } catch {}
  }

  if (wb.sections?.finance) {
    const f = wb.sections.finance;
    cols.push(card('财务细节', [
      ['应收未结', money(f.ar_outstanding_cents)],
      ['其中 90 天以上', money(f.ar_over_90_cents)],
      ['未收发票', String(f.unpaid_receivable_invoices)],
      ['预算超支数', String(f.over_budget_count ?? 0)],
    ].map(([k, v]) => row(k, v)).join('') +
      (f.over_budget_count > 0 ? '<div style="font-size:9px;color:var(--red);padding-top:6px">⚠ 存在超支预算，请前往财务管理查看</div>' : ''), 'finance'));
  }

  if (wb.sections?.hr) {
    const h = wb.sections.hr;
    cols.push(card('人事细节', [
      ['开放招聘', String(h.open_requisitions)],
      ['活跃候选人', String(h.active_candidates)],
      ['待完成绩效', String(h.open_reviews)],
      ['60 天内转正', String((h.probation_due || []).length)],
    ].map(([k, v]) => row(k, v)).join('') +
      ((h.probation_due || []).slice(0, 3).map(x => `<div style="font-size:9px;color:var(--muted);padding:3px 0">· ${esc(x.display_name)}（${esc(x.org_name || '')}）${fmtDate(x.probation_end)} 转正</div>`).join('')), 'hr'));
  }

  if (wb.sections?.it) {
    const it = wb.sections.it;
    cols.push(card('IT 细节', [
      ['60 天内到期许可', String((it.licenses_expiring_60d || []).length)],
      ['超 48h 未决工单', String(it.tickets_aging_48h)],
    ].map(([k, v]) => row(k, v)).join('') +
      ((it.licenses_expiring_60d || []).slice(0, 3).map(l => `<div style="font-size:9px;color:var(--muted);padding:3px 0">· ${esc(l.software_name)} ${fmtDate(l.expiry_date)} 到期</div>`).join('')), 'it'));
  }

  if (wb.sections?.production) {
    const pr = wb.sections.production;
    cols.push(card('生产细节', (pr.open_work_orders || []).length
      ? pr.open_work_orders.map(w => `<div style="padding:5px 0;border-bottom:1px solid var(--line-soft)"><b style="font-size:10px">${esc(w.wo_number)}</b><div style="font-size:9px;color:var(--muted)">${Number(w.completed_qty)}/${Number(w.planned_qty)} · 计划完成 ${fmtDate(w.planned_finish)}</div></div>`).join('')
      : '<p style="font-size:10px;color:var(--muted)">当前没有未结工单</p>', 'projects'));
  }
  if (wb.sections?.purchase) {
    const pu = wb.sections.purchase;
    cols.push(card('采购细节', (pu.my_requisitions || []).length
      ? pu.my_requisitions.map(r => `<div style="padding:5px 0;border-bottom:1px solid var(--line-soft)"><b style="font-size:10px">${esc(r.pr_number)}</b><div style="font-size:9px;color:var(--muted)">${esc(r.status)} · ${money(r.total_amount_cents)}</div></div>`).join('')
      : '<p style="font-size:10px;color:var(--muted)">没有进行中的采购单</p>'));
  }
  if (wb.sections?.quality) {
    const q = wb.sections.quality;
    cols.push(card('质量细节', (q.open_ncrs || []).length
      ? q.open_ncrs.map(n => `<div style="padding:5px 0;border-bottom:1px solid var(--line-soft)"><b style="font-size:10px">${esc(n.ncr_number)}</b><div style="font-size:9px;color:var(--muted)">${esc(n.status)} · 数量 ${Number(n.quantity)}</div></div>`).join('')
      : '<p style="font-size:10px;color:var(--muted)">没有未结不合格处置</p>'));
  }

  if (wb.sections?.sales) {
    const sa = wb.sections.sales;
    cols.push(card('销售细节', [
      ['我的销售漏斗', money(sa.pipeline_cents)],
      ['停滞商机（14 天无跟进）', String((sa.stale_opportunities || []).length)],
    ].map(([k, v]) => row(k, v)).join('') +
      ((sa.stale_opportunities || []).slice(0, 3).map(o => `<div style="font-size:9px;color:var(--muted);padding:3px 0">⚠ ${esc(o.name)}（${esc(o.customer_name)}）${money(o.amount_cents)}</div>`).join('')), 'crm'));
  }

  if (wb.sections?.rnd) {
    const rd = wb.sections.rnd;
    cols.push(card('研发细节', [
      ['我的未结缺陷', String(rd.my_open_defects)],
      ['需求池待分办', String(rd.backlog_requirements)],
    ].map(([k, v]) => row(k, v)).join('') +
      ((rd.active_iterations || []).map(i => `<div style="font-size:9px;color:var(--muted);padding:3px 0">⚡ ${esc(i.name)}（${esc(i.project_name)}）完成点 ${Number(i.done_points)}/${Number(i.total_points)}</div>`).join('')), 'dev'));
  }

  // 考勤月历（docs/18）：当月逐日状态 + 补卡
  let cal = null;
  try { cal = await API.get('/v1/hr/attendance/calendar'); } catch {}
  if (cal) {
    const dot = st => ({ present: '#2da27a', makeup: '#1f6feb', missing: '#e5534b', weekend: '#c9c9c9' }[st] || '#ccc');
    const cells = cal.days.map(d => `<div title="${d.date} ${d.status}" style="height:22px;border-radius:5px;background:${dot(d.status)};opacity:${d.status==='weekend'?0.35:0.9}"></div>`).join('');
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    cols.push(card(`考勤月历（${cal.month} 月 · 出勤 ${cal.present} 补卡 ${cal.makeup}）`,
      `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">${cells}</div>
       <div style="margin-top:8px;font-size:9px;color:var(--muted)">绿=出勤 蓝=补卡 红=缺卡 灰=周末</div>
       <button data-makeup="${yest}" style="margin-top:8px;font-size:9px;color:var(--blue);background:none;border:1px solid var(--line);border-radius:6px;padding:4px 8px;cursor:pointer">补卡（默认昨日，可改）</button>`));
  }
  // 库存安全库存预警（docs/18，生产视角）
  if (wb.sections?.production) {
    try {
      const sa = await API.get('/v1/stock/alerts');
      if (sa.items?.length) {
        cols.push(card(`库存预警（${sa.items.length}）`, sa.items.slice(0, 6).map(x =>
          `<div style="padding:5px 0;border-bottom:1px solid var(--line-soft)"><b style="font-size:10px">${esc(x.part_number)}</b>
           <div style="font-size:9px;color:var(--red)">可用 ${Number(x.available)} / 安全 ${Number(x.safety_stock)} ${esc(x.uom || '')}（缺 ${Number(x.gap)}）</div></div>`).join('') +
          '<div style="font-size:9px;color:var(--muted);margin-top:6px">worker 每日扫描并推送采购提醒</div>'));
      }
    } catch {}
  }
  wrap.innerHTML = `<div style="padding:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px">${cols.join('')}</div>
    <p style="padding:0 20px 16px;font-size:9px;color:var(--muted)">生成于 ${esc(wb.generated_at || '')} · 区块随你的角色/岗位自动变化 · 演示模式可从右上角「切换岗位」体验其他视角</p>`;
}

// ── docs/18 交互：看板拖拽 / 一键核销 / 模板建合同 / 补卡 ──
let kanbanModal = null;
async function openKanbanBoard(iterationId) {
  if (!kanbanModal) {
    kanbanModal = document.createElement('div');
    kanbanModal.className = 'demo-modal kanban-modal';
    kanbanModal.innerHTML = `<button class="demo-modal-backdrop" aria-label="关闭"></button>
      <section role="dialog" aria-modal="true" aria-label="迭代看板" style="max-width:860px">
      <header><div><small>SPRINT BOARD</small><h2 id="kanban-title">迭代看板</h2></div>
      <button class="kanban-close" type="button" aria-label="关闭" style="background:none;border:0;font-size:18px;cursor:pointer;color:var(--muted)">×</button></header>
      <div class="kanban-wrap" style="padding:0 18px 18px"></div></section>`;
    document.body.append(kanbanModal);
    kanbanModal.addEventListener('click', e => { if (e.target.closest('.demo-modal-backdrop,.kanban-close')) kanbanModal.classList.remove('open'); });
  }
  kanbanModal.classList.add('open');
  const wrap = kanbanModal.querySelector('.kanban-wrap');
  wrap.innerHTML = '<p class="loading-text" style="padding:20px">加载看板…</p>';
  let board;
  try { board = await API.get(`/v1/sw/iterations/${iterationId}/board`); }
  catch (e) { wrap.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; return; }
  kanbanModal.querySelector('#kanban-title').textContent = (board.iteration?.name || '迭代') + ' · ' + (board.total || 0) + ' 个任务';
  const COLS = [['todo', '待办'], ['in_progress', '进行中'], ['done', '完成']];
  wrap.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">` + COLS.map(([key, label]) => `
    <div class="kanban-col" data-col="${key}" style="background:var(--line-soft);border-radius:10px;padding:10px;min-height:220px">
      <b style="font-size:10px;display:block;margin-bottom:8px">${label}（${(board.board[key] || []).length}）</b>
      ${(board.board[key] || []).map(t => `
        <div draggable="true" data-task="${esc(t.id)}" style="background:#fff;border-radius:8px;padding:8px;margin-bottom:8px;cursor:grab;box-shadow:0 1px 3px rgba(0,0,0,.08)">
          <b style="font-size:10px">${esc(t.title)}</b>
          <div style="font-size:9px;color:var(--muted)">${esc(t.priority || '')}${t.story_points ? ' · ' + t.story_points + ' 点' : ''}${t.assignee_name ? ' · ' + esc(t.assignee_name) : ''}</div>
        </div>`).join('')}
    </div>`).join('') + `</div>
    <p style="font-size:9px;color:var(--muted);margin:10px 0 0">拖拽卡片换列 = 更新任务状态（保存到服务端）</p>`;
  wrap.querySelectorAll('[draggable]').forEach(cardEl => {
    cardEl.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', cardEl.dataset.task); });
  });
  wrap.querySelectorAll('.kanban-col').forEach(colEl => {
    colEl.addEventListener('dragover', e => e.preventDefault());
    colEl.addEventListener('drop', async e => {
      e.preventDefault();
      const taskId = e.dataTransfer.getData('text/plain');
      const status = colEl.dataset.col;
      try {
        await API.patch(`/v1/tasks/${taskId}`, { status });
        showToast('已更新：' + status);
        openKanbanBoard(iterationId);
      } catch (err) { showToast('更新失败：' + err.message, 'error'); }
    });
  });
}

document.addEventListener('click', async event => {
  if (event.target.closest('[data-barcode-scan]')) { openBarcodeScan(); return; }
  const indBtn = event.target.closest('[data-ind]');
  if (indBtn) {
    indBtn.disabled = true;
    await handleIndustryAction(indBtn.dataset.ind, indBtn.dataset.indId, indBtn.dataset.indAction);
    indBtn.disabled = false;
    return;
  }
  const approvalRow = event.target.closest('[data-approval-id]');
  if (approvalRow && !event.target.closest('button')) { openApprovalDetail(approvalRow.dataset.approvalId); return; }
  const contractBtn = event.target.closest('[data-contract-id]');
  if (contractBtn) { openContractDetail(contractBtn.dataset.contractId); return; }
  const finBtn = event.target.closest('[data-fin-kind]');
  if (finBtn) { openFinanceDetail(finBtn.dataset.finKind, finBtn.dataset.finIdx); return; }
  const boardBtn = event.target.closest('[data-board]');
  if (boardBtn) { openKanbanBoard(boardBtn.dataset.board); return; }
  const woBtn = event.target.closest('[data-writeoff]');
  if (woBtn) {
    woBtn.disabled = true; woBtn.textContent = '核销中…';
    try {
      const r = await API.post(`/v1/finance/invoices/${woBtn.dataset.writeoff}/auto-writeoff`, {});
      showToast(`已核销 ${money(r.applied_cents)}（${(r.allocations || []).length} 笔收款冲抵）`);
      const tab = document.querySelector('[data-fin-tab="invoices"]');
      if (tab) tab.click(); else renderInvoices(document.querySelector('.data-table-wrap'));
    } catch (e) {
      showToast(e.status === 409 ? '没有可用的已收款项进行核销' : '核销失败：' + e.message, 'error');
      woBtn.disabled = false; woBtn.textContent = '一键核销';
    }
    return;
  }
  const tplBtn = event.target.closest('[data-tpl-create]');
  if (tplBtn) {
    try {
      const [{ items: templates }, { items: accounts }] = await Promise.all([
        API.get('/v1/sales/contract-templates'),
        API.get('/v1/crm/accounts?limit=200'),
      ]);
      if (!templates?.length) { showToast('暂无合同模板，请管理员先在系统内创建', 'error'); return; }
      Modal.show('从模板起草合同', `
        <div class="form-row"><span>合同模板 <i class="req">*</i></span><select name="template_id" required>
          ${templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}（${esc(t.contract_type)}${t.clause_count ? ' · ' + t.clause_count + ' 条款' : ''}）</option>`).join('')}
        </select></div>
        <div class="form-row"><span>客户 <i class="req">*</i></span><select name="account_id" required>
          <option value="">请选择客户</option>${(accounts || []).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}
        </select></div>
        <div class="form-row"><span>合同标题 <i class="req">*</i></span><input name="title" required placeholder="例如：华驰年框供货合同"></div>
        <div class="form-row"><span>合同金额（元）<i class="req">*</i></span><input type="number" name="amount_yuan" min="0" required placeholder="100000"></div>
        <p style="font-size:9px;color:var(--muted)">提交后会按模板条款生成快照，后续模板修改不影响已起草合同。</p>
      `, async (data) => {
        const r = await API.post('/v1/sales/contracts/from-template', {
          template_id: data.template_id, account_id: data.account_id,
          title: data.title, amount_cents: Math.round((Number(data.amount_yuan) || 0) * 100),
        });
        showToast(`已起草 ${r.contract.contract_no}（快照 ${r.clauses_snapshotted} 条条款）`);
        const tab = document.querySelector('[data-con-tab="contracts"]');
        if (tab) tab.click();
      });
    } catch (e) { showToast('创建失败：' + e.message, 'error'); }
    return;
  }
  const makeupBtn = event.target.closest('[data-makeup]');
  if (makeupBtn) {
    Modal.show('补卡申请', `
      <div class="form-row"><span>补卡日期 <i class="req">*</i></span><input type="date" name="date" required value="${esc(makeupBtn.dataset.makeup || '')}"></div>
      <div class="form-row"><span>补卡原因</span><input name="reason" placeholder="忘记打卡 / 外出拜访"></div>
      <p style="font-size:9px;color:var(--muted)">提交后会通知 HR 审核。</p>
    `, async (data) => {
      await API.post('/v1/hr/attendance/makeup', { date: data.date, reason: data.reason || '' });
      showToast('补卡成功（已通知 HR）');
      loadWorkbenchData();
    });
  }
});

// ── 管理设置：最近操作审计（仅管理员可见）──
async function loadAuditData() {
  const panel = document.querySelector('#audit-panel .audit-list');
  if (!panel) return;
  panel.innerHTML = '<p class="loading-text" style="padding:12px">加载中…</p>';
  try {
    const res = await fetch('/v1/audit/events?limit=30', { credentials: 'same-origin' });
    if (res.status === 403) { panel.innerHTML = '<p style="padding:12px;font-size:10px;color:var(--muted)">仅企业管理员可查看审计日志。</p>'; return; }
    if (!res.ok) throw new Error('audit_unavailable');
    const data = await res.json();
    const items = data.items || [];
    panel.innerHTML = items.length ? `<table class="data-table audit-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th></tr></thead><tbody>${items.map(e => `
      <tr><td>${new Date(e.occurred_at).toLocaleString('zh-CN')}</td><td>${esc(e.actor_name || String(e.actor_id || '').slice(0, 24))}</td>
      <td>${esc(e.action)}</td><td>${esc(e.resource_type || '')} ${esc(String(e.resource_id || '').slice(0, 8))}</td>
      <td><span class="badge ${e.outcome === 'success' ? 'good' : 'bad'}">${esc(e.outcome)}</span></td></tr>`).join('')}</tbody></table>`
      : '<p style="padding:12px;font-size:10px;color:var(--muted)">暂无审计记录。</p>';
  } catch {
    panel.innerHTML = '<p style="padding:12px;font-size:10px;color:var(--muted)">审计日志暂时不可用（需要至少一个管理员操作）。</p>';
  }
}

function openBarcodeScan() {
  Modal.show('扫码定位物料', `
    <p style="font-size:10px;color:var(--muted);margin-bottom:10px">用扫码枪扫描条码（回车提交），或手动输入料号/名称片段。</p>
    <div class="form-row"><span>条码 / 料号 <i class="req">*</i></span><input name="code" required autofocus placeholder="如 CNC-BRKT-014"></div>
  `, async (data) => {
    const code = String(data.code || '').trim().toLowerCase();
    const { items } = await API.get('/v1/mfg/parts?limit=200');
    const hit = (items || []).find(p => String(p.part_number || '').toLowerCase() === code)
      || (items || []).find(p => String(p.part_number || '').toLowerCase().includes(code) || String(p.name || '').toLowerCase().includes(code));
    if (!hit) throw new Error('未找到匹配物料');
    toast(`${hit.part_number} · ${hit.name}｜安全库存 ${hit.safety_stock ?? 0} ${hit.uom || ''}`);
  });
}

function ensureIndustryTabs(container, prefix, tabs, active, onSwitch) {
  const toolbar = container.querySelector('.table-toolbar');
  if (!toolbar) return;
  if (!toolbar.querySelector(`[data-${prefix}-tab]`)) {
    toolbar.innerHTML = `<div class="filter-tabs">${tabs.map(([k, v]) => `<button class="${k === active ? 'active' : ''}" data-${prefix}-tab="${k}">${v}</button>`).join('')}</div>`;
    toolbar.querySelectorAll(`[data-${prefix}-tab]`).forEach(btn =>
      btn.addEventListener('click', () => onSwitch(btn.dataset[`${prefix}Tab`] || btn.getAttribute(`data-${prefix}-tab`))));
  } else {
    toolbar.querySelectorAll(`[data-${prefix}-tab]`).forEach(btn => {
      const key = btn.getAttribute(`data-${prefix}-tab`);
      btn.classList.toggle('active', key === active);
    });
  }
}

const WO_STATUS = { created: '待下达', planned: '计划中', released: '已下达', in_progress: '生产中', completed: '已完工', cancelled: '已取消' };

function industryBtn(kind, id, action, label, style = 'ghost') {
  return `<button class="btn ${style} small" type="button" data-ind="${esc(kind)}" data-ind-id="${esc(id)}" data-ind-action="${esc(action)}">${label}</button>`;
}

async function handleIndustryAction(kind, id, action) {
  try {
    if (kind === 'wo') {
      if (action === 'release') await API.post(`/v1/mfg/work-orders/${id}/release`, {});
      else if (action === 'report') {
        Modal.show('工单报工', `
          <div class="form-cols">
            <div class="form-row"><span>良品数量 <i class="req">*</i></span><input type="number" name="qty_good" min="0" value="10" required></div>
            <div class="form-row"><span>报废数量</span><input type="number" name="qty_scrap" min="0" value="0"></div>
          </div>
          <div class="form-row"><span>工时（小时）</span><input type="number" name="hours_logged" min="0" step="0.5" value="0"></div>
          <div class="form-row"><span>备注</span><input name="note" placeholder="班次 / 异常说明"></div>
        `, async (data) => {
          await API.post(`/v1/mfg/work-orders/${id}/report`, {
            qty_good: Number(data.qty_good) || 0, qty_scrap: Number(data.qty_scrap) || 0,
            hours_logged: Number(data.hours_logged) || 0, note: data.note || null,
          });
          toast('报工已提交');
          loadManufacturingData();
        });
        return;
      } else if (action === 'complete') await API.post(`/v1/mfg/work-orders/${id}/complete`, {});
      toast('工单已更新'); loadManufacturingData(); return;
    }
    if (kind === 'po') {
      await API.post(`/v1/purchase/orders/${id}/approve`, {});
      toast('采购订单已审批'); loadSupplychainData(); return;
    }
    if (kind === 'qms') {
      await API.post(`/v1/qms/inspections/${id}/verdict`, { result: action });
      toast(action === 'pass' ? '已判定合格' : '已判定不合格'); loadQualityData(); return;
    }
    if (kind === 'so') {
      await API.post(`/v1/sales/orders/${id}/confirm`, {});
      toast('销售订单已确认'); loadSalesData(); return;
    }
  } catch (e) { toast(e.message, 'error'); }
}
let _mfgTab = 'workorders';
async function loadManufacturingData() {
  const container = document.querySelector('#content .module-page');
  const el = document.getElementById('manufacturing-content');
  if (!container || !el) return;
  ensureIndustryTabs(container, 'mfg', [['workorders', '生产工单'], ['parts', '物料与 BOM'], ['kpi', '制造 KPI']], _mfgTab, (tab) => { _mfgTab = tab || 'workorders'; loadManufacturingData(); });
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const [wo, parts, kpi] = await Promise.all([
      API.get('/v1/mfg/work-orders?limit=100'),
      API.get('/v1/mfg/parts?limit=100'),
      API.get('/v1/mfg/kpis').catch(() => null),
    ]);
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    const open = (wo.items || []).filter(w => !['completed','cancelled'].includes(w.status));
    if (stats[0]) stats[0].textContent = String(open.length);
    if (stats[1] && kpi?.wip) stats[1].textContent = Number(kpi.wip.wip_qty || 0).toLocaleString('zh-CN');
    if (stats[2]) stats[2].textContent = kpi?.quality_yield_pct != null ? `${kpi.quality_yield_pct}%` : '0%';
    if (stats[3]) stats[3].textContent = kpi?.otd_pct != null ? `${kpi.otd_pct}%` : '0%';
    if (_mfgTab === 'parts') {
      const tools = `<div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 0">
        <button class="btn ghost small" type="button" data-import-template="parts">下载物料模板</button>
        <button class="btn ghost small" type="button" data-import="parts">批量导入物料</button>
        <button class="btn ghost small" type="button" data-barcode-scan>扫码定位物料</button>
      </div>`;
      el.innerHTML = tools + simpleTable(['料号', '名称', '类型', '单位', '安全库存', '规格'], (parts.items || []).map(p => [
        `<b>${esc(p.part_number)}</b>`, esc(p.name), esc(p.kind), esc(p.uom),
        Number(p.safety_stock || 0).toLocaleString('zh-CN'), esc(p.spec || '—'),
      ]));
    } else if (_mfgTab === 'kpi') {
      const k = kpi || {};
      const row = (label, value) => `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-soft)"><span style="color:var(--muted)">${esc(label)}</span><b>${value}</b></div>`;
      el.innerHTML = `<div style="padding:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
        <div class="panel" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px"><span></span>质量与交付</div>
          ${row('质量良率', k.quality_yield_pct != null ? `${k.quality_yield_pct}%` : '—')}
          ${row('准交率 OTD', k.otd_pct != null ? `${k.otd_pct}%` : '—')}
          ${row('设备可用率', k.equipment_availability_pct != null ? `${k.equipment_availability_pct}%` : '—')}
        </div>
        <div class="panel" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px"><span></span>在制与周转</div>
          ${row('未结工单', String(k.wip?.open_orders ?? 0))}
          ${row('在制数量', Number(k.wip?.wip_qty || 0).toLocaleString('zh-CN'))}
          ${row('90 天库存周转', k.inventory_turnover_90d ?? '—')}
        </div></div>`;
    } else {
      el.innerHTML = (wo.items || []).length ? simpleTable(['工单号', '产品', '计划 / 完成', '状态', '计划完成', '操作'], (wo.items || []).map(w => {
        const actions = w.status === 'created' || w.status === 'planned'
          ? industryBtn('wo', w.id, 'release', '下达')
          : ['released', 'in_progress'].includes(w.status)
            ? industryBtn('wo', w.id, 'report', '报工') + ' ' + industryBtn('wo', w.id, 'complete', '完工')
            : '—';
        return [
          `<b>${esc(w.wo_number)}</b>`, esc(w.product_name || w.product_part_id || '—'),
          `${Number(w.planned_qty || 0)} / ${Number(w.completed_qty || 0)}`,
          `<span class="status-pill ${w.status === 'completed' ? '' : w.status === 'released' ? 'warning' : ''}">${esc(WO_STATUS[w.status] || w.status)}</span>`, fmtDate(w.planned_finish), actions,
        ];
      })) : '<div style="padding:24px"><p class="empty-hint">暂无生产工单。制造模块的演示数据在「切换公司 → 恒精制造」中。</p></div>';
    }
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

let _scTab = 'orders';
async function loadSupplychainData() {
  const container = document.querySelector('#content .module-page');
  const el = document.getElementById('supplychain-content');
  if (!container || !el) return;
  ensureIndustryTabs(container, 'sc', [['orders', '采购订单'], ['requisitions', '请购单'], ['suppliers', '供应商'], ['stock', '库存']], _scTab, (tab) => { _scTab = tab || 'orders'; loadSupplychainData(); });
  const scCreateBtn = container.querySelector('.module-create');
  if (scCreateBtn) scCreateBtn.textContent = `＋ ${_scTab === 'requisitions' ? '新建请购' : '新建采购单'}`;
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const [po, pr, sup, stock] = await Promise.all([
      API.get('/v1/purchase/orders?limit=100'),
      API.get('/v1/purchase/requisitions?limit=100'),
      API.get('/v1/purchase/suppliers?limit=100'),
      API.get('/v1/stock/onhand?limit=100').catch(() => ({ items: [] })),
    ]);
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    if (stats[0]) stats[0].textContent = String((pr.items || []).filter(r => r.status === 'submitted').length);
    if (stats[1]) stats[1].textContent = String((po.items || []).filter(p => !['received','closed','cancelled'].includes(p.status)).length);
    if (stats[2]) stats[2].textContent = String((sup.items || []).length);
    if (stats[3]) stats[3].textContent = String((stock.items || []).filter(s => Number(s.available) < Number(s.safety_stock)).length);
    if (_scTab === 'requisitions') {
      el.innerHTML = (pr.items || []).length ? simpleTable(['PR 号', '申请人', '金额', '状态', '需求日期'], (pr.items || []).map(r => [
        `<b>${esc(r.pr_number)}</b>`, esc(r.requester_name || '—'), money(r.total_amount_cents),
        esc(r.status), fmtDate(r.need_date),
      ])) : '<div style="padding:24px"><p class="empty-hint">暂无请购单。</p></div>';
    } else if (_scTab === 'suppliers') {
      el.innerHTML = simpleTable(['供应商', '编码', '联系人', '电话', '状态'], (sup.items || []).map(s => [
        `<b>${esc(s.name)}</b>`, esc(s.supplier_code || '—'), esc(s.contact_person || '—'),
        esc(s.contact_phone || '—'), esc(s.status || 'active'),
      ]));
    } else if (_scTab === 'stock') {
      el.innerHTML = (stock.items || []).length ? simpleTable(['料号', '仓库', '可用', '安全库存', '单位'], (stock.items || []).map(s => [
        `<b>${esc(s.part_number || s.part_id || '')}</b>`, esc(s.warehouse_name || '—'),
        Number(s.available || 0).toLocaleString('zh-CN'), Number(s.safety_stock || 0).toLocaleString('zh-CN'), esc(s.uom || ''),
      ])) : '<div style="padding:24px"><p class="empty-hint">暂无库存记录。</p></div>';
    } else {
      el.innerHTML = (po.items || []).length ? simpleTable(['PO 号', '供应商', '金额', '状态', '预计到货', '操作'], (po.items || []).map(p => [
        `<b>${esc(p.po_number)}</b>`, esc(p.supplier_name || '—'), money(p.total_amount_cents),
        esc(p.status), fmtDate(p.expected_delivery_date),
        p.status === 'draft' ? industryBtn('po', p.id, 'approve', '审批') : '—',
      ])) : '<div style="padding:24px"><p class="empty-hint">暂无采购订单。</p></div>';
    }
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

let _qmsTab = 'inspections';
async function loadQualityData() {
  const container = document.querySelector('#content .module-page');
  const el = document.getElementById('quality-content');
  if (!container || !el) return;
  ensureIndustryTabs(container, 'qms', [['inspections', '检验单'], ['ncrs', '不合格 NCR']], _qmsTab, (tab) => { _qmsTab = tab || 'inspections'; loadQualityData(); });
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const [ins, ncrs] = await Promise.all([
      API.get('/v1/qms/inspections?limit=100'),
      API.get('/v1/qms/ncrs?limit=100'),
    ]);
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    if (stats[0]) stats[0].textContent = String((ins.items || []).filter(i => i.status === 'pending').length);
    if (stats[1]) stats[1].textContent = String((ncrs.items || []).filter(n => !['closed','cancelled'].includes(n.status)).length);
    if (stats[2]) stats[2].textContent = String((ins.items || []).filter(i => i.status === 'passed' || i.status === 'failed').length);
    if (stats[3]) stats[3].textContent = '—';
    if (_qmsTab === 'ncrs') {
      el.innerHTML = (ncrs.items || []).length ? simpleTable(['NCR 号', '批次 / 物料', '数量', '状态', '创建时间'], (ncrs.items || []).map(n => [
        `<b>${esc(n.ncr_number)}</b>`, esc(n.part_number || n.batch_no || '—'), Number(n.quantity || 0),
        esc(n.status), fmtDate(n.created_at),
      ])) : '<div style="padding:24px"><p class="empty-hint">暂无不合格处置。</p></div>';
    } else {
      el.innerHTML = (ins.items || []).length ? simpleTable(['检验单', '类型', '批次', '状态', '判定', '操作'], (ins.items || []).map(i => {
        const pending = (i.result || i.status) === 'pending';
        return [
          `<b>${esc(i.inspection_number || i.id.slice(0, 8))}</b>`, esc(i.inspection_type || '—'),
          esc(i.batch_no || '—'), esc(i.status), esc(i.result || i.verdict || '—'),
          pending ? industryBtn('qms', i.id, 'pass', '合格') + ' ' + industryBtn('qms', i.id, 'fail', '不合格') : '—',
        ];
      })) : '<div style="padding:24px"><p class="empty-hint">暂无检验单。制造演示数据可在「切换公司 → 恒精制造」查看。</p></div>';
    }
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

let _eqTab = 'assets';
async function loadEquipmentData() {
  const container = document.querySelector('#content .module-page');
  const el = document.getElementById('equipment-content');
  if (!container || !el) return;
  ensureIndustryTabs(container, 'eq', [['assets', '设备台账'], ['oee', 'OEE / 可用率']], _eqTab, (tab) => { _eqTab = tab || 'assets'; loadEquipmentData(); });
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const [assets, oee] = await Promise.all([
      API.get('/v1/equipment/assets?limit=100'),
      API.get('/v1/equipment/oee').catch(() => ({ items: [] })),
    ]);
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    if (stats[0]) stats[0].textContent = String((assets.items || []).length);
    if (stats[1]) stats[1].textContent = String((assets.items || []).filter(a => a.next_maintenance_date).length);
    if (stats[3]) stats[3].textContent = oee?.items?.length ? `${Math.round(oee.items.reduce((s, x) => s + Number(x.availability_pct || 0), 0) / oee.items.length)}%` : '—';
    if (_eqTab === 'oee') {
      el.innerHTML = (oee.items || []).length ? simpleTable(['设备', '状态', '可用率', '停机分钟', '备注'], (oee.items || []).map(x => [
        `<b>${esc(x.name)}</b><br><small style="color:var(--muted)">${esc(x.asset_code)}</small>`,
        esc(x.status), `${x.availability_pct}%`, Number(x.total_downtime_minutes || 0), esc(x.note || '—'),
      ])) : '<div style="padding:24px"><p class="empty-hint">暂无 OEE 数据。</p></div>';
    } else {
      el.innerHTML = (assets.items || []).length ? simpleTable(['设备', '厂商 / 型号', '工作中心', '状态', '下次保养'], (assets.items || []).map(a => [
        `<b>${esc(a.name)}</b><br><small style="color:var(--muted)">${esc(a.asset_code)}</small>`,
        `${esc(a.vendor || '—')} / ${esc(a.model || '—')}`, esc(a.work_center || '—'),
        esc(a.status), fmtDate(a.next_maintenance_date),
      ])) : '<div style="padding:24px"><p class="empty-hint">暂无设备台账。</p></div>';
    }
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

async function loadSalesData() {
  const el = document.getElementById('sales-content');
  if (!el) return;
  el.innerHTML = '<p class="loading-text" style="padding:20px">加载中…</p>';
  try {
    const { items } = await API.get('/v1/sales/orders?limit=100');
    const stats = document.querySelectorAll('.module-metrics .metric-card strong');
    const list = items || [];
    if (stats[0]) stats[0].textContent = String(list.length);
    if (stats[1]) stats[1].textContent = String(list.filter(o => o.status === 'confirmed').length);
    if (stats[2]) stats[2].textContent = String(list.filter(o => o.status === 'shipped').length);
    el.innerHTML = list.length ? simpleTable(['订单号', '客户', '金额', '状态', '下单日', '操作'], list.map(o => [
      `<b>${esc(o.order_number || o.so_number)}</b>`, esc(o.customer_name || '—'), money(o.total_amount_cents),
      esc(o.status), fmtDate(o.order_date),
      o.status === 'draft' ? industryBtn('so', o.id, 'confirm', '确认') : '—',
    ])) : '<div style="padding:24px"><p class="empty-hint">暂无销售订单。可先在「客户与销售」赢单，或从合同起草后生成订单。</p></div>';
  } catch (e) { el.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; }
}

async function loadAIConfigPanel() {
  const panel = document.getElementById('ai-config-panel');
  if (!panel) return;
  const body = panel.querySelector('div');
  let cfg, budgets;
  try {
    [cfg, budgets] = await Promise.all([
      API.get('/v1/ai/admin/config'),
      API.get('/v1/ai/admin/budgets'),
    ]);
  } catch (e) {
    if (e.status === 403) { panel.remove(); return; }
    body.innerHTML = `<p class="error-hint" style="padding:8px">AI 配置加载失败：${esc(e.message)}</p>`;
    return;
  }
  const usageByPerson = Object.fromEntries((budgets.usage || []).map(u => [u.person_id, u]));
  const tenantUsage = (budgets.usage || []).reduce((s, u) => s + Number(u.tokens || 0), 0);
  const tenantCost = (budgets.usage || []).reduce((s, u) => s + Number(u.cost_micros || 0), 0);
  const tokenPct = budgets.tenant.monthly_tokens ? Math.round(tenantUsage / budgets.tenant.monthly_tokens * 100) : 0;
  panel.querySelector('#ai-config-state').textContent = cfg.configured ? '已配置' : '未配置';
  panel.querySelector('#ai-config-state').className = `status-pill ${cfg.configured ? '' : 'warning'}`;
  body.innerHTML = `
    <div style="display:grid;grid-template-columns:1.2fr .8fr;gap:18px">
      <div>
        <h4 style="margin:0 0 8px;font-size:10px;color:var(--muted)">模型连接（密钥加密存储，保存后热生效）</h4>
        <div class="form-cols">
          <div class="form-row"><span>Provider</span><select id="ai-provider"><option value="openai" ${cfg.provider==='openai'?'selected':''}>OpenAI-compatible</option><option value="anthropic" ${cfg.provider==='anthropic'?'selected':''}>Anthropic</option></select></div>
          <div class="form-row"><span>模型</span><input id="ai-model" value="${esc(cfg.model || '')}" placeholder="gpt-4o / claude-3-5-sonnet-latest"></div>
        </div>
        <div class="form-row"><span>Base URL</span><input id="ai-base-url" value="${esc(cfg.base_url || '')}" placeholder="https://api.openai.com/v1"></div>
        <div class="form-row"><span>API Key</span><input id="ai-api-key" type="password" placeholder="${cfg.key_hint ? '已保存 ' + esc(cfg.key_hint) + '，留空不修改' : 'sk-...'}"></div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn primary small" id="ai-save-config" type="button">保存配置</button>
          <button class="btn ghost small" id="ai-test-config" type="button">测试连接</button>
          <span id="ai-config-msg" style="font-size:9px;color:var(--muted)">${cfg.source === 'env' ? '当前来自环境变量' : '当前来自租户配置'}</span>
        </div>
      </div>
      <div>
        <h4 style="margin:0 0 8px;font-size:10px;color:var(--muted)">本月用量</h4>
        <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0"><span>Tokens</span><b>${tenantUsage.toLocaleString('zh-CN')} / ${Number(budgets.tenant.monthly_tokens).toLocaleString('zh-CN')}</b></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0"><span>成本</span><b>$${(tenantCost/1e6).toFixed(2)} / $${(Number(budgets.tenant.monthly_cost_micros)/1e6).toFixed(2)}</b></div>
        <div class="budget-track" style="margin:6px 0 12px"><div class="budget-fill${tokenPct>=100?' over':''}" style="width:${Math.min(100, tokenPct)}%"></div></div>
        <div class="form-cols">
          <div class="form-row"><span>月 token 上限</span><input id="ai-budget-tokens" type="number" min="0" value="${Number(budgets.tenant.monthly_tokens)}"></div>
          <div class="form-row"><span>月成本上限（美元）</span><input id="ai-budget-cost" type="number" min="0" step="0.01" value="${(Number(budgets.tenant.monthly_cost_micros)/1e6).toFixed(2)}"></div>
        </div>
        <button class="btn ghost small" id="ai-save-budget" type="button">保存租户预算</button>
        <details style="margin-top:12px"><summary style="font-size:9px;cursor:pointer;color:var(--muted)">按人设置预算 / 查看用量</summary>
          <div class="form-row" style="margin-top:8px"><span>成员</span><select id="ai-budget-person"><option value="">选择成员</option>${(budgets.people_directory || []).map(p => `<option value="${esc(p.id)}">${esc(p.display_name)}</option>`).join('')}</select></div>
          <div class="form-cols">
            <div class="form-row"><span>token 上限</span><input id="ai-person-tokens" type="number" min="0" placeholder="留空用租户默认"></div>
            <div class="form-row"><span>成本上限（$）</span><input id="ai-person-cost" type="number" min="0" step="0.01"></div>
          </div>
          <button class="btn ghost small" id="ai-save-person-budget" type="button">保存个人预算</button>
          <div style="margin-top:8px;font-size:9px;color:var(--muted)">${(budgets.people_directory || []).slice(0, 8).map(p => { const u = usageByPerson[p.id] || {}; return `${esc(p.display_name)}：${Number(u.tokens || 0).toLocaleString('zh-CN')} tokens`; }).join(' · ')}</div>
        </details>
      </div>
    </div>`;
  panel.querySelector('#ai-save-config')?.addEventListener('click', async () => {
    const provider = panel.querySelector('#ai-provider').value;
    const body = {
      provider,
      base_url: panel.querySelector('#ai-base-url').value,
      model: panel.querySelector('#ai-model').value,
      api_key: panel.querySelector('#ai-api-key').value || undefined,
    };
    try {
      await API.patch('/v1/ai/admin/config', body);
      showToast('AI 配置已保存，30 秒内生效');
      loadAIConfigPanel();
    } catch (e) { showToast('保存失败：' + e.message, 'error'); }
  });
  panel.querySelector('#ai-test-config')?.addEventListener('click', async () => {
    const msg = panel.querySelector('#ai-config-msg');
    msg.textContent = '测试中…';
    try {
      const r = await API.post('/v1/ai/admin/config/test', {});
      msg.textContent = `连接成功 · ${r.provider} / ${r.model} · ${r.latency_ms}ms`;
    } catch (e) { msg.textContent = '测试失败：' + e.message; }
  });
  panel.querySelector('#ai-save-budget')?.addEventListener('click', async () => {
    try {
      await API.patch('/v1/ai/admin/budgets', {
        monthly_tokens: Number(panel.querySelector('#ai-budget-tokens').value) || 0,
        monthly_cost_micros: Math.round((Number(panel.querySelector('#ai-budget-cost').value) || 0) * 1e6),
      });
      showToast('租户预算已保存');
      loadAIConfigPanel();
    } catch (e) { showToast('保存失败：' + e.message, 'error'); }
  });
  panel.querySelector('#ai-save-person-budget')?.addEventListener('click', async () => {
    const personId = panel.querySelector('#ai-budget-person').value;
    if (!personId) { showToast('请选择成员', 'error'); return; }
    try {
      await API.patch('/v1/ai/admin/budgets', {
        person_id: personId,
        monthly_tokens: Number(panel.querySelector('#ai-person-tokens').value) || 0,
        monthly_cost_micros: Math.round((Number(panel.querySelector('#ai-person-cost').value) || 0) * 1e6),
      });
      showToast('个人预算已保存');
      loadAIConfigPanel();
    } catch (e) { showToast('保存失败：' + e.message, 'error'); }
  });
}

function loadSettingsData() {
  loadAIConfigPanel();
  loadRbacPanel();
  loadAuditData();
}

document.addEventListener('click', event => {
  const tool = event.target.closest('.table-tools button');
  if (tool) {
    const panel = tablePanelOf(tool);
    if (!panel) return;
    const label = tool.textContent.trim();
    if (label.includes('搜索') || label.includes('⌕')) { openQuickSearch(panel); return; }
    if (label.includes('筛选') || label.includes('⇅')) { openTableFilter(panel); return; }
    if (label.includes('视图') || label.includes('⊞')) {
      panel.classList.toggle('table-compact');
      showToast(panel.classList.contains('table-compact') ? '已切换紧凑视图' : '已恢复标准视图');
      return;
    }
  }
  const tab = event.target.closest('.filter-tabs button');
  if (tab && !Object.keys(tab.dataset).some(key => key.endsWith('Tab'))) applyFilterTab(tab);
});

// ── 通用表格工具栏：搜索 / 筛选 / 密度 / 顶部筛选 Tab ──
function tablePanelOf(el) {
  return el.closest('.module-table-panel') || el.closest('.module-page');
}
function tableRowsOf(panel) {
  return [...(panel?.querySelectorAll('.data-table tbody tr') || [])].filter(tr => !tr.querySelector('.empty-hint'));
}
function applyRowFilter(panel, predicate) {
  let visible = 0;
  for (const tr of tableRowsOf(panel)) {
    const show = predicate(tr);
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  const footer = panel.querySelector('.table-footer [data-role="row-count"]');
  if (footer) footer.textContent = `显示 ${visible} 行`;
}
function openQuickSearch(panel) {
  const toolbar = panel.querySelector('.table-toolbar');
  if (!toolbar) return;
  let input = toolbar.querySelector('.table-quick-search');
  if (!input) {
    input = document.createElement('input');
    input.className = 'table-quick-search';
    input.placeholder = '筛选当前列表…';
    input.setAttribute('aria-label', '筛选当前列表');
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      applyRowFilter(panel, tr => !q || tr.innerText.toLowerCase().includes(q));
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { input.value = ''; applyRowFilter(panel, () => true); input.blur(); }
    });
    toolbar.append(input);
  }
  input.focus();
}
function openTableFilter(panel) {
  const table = panel.querySelector('.data-table');
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  Modal.show('筛选当前列表', `
    <div class="form-row"><span>按列筛选</span><select id="tf-col">${headers.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('')}</select></div>
    <div id="tf-values" style="max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:4px 0"></div>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn ghost small" type="button" id="tf-clear">清除筛选</button><button class="btn primary small" type="button" id="tf-apply">应用筛选</button></div>
  `, null, { hideSubmit: true });
  const modal = Modal._el;
  const colSelect = modal.querySelector('#tf-col');
  const valuesBox = modal.querySelector('#tf-values');
  const renderValues = () => {
    const idx = Number(colSelect.value);
    const values = [...new Set(tableRowsOf(panel).map(tr => tr.children[idx]?.innerText?.trim()).filter(Boolean))].slice(0, 40);
    valuesBox.innerHTML = values.length
      ? values.map(v => `<label style="display:flex;gap:8px;align-items:center;font-size:10px"><input type="checkbox" value="${esc(v)}"> ${esc(v)}</label>`).join('')
      : '<p class="empty-hint">当前列没有可筛选的值</p>';
  };
  colSelect.addEventListener('change', renderValues);
  renderValues();
  modal.querySelector('#tf-apply').addEventListener('click', () => {
    const selected = new Set([...valuesBox.querySelectorAll('input:checked')].map(i => i.value));
    const idx = Number(colSelect.value);
    applyRowFilter(panel, tr => !selected.size || selected.has(tr.children[idx]?.innerText?.trim()));
    Modal.hide();
  });
  modal.querySelector('#tf-clear').addEventListener('click', () => {
    applyRowFilter(panel, () => true);
    Modal.hide();
  });
}
function applyFilterTab(button) {
  const panel = tablePanelOf(button);
  if (!panel) return;
  panel.querySelectorAll('.filter-tabs button').forEach(b => b.classList.toggle('active', b === button));
  const label = button.textContent.trim();
  const user = window.FeishuHQ?.currentUserName || '';
  applyRowFilter(panel, tr => {
    const text = tr.innerText;
    if (/^全部/.test(label)) return true;
    if (label.includes('我负责')) return Boolean(user) && text.includes(user);
    if (label.includes('风险')) return text.includes('风险') || text.includes('at_risk');
    if (label.includes('本周交付')) {
      const dates = [...text.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m => new Date(m[0] + 'T23:59:59'));
      return dates.some(d => !Number.isNaN(d.getTime()) && d >= new Date() && d <= new Date(Date.now() + 7 * 86400000));
    }
    const normalized = label.replace(/阶段|商机|项目|交付|记录/g, '').trim();
    return !normalized || text.includes(normalized);
  });
}

// ── 移动端表格卡片化：自动把表头映射为每格的 data-label ──
function decorateResponsiveTables(root = document) {
  for (const table of root.querySelectorAll('.data-table')) {
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!headers.length) continue;
    table.dataset.responsive = '1';
    for (const tr of table.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, index) => {
        if (headers[index]) td.dataset.label = headers[index];
      });
    }
  }
}
let tableDecorateTimer = null;
function scheduleTableDecoration() {
  clearTimeout(tableDecorateTimer);
  tableDecorateTimer = setTimeout(() => decorateResponsiveTables(document), 60);
}
const tableObserver = new MutationObserver(scheduleTableDecoration);
tableObserver.observe(document.getElementById('content') || document.body, { childList: true, subtree: true });
scheduleTableDecoration();

// ── 通用数据下钻：指标卡 → 明细表 → 记录详情 → 关联表（可无限嵌套）──
const drillStage = v => ({ lead:'线索', qualified:'需求确认', proposal:'方案', negotiation:'商务谈判', won:'已赢单', lost:'已丢单' }[v] || v || '—');
const drillStatus = v => ({ active:'进行中', at_risk:'有风险', planning:'规划中', completed:'已完成', on_hold:'暂停', paid:'已回款', planned:'待回款', partial:'部分回款', sent:'待收', overdue:'逾期', approved:'已通过', submitted:'待审批', pending:'待处理', open:'开放', done:'已完成', in_progress:'进行中' }[v] || v || '—');
const DRILL_COLS = {
  opportunity: [
    { key:'name', label:'商机' }, { key:'customer_name', label:'客户' },
    { key:'stage', label:'阶段', format:drillStage }, { key:'amount_cents', label:'金额', format:v=>money(v) },
    { key:'win_probability', label:'赢单率', format:v=>`${v ?? 0}%` }, { key:'owner_name', label:'负责人' },
  ],
  payment: [
    { key:'customer_name', label:'客户' }, { key:'milestone', label:'里程碑' },
    { key:'amount_cents', label:'金额', format:v=>money(v) }, { key:'due_date', label:'到期', format:fmtDate },
    { key:'status', label:'状态', format:drillStatus },
  ],
  project: [
    { key:'name', label:'项目' }, { key:'customer_name', label:'客户' },
    { key:'owner_name', label:'负责人' }, { key:'progress', label:'进度', format:v=>`${v ?? 0}%` },
    { key:'status', label:'状态', format:drillStatus }, { key:'end_date', label:'截止', format:fmtDate },
    { key:'budget_cents', label:'预算', format:v=>money(v) },
  ],
  employee: [
    { key:'display_name', label:'姓名' }, { key:'employee_number', label:'工号' },
    { key:'department_name', label:'部门' }, { key:'position_title', label:'职位' },
    { key:'status', label:'状态', format:drillStatus }, { key:'start_date', label:'入职', format:fmtDate },
  ],
  invoice: [
    { key:'invoice_number', label:'发票号' }, { key:'counterparty_name', label:'对方' },
    { key:'amount_cents', label:'金额', format:v=>money(v) }, { key:'paid_cents', label:'已收', format:v=>money(v) },
    { key:'due_date', label:'到期', format:fmtDate }, { key:'status', label:'状态', format:drillStatus },
  ],
  expense: [
    { key:'description', label:'事由' }, { key:'category', label:'类别' },
    { key:'amount_cents', label:'金额', format:v=>money(v) }, { key:'expense_date', label:'日期', format:fmtDate },
    { key:'status', label:'状态', format:drillStatus },
  ],
  requisition: [
    { key:'title', label:'职位' }, { key:'department', label:'部门' },
    { key:'headcount', label:'人数' }, { key:'priority', label:'优先级' },
    { key:'status', label:'状态', format:drillStatus },
  ],
  candidate: [
    { key:'name', label:'姓名' }, { key:'current_title', label:'当前职位' },
    { key:'current_company', label:'公司' }, { key:'status', label:'阶段', format:drillStatus },
    { key:'expected_salary_cents', label:'期望薪资', format:v=>money(v) },
  ],
  contract: [
    { key:'contract_no', label:'合同号' }, { key:'title', label:'标题' },
    { key:'customer_name', label:'客户' }, { key:'amount_cents', label:'金额', format:v=>money(v) },
    { key:'status', label:'状态', format:drillStatus }, { key:'signed_at', label:'签署', format:fmtDate },
  ],
  task: [
    { key:'title', label:'任务' }, { key:'project_name', label:'项目' },
    { key:'status', label:'状态', format:drillStatus }, { key:'due_date', label:'截止', format:fmtDate },
    { key:'assignee_name', label:'负责人' },
  ],
  approval: [
    { key:'title', label:'事项' }, { key:'resource_type', label:'类型' },
    { key:'requester_name', label:'申请人' }, { key:'amount_cents', label:'金额', format:v=>money(v) },
    { key:'status', label:'状态', format:drillStatus },
  ],
  account: [
    { key:'name', label:'客户' }, { key:'industry', label:'行业' },
    { key:'owner_name', label:'负责人' }, { key:'status', label:'状态', format:drillStatus },
  ],
  salesorder: [
    { key:'order_number', label:'订单号' }, { key:'customer_name', label:'客户' },
    { key:'total_amount_cents', label:'金额', format:v=>money(v) }, { key:'status', label:'状态', format:drillStatus },
    { key:'order_date', label:'日期', format:fmtDate },
  ],
  requirement: [
    { key:'code', label:'编号' }, { key:'title', label:'需求' }, { key:'priority', label:'优先级' },
    { key:'status', label:'状态', format:drillStatus }, { key:'story_points', label:'故事点' },
  ],
  defect: [
    { key:'code', label:'编号' }, { key:'title', label:'缺陷' }, { key:'severity', label:'严重度' },
    { key:'status', label:'状态', format:drillStatus }, { key:'assignee_name', label:'指派给' },
  ],
  asset: [
    { key:'asset_code', label:'资产号' }, { key:'name', label:'名称' }, { key:'category', label:'类别' },
    { key:'status', label:'状态', format:drillStatus }, { key:'assigned_name', label:'使用人' },
  ],
  ticket: [
    { key:'ticket_number', label:'工单号' }, { key:'title', label:'事项' }, { key:'priority', label:'优先级' },
    { key:'status', label:'状态', format:drillStatus }, { key:'created_at', label:'创建', format:fmtDate },
  ],
  purchase: [
    { key:'po_number', label:'采购单' }, { key:'supplier_name', label:'供应商' },
    { key:'total_amount_cents', label:'金额', format:v=>money(v) }, { key:'status', label:'状态', format:drillStatus },
    { key:'expected_date', label:'预计到货', format:fmtDate },
  ],
  inspection: [
    { key:'inspection_number', label:'检验单' }, { key:'item_name', label:'物料/产品' },
    { key:'status', label:'状态', format:drillStatus }, { key:'created_at', label:'创建', format:fmtDate },
  ],
  workorder: [
    { key:'wo_number', label:'工单' }, { key:'product_name', label:'产品' },
    { key:'quantity', label:'数量' }, { key:'status', label:'状态', format:drillStatus },
    { key:'planned_end_date', label:'计划完工', format:fmtDate },
  ],
};
const DRILL_METRICS = {
  overview: [
    { title:'回款计划明细', api:'/v1/finance/payments?limit=200', columns:DRILL_COLS.payment, type:'payment' },
    { title:'销售商机明细', api:'/v1/crm/opportunities?limit=200', columns:DRILL_COLS.opportunity, type:'opportunity' },
    { title:'项目健康明细', api:'/v1/projects?limit=200', columns:DRILL_COLS.project, type:'project' },
    { title:'在职人员明细', api:'/v1/hr/employees?limit=200', columns:DRILL_COLS.employee, type:'employee' },
  ],
  crm: [
    { title:'销售漏斗明细', api:'/v1/crm/opportunities?limit=200', columns:DRILL_COLS.opportunity, type:'opportunity' },
    { title:'活跃商机明细', api:'/v1/crm/opportunities?limit=200', columns:DRILL_COLS.opportunity, type:'opportunity' },
    { title:'商机赢单率明细', api:'/v1/crm/opportunities?limit=200', columns:DRILL_COLS.opportunity, type:'opportunity' },
    { title:'回款计划明细', api:'/v1/finance/payments?limit=200', columns:DRILL_COLS.payment, type:'payment' },
  ],
  finance: [
    null,
    { title:'累计回款明细', api:'/v1/finance/payments?limit=200', columns:DRILL_COLS.payment, type:'payment' },
    { title:'本月支出明细', api:'/v1/finance/expenses?limit=200', columns:DRILL_COLS.expense, type:'expense' },
    { title:'应收账款 / 发票明细', api:'/v1/finance/invoices?limit=200', columns:DRILL_COLS.invoice, type:'invoice' },
  ],
  hr: [
    { title:'在职员工名册', api:'/v1/hr/employees?limit=200', columns:DRILL_COLS.employee, type:'employee' },
    { title:'开放职位明细', api:'/v1/hr/requisitions?limit=200', columns:DRILL_COLS.requisition, type:'requisition' },
    { title:'候选人明细', api:'/v1/hr/candidates?limit=200', columns:DRILL_COLS.candidate, type:'candidate' },
    { title:'在职员工名册', api:'/v1/hr/employees?limit=200', columns:DRILL_COLS.employee, type:'employee' },
  ],
  projects: [
    { title:'进行中项目明细', api:'/v1/projects?limit=200', columns:DRILL_COLS.project, type:'project' },
    { title:'项目健康明细', api:'/v1/projects?limit=200', columns:DRILL_COLS.project, type:'project' },
    { title:'合同金额明细', api:'/v1/sales/contracts?limit=200', columns:DRILL_COLS.contract, type:'contract' },
    { title:'项目团队明细', api:'/v1/hr/employees?limit=200', columns:DRILL_COLS.employee, type:'employee' },
  ],
  workbench: [
    { title:'待我审批', api:'/v1/approvals/pending', columns:DRILL_COLS.approval, type:'approval' },
    { title:'我的开放任务', loader:async()=> ((await API.get('/v1/workbench')).cards?.my_tasks?.list || []), columns:DRILL_COLS.task, type:'task' },
    { title:'7 天内到期任务', loader:async()=> (((await API.get('/v1/workbench')).cards?.my_tasks?.list || []).filter(t=>t.due_date && Date.parse(t.due_date) <= Date.now()+7*86400000)), columns:DRILL_COLS.task, type:'task' },
    { title:'今日打卡', loader:async()=> { const w=await API.get('/v1/workbench'); return w.cards?.attendance_today ? [{...w.cards.attendance_today,title:'今日打卡'}] : []; }, columns:[{key:'check_in',label:'上班'},{key:'check_out',label:'下班'},{key:'status',label:'状态'}], type:'attendance' },
  ],
  sales: [
    { title:'销售订单', api:'/v1/sales/orders?limit=200', columns:DRILL_COLS.salesorder, type:'salesorder' },
  ],
  manufacturing: [
    { title:'未结工单', api:'/v1/mfg/work-orders?limit=200', columns:DRILL_COLS.workorder, type:'workorder' },
  ],
  approvals: [
    { title:'待我审批', api:'/v1/approvals/pending', columns:DRILL_COLS.approval, type:'approval' },
  ],
};
const DRILL_DEFAULT = {
  contracts: { title:'合同明细', api:'/v1/sales/contracts?limit=200', columns:DRILL_COLS.contract, type:'contract' },
  dev: { title:'研发明细', api:'/v1/sw/requirements?limit=200', columns:DRILL_COLS.requirement, type:'requirement' },
  it: { title:'IT 资产明细', api:'/v1/it/assets?limit=200', columns:DRILL_COLS.asset, type:'asset' },
  supplychain: { title:'采购明细', api:'/v1/purchase/orders?limit=200', columns:DRILL_COLS.purchase, type:'purchase' },
  quality: { title:'质量检验明细', api:'/v1/qms/inspections?limit=200', columns:DRILL_COLS.inspection, type:'inspection' },
  equipment: { title:'设备明细', api:'/v1/equipment/assets?limit=200', columns:DRILL_COLS.asset, type:'asset' },
  org: { title:'在职人员明细', api:'/v1/hr/employees?limit=200', columns:DRILL_COLS.employee, type:'employee' },
  knowledge: { title:'知识条目', api:'/v1/knowledge/items?limit=200', columns:[{key:'title',label:'标题'},{key:'classification',label:'密级'},{key:'index_status',label:'索引'},{key:'updated_at',label:'更新',format:fmtDate}], type:'knowledge' },
};
const drillState = { stack: [], el: null };
function drillColumnsFor(type) { return DRILL_COLS[type] || DRILL_COLS.project; }
function drillValue(row, col) { const value = row?.[col.key]; return col.format ? col.format(value, row) : (value ?? '—'); }
function ensureDrillLayer() {
  if (drillState.el) return drillState.el;
  const el = document.createElement('div');
  el.className = 'drill-layer';
  el.innerHTML = '<button class="drill-backdrop" aria-label="关闭明细"></button><section class="drill-modal" role="dialog" aria-modal="true" aria-label="数据明细"><header><button class="drill-back" type="button" aria-label="返回">←</button><div><small>DATA DRILLDOWN</small><h2></h2><p></p></div><button class="drill-close" type="button" aria-label="关闭">×</button></header><div class="drill-body"></div></section>';
  document.body.append(el);
  el.querySelector('.drill-backdrop').addEventListener('click', () => drillClose());
  el.querySelector('.drill-close').addEventListener('click', () => drillClose());
  el.querySelector('.drill-back').addEventListener('click', () => { drillState.stack.pop(); drillRender(); });
  drillState.el = el;
  return el;
}
function drillClose() { drillState.stack = []; if (drillState.el) drillState.el.classList.remove('open'); }
function drillRender() {
  const el = ensureDrillLayer();
  const current = drillState.stack[drillState.stack.length - 1];
  if (!current) return drillClose();
  el.classList.add('open');
  el.querySelector('.drill-back').style.visibility = drillState.stack.length > 1 ? 'visible' : 'hidden';
  el.querySelector('h2').textContent = current.title || '数据明细';
  el.querySelector('p').textContent = current.subtitle || '';
  const body = el.querySelector('.drill-body');
  if (current.kind === 'detail') {
    body.innerHTML = `<div class="drill-fields">${current.fields.map(f => `<div><span>${esc(f.label)}</span><b>${esc(String(f.value ?? '—'))}</b></div>`).join('')}</div>${current.related?.length ? `<div class="drill-related"><small>关联明细</small>${current.related.map((r, i) => `<button type="button" data-drill-related="${i}">${esc(r.label)} →</button>`).join('')}</div>` : ''}`;
  } else if (current.loading) {
    body.innerHTML = '<p class="loading-text" style="padding:28px">正在读取明细…</p>';
  } else if (current.error) {
    body.innerHTML = `<p class="error-hint" style="padding:28px">加载失败：${esc(current.error)}</p>`;
  } else if (!current.rows.length) {
    body.innerHTML = '<p class="empty-hint" style="padding:28px">当前没有可展示的明细。</p>';
  } else {
    body.innerHTML = `<div class="drill-toolbar"><input class="drill-search" placeholder="筛选当前明细…" aria-label="筛选明细"><span>${current.rows.length} 条</span></div><div class="drill-table-wrap"><table class="drill-table"><thead><tr>${current.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>${current.rows.map((row, i) => `<tr data-drill-row="${i}">${current.columns.map(c => `<td>${esc(String(drillValue(row, c)))}</td>`).join('')}<td class="drill-open">→</td></tr>`).join('')}</tbody></table></div>`;
    body.querySelector('.drill-search')?.addEventListener('input', event => {
      const q = event.target.value.trim().toLowerCase();
      body.querySelectorAll('tbody tr').forEach(tr => { tr.style.display = !q || tr.innerText.toLowerCase().includes(q) ? '' : 'none'; });
    });
  }
  el.onclick = event => {
    const related = event.target.closest('[data-drill-related]');
    if (related && current.related) { drillPushTable(current.related[Number(related.dataset.drillRelated)]); return; }
    const rowEl = event.target.closest('[data-drill-row]');
    if (rowEl && current.rows) drillPushDetail(current, current.rows[Number(rowEl.dataset.drillRow)]);
  };
}
function drillPushTable(config) {
  const entry = { kind: 'table', title: config.title || config.label || '数据明细', subtitle: config.subtitle || '', columns: config.columns, type: config.type, rows: [], loading: true, error: null, related: config.related };
  drillState.stack.push(entry);
  drillRender();
  Promise.resolve(config.loader ? config.loader() : API.get(config.api))
    .then(data => { entry.rows = Array.isArray(data) ? data : (data.items || []); entry.loading = false; })
    .catch(error => { entry.error = error.message || String(error); entry.loading = false; })
    .finally(() => { if (drillState.stack.includes(entry)) drillRender(); });
}
function drillRelatedFor(type, row) {
  const list = [];
  if (type === 'project' && row.id) {
    list.push({ label:'任务', loader:()=>API.get(`/v1/projects/${row.id}/tasks?limit=200`).then(d=>d.items||[]), columns:DRILL_COLS.task, type:'task' });
    list.push({ label:'里程碑', loader:()=>API.get(`/v1/projects/${row.id}/milestones?limit=200`).then(d=>d.items||[]), columns:[{key:'name',label:'里程碑'},{key:'due_date',label:'截止',format:fmtDate},{key:'status',label:'状态',format:drillStatus}], type:'milestone' });
    list.push({ label:'回款', loader:()=>API.get('/v1/finance/payments?limit=200').then(d=>(d.items||[]).filter(p=>p.project_id===row.id)), columns:DRILL_COLS.payment, type:'payment' });
  }
  if (type === 'payment' && row.id) {
    list.push({ label:'关联发票', loader:()=>API.get('/v1/finance/invoices?limit=200').then(d=>(d.items||[]).filter(x=>x.payment_plan_id===row.id)), columns:DRILL_COLS.invoice, type:'invoice' });
    list.push({ label:'所属项目', loader:()=>API.get('/v1/projects?limit=200').then(d=>(d.items||[]).filter(p=>p.id===row.project_id)), columns:DRILL_COLS.project, type:'project' });
  }
  if (type === 'opportunity' && row.id) {
    list.push({ label:'回款计划', loader:()=>API.get('/v1/finance/payments?limit=200').then(d=>(d.items||[]).filter(p=>p.customer_name===row.customer_name)), columns:DRILL_COLS.payment, type:'payment' });
  }
  if (type === 'employee' && row.id) {
    list.push({ label:'合同', loader:()=>API.get(`/v1/hr/employees/${row.id}/contracts`).then(d=>d.items||[]), columns:DRILL_COLS.contract, type:'contract' });
  }
  if (type === 'task' && row.project_id) {
    list.push({ label:'所属项目', loader:()=>API.get('/v1/projects?limit=200').then(d=>(d.items||[]).filter(p=>p.id===row.project_id)), columns:DRILL_COLS.project, type:'project' });
  }
  return list;
}
function drillPushDetail(parent, row) {
  const title = row.name || row.title || row.display_name || row.invoice_number || row.wo_number || row.customer_name || '记录详情';
  const fields = parent.columns.map(c => ({ label: c.label, value: drillValue(row, c) }));
  const hidden = new Set(['id','tenant_id','project_id','contract_id','account_id','owner_person_id','requester_person_id','is_demo','version','created_at','updated_at','deleted_at']);
  const extras = Object.entries(row).filter(([k,v]) => !parent.columns.some(c=>c.key===k) && v != null && !hidden.has(k) && !k.endsWith('_id')).slice(0, 8).map(([k,v]) => ({ label:k, value:typeof v==='object'?JSON.stringify(v):v }));
  drillState.stack.push({ kind:'detail', title:String(title), subtitle:parent.title, fields:[...fields, ...extras], related:drillRelatedFor(parent.type, row) });
  drillRender();
}
function openMetricDrill(view, index) {
  const config = DRILL_METRICS[view]?.[index] || DRILL_DEFAULT[view];
  if (!config) { showToast('该指标暂未接入明细'); return; }
  drillState.stack = [];
  drillPushTable(config);
}
function currentDrillView() { return document.body.dataset.view || location.hash.slice(1) || 'overview'; }
function wireMetricDrills() {
  document.querySelectorAll('.metric-grid .metric-card').forEach((card, index) => {
    const view = currentDrillView();
    if (DRILL_METRICS[view]?.[index] || DRILL_DEFAULT[view]) {
      card.classList.add('is-drillable');
      card.dataset.drillIndex = String(index);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
    }
  });
}
document.addEventListener('click', async event => {
  const cashPayment = event.target.closest('[data-cash-payment]');
  if (cashPayment) {
    try {
      const data = await API.get('/v1/finance/payments?limit=200');
      const row = (data.items || []).find(p => p.id === cashPayment.dataset.cashPayment);
      if (row) {
        drillState.stack = [];
        drillPushDetail({ columns: DRILL_COLS.payment, title: '回款计划', type: 'payment' }, row);
      }
    } catch { showToast('回款明细加载失败', 'error'); }
    return;
  }
  const card = event.target.closest('.metric-card.is-drillable');
  if (card && !event.target.closest('button')) { openMetricDrill(currentDrillView(), Number(card.dataset.drillIndex)); return; }
  // 普通列表行也可点开详情；带操作按钮的单元格不抢事件。
  if (event.target.closest('button,a,input,select')) return;
  const tr = event.target.closest('.module-table-panel .data-table tbody tr');
  if (!tr || tr.closest('.drill-table') || tr.querySelector('td[colspan]')) return;
  // 这些行已有自己的详情抽屉；不要同时再弹一层通用下钻，否则两个弹层叠在一起。
  if (tr.matches('.clickable-row, [data-id], [data-emp-id], [data-vendor-id], [data-asset-id], [data-project-id]')) return;
  const table = tr.closest('table');
  const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  if (!headers.length) return;
  const row = {};
  [...tr.children].forEach((td, i) => { row[headers[i] || `列${i + 1}`] = td.innerText.trim(); });
  const cols = headers.map(h => ({ key: h, label: h }));
  drillState.stack = [];
  drillPushDetail({ columns: cols, title: '列表记录', type: '' }, row);
});
document.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.metric-card.is-drillable')) { event.preventDefault(); openMetricDrill(currentDrillView(), Number(event.target.dataset.drillIndex)); }
  if (event.key === 'Escape' && drillState.el?.classList.contains('open')) drillClose();
});

const moduleDataLoaders = {
  overview: loadOverviewData,
  settings: loadSettingsData,
  projects: loadProjectsData,
  crm: loadCRMData,
  hr: loadHRData,
  finance: loadFinanceData,
  it: loadITData,
  knowledge: loadKnowledgeData,
  strategy: loadStrategyData,
  approvals: loadApprovalsData,
  dashboard: loadDashboardData,
  workbench: loadWorkbenchData,
  ai: loadAIData,
  org: loadOrgData,
  contracts: loadContractsData,
  dev: loadDevData,
  manufacturing: loadManufacturingData,
  supplychain: loadSupplychainData,
  quality: loadQualityData,
  equipment: loadEquipmentData,
  sales: loadSalesData
};

// ──────────────────────────────────────────────────────────────
// ── 创建处理器映射
// ──────────────────────────────────────────────────────────────
function openCreateKnowledgeModal() {
  Modal.show('新建知识条目', `
    <div class="form-row"><span>标题 <i class="req">*</i></span><input name="title" required placeholder="例如：门店上线检查清单"></div>
    <div class="form-cols">
      <div class="form-row"><span>密级</span><select name="classification">
        <option value="internal">内部</option><option value="public">公开</option>
        <option value="confidential">机密</option><option value="restricted">严格受限</option>
      </select></div>
      <div class="form-row"><span>标签（逗号分隔）</span><input name="tags" placeholder="交付,清单"></div>
    </div>
    <div class="form-row"><span>正文（Markdown）</span><textarea name="content" rows="8" placeholder="写下可复用的经验、流程或检查项…"></textarea></div>
  `, async (data) => {
    await API.post('/v1/knowledge/items', {
      title: data.title,
      content: data.content,
      classification: data.classification,
      tags: String(data.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    });
    toast('知识条目已创建');
    loadKnowledgeData();
  });
}

function openCreateContractModal() {
  Modal.show('起草合同', `
    <div class="form-row"><span>合同标题 <i class="req">*</i></span><input name="title" required placeholder="例如：远山零售数字化一期服务合同"></div>
    <div class="form-row"><span>客户 <i class="req">*</i></span><select name="account_id" id="contract-account" required><option value="">加载客户中…</option></select></div>
    <div class="form-cols">
      <div class="form-row"><span>合同类型</span><select name="contract_type">
        <option value="implementation">实施</option><option value="saas">SaaS 订阅</option>
        <option value="service">服务</option><option value="hardware">硬件</option><option value="other">其他</option>
      </select></div>
      <div class="form-row"><span>金额（元）<i class="req">*</i></span><input type="number" name="amount_yuan" min="0" required></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>开始日期</span><input type="date" name="start_date"></div>
      <div class="form-row"><span>结束日期</span><input type="date" name="end_date"></div>
    </div>
    <div class="form-row"><span>付款条款</span><textarea name="payment_terms" rows="2" placeholder="如：3-4-3 分期，验收后 30 天"></textarea></div>
  `, async (data) => {
    await API.post('/v1/sales/contracts', {
      title: data.title,
      account_id: data.account_id,
      contract_type: data.contract_type,
      amount_cents: Math.round((Number(data.amount_yuan) || 0) * 100),
      start_date: data.start_date,
      end_date: data.end_date,
      payment_terms: data.payment_terms,
    });
    toast('合同已起草');
    loadContractsData();
  });
  API.get('/v1/crm/accounts?limit=200').then(({ items }) => {
    const sel = document.getElementById('contract-account');
    if (!sel) return;
    sel.innerHTML = '<option value="">请选择客户</option>' + (items || []).map(a =>
      `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  }).catch(() => {
    const sel = document.getElementById('contract-account');
    if (sel) sel.innerHTML = '<option value="">客户列表加载失败</option>';
  });
}

function fillProjectOptions(selectId) {
  API.get('/v1/projects?limit=200').then(({ items }) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="">请选择项目</option>' + (items || []).map(p =>
      `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  }).catch(() => {
    const sel = document.getElementById(selectId);
    if (sel) sel.innerHTML = '<option value="">项目加载失败</option>';
  });
}

function openCreateDevModal() {
  if (_devTab === 'iterations') {
    Modal.show('新建迭代', `
      <div class="form-row"><span>所属项目 <i class="req">*</i></span><select name="project_id" id="iter-project" required><option value="">加载项目中…</option></select></div>
      <div class="form-row"><span>迭代名称 <i class="req">*</i></span><input name="name" required placeholder="如：2026-W46"></div>
      <div class="form-row"><span>迭代目标</span><input name="goal" placeholder="本次迭代要达成的结果"></div>
      <div class="form-cols">
        <div class="form-row"><span>容量点</span><input type="number" name="capacity_points" min="0" value="40"></div>
        <div class="form-row"><span>开始 / 结束 <i class="req">*</i></span><div style="display:flex;gap:6px"><input type="date" name="start_date" required><input type="date" name="end_date" required></div></div>
      </div>
    `, async (data) => {
      await API.post('/v1/sw/iterations', data);
      toast('迭代已创建');
      loadDevData();
    });
    fillProjectOptions('iter-project');
    return;
  }
  if (_devTab === 'versions') {
    Modal.show('新建版本', `
      <div class="form-row"><span>所属项目 <i class="req">*</i></span><select name="project_id" id="ver-project" required><option value="">加载项目中…</option></select></div>
      <div class="form-row"><span>版本号 <i class="req">*</i></span><input name="version_number" required placeholder="如：v1.4.0"></div>
      <div class="form-row"><span>计划发布日期</span><input type="date" name="planned_release_date"></div>
      <div class="form-row"><span>发布说明</span><textarea name="release_notes" rows="4" placeholder="本次发布包含的功能与修复"></textarea></div>
    `, async (data) => {
      await API.post('/v1/sw/versions', data);
      toast('版本已创建');
      loadDevData();
    });
    fillProjectOptions('ver-project');
    return;
  }
  if (_devTab === 'defects') {
    Modal.show('提交缺陷', `
      <div class="form-row"><span>缺陷标题 <i class="req">*</i></span><input name="title" required placeholder="简要描述问题"></div>
      <div class="form-cols">
        <div class="form-row"><span>严重级别</span><select name="severity">
          <option value="critical">致命</option><option value="blocker">阻塞</option>
          <option value="major" selected>严重</option><option value="minor">一般</option><option value="trivial">轻微</option>
        </select></div>
        <div class="form-row"><span>优先级</span><select name="priority">
          <option value="urgent">紧急</option><option value="high">高</option>
          <option value="medium" selected>中</option><option value="low">低</option>
        </select></div>
      </div>
      <div class="form-row"><span>复现步骤</span><textarea name="repro_steps" rows="3" placeholder="1. … 2. … 3. …"></textarea></div>
      <div class="form-row"><span>环境</span><input name="environment" placeholder="如：生产 / Chrome 131 / 租户 A"></div>
      <div class="form-row"><span>描述</span><textarea name="description" rows="3"></textarea></div>
    `, async (data) => {
      await API.post('/v1/sw/defects', {
        title: data.title, severity: data.severity, priority: data.priority,
        repro_steps: data.repro_steps, environment: data.environment, description: data.description,
      });
      toast('缺陷已提交');
      loadDevData();
    });
  } else {
    Modal.show('提交需求', `
      <div class="form-row"><span>需求标题 <i class="req">*</i></span><input name="title" required placeholder="一句话说明要解决的问题"></div>
      <div class="form-cols">
        <div class="form-row"><span>优先级</span><select name="priority">
          <option value="urgent">紧急</option><option value="high">高</option>
          <option value="medium" selected>中</option><option value="low">低</option>
        </select></div>
        <div class="form-row"><span>故事点</span><input type="number" name="story_points" min="1"></div>
      </div>
      <div class="form-row"><span>来源</span><input name="source" placeholder="客户 / 内部 / 运营" value="internal"></div>
      <div class="form-row"><span>需求描述</span><textarea name="description" rows="5" placeholder="背景、目标、验收标准…"></textarea></div>
    `, async (data) => {
      await API.post('/v1/sw/requirements', {
        title: data.title, priority: data.priority, story_points: data.story_points,
        source: data.source, description: data.description,
      });
      toast('需求已提交');
      loadDevData();
    });
  }
}

function fillSelect(selectId, url, mapper, placeholder) {
  API.get(url).then(({ items }) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = `<option value="">${esc(placeholder || '请选择')}</option>` + (items || []).map(mapper).join('');
  }).catch(() => {
    const sel = document.getElementById(selectId);
    if (sel) sel.innerHTML = '<option value="">加载失败</option>';
  });
}

function openCreateWorkOrderModal() {
  Modal.show('新建生产工单', `
    <div class="form-row"><span>产品 <i class="req">*</i></span><select name="product_part_id" id="wo-part" required><option value="">加载物料中…</option></select></div>
    <div class="form-cols">
      <div class="form-row"><span>计划数量 <i class="req">*</i></span><input type="number" name="planned_qty" min="1" required></div>
      <div class="form-row"><span>优先级</span><select name="priority"><option value="medium">中</option><option value="high">高</option><option value="urgent">紧急</option><option value="low">低</option></select></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>计划开始</span><input type="date" name="planned_start"></div>
      <div class="form-row"><span>计划完成</span><input type="date" name="planned_finish"></div>
    </div>
    <div class="form-row"><span>备注</span><textarea name="notes" rows="2"></textarea></div>
  `, async (data) => {
    await API.post('/v1/mfg/work-orders', data);
    toast('工单已创建');
    loadManufacturingData();
  });
  fillSelect('wo-part', '/v1/mfg/parts?limit=200', p => p.kind === 'product' ? `<option value="${esc(p.id)}">${esc(p.part_number)} · ${esc(p.name)}</option>` : '', '请选择产品');
}

function openCreateEquipmentModal() {
  Modal.show('登记设备', `
    <div class="form-row"><span>设备名称 <i class="req">*</i></span><input name="name" required placeholder="如：五轴加工中心 DMU-50"></div>
    <div class="form-cols">
      <div class="form-row"><span>设备编号</span><input name="asset_code" placeholder="留空自动生成"></div>
      <div class="form-row"><span>状态</span><select name="status"><option value="idle">空闲</option><option value="running">运行</option><option value="maintenance">保养中</option><option value="down">停机</option></select></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>厂商</span><input name="vendor"></div>
      <div class="form-row"><span>型号</span><input name="model"></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>工作中心</span><input name="work_center"></div>
      <div class="form-row"><span>安装位置</span><input name="location"></div>
    </div>
  `, async (data) => {
    await API.post('/v1/equipment/assets', data);
    toast('设备已登记');
    loadEquipmentData();
  });
}

function openCreateInspectionModal() {
  Modal.show('新建检验单', `
    <div class="form-cols">
      <div class="form-row"><span>检验类型 <i class="req">*</i></span><select name="inspection_type"><option value="incoming">来料检验</option><option value="in_process">过程检验</option><option value="final">出货检验</option></select></div>
      <div class="form-row"><span>物料</span><select name="part_id" id="qc-part"><option value="">加载物料中…</option></select></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>送检数量</span><input type="number" name="total_quantity" min="0" value="0"></div>
      <div class="form-row"><span>抽样数量</span><input type="number" name="sample_quantity" min="0" value="0"></div>
    </div>
    <div class="form-row"><span>备注</span><textarea name="note" rows="2"></textarea></div>
  `, async (data) => {
    await API.post('/v1/qms/inspections', data);
    toast('检验单已创建');
    loadQualityData();
  });
  fillSelect('qc-part', '/v1/mfg/parts?limit=200', p => `<option value="${esc(p.id)}">${esc(p.part_number)} · ${esc(p.name)}</option>`, '请选择物料');
}

function openCreateSalesOrderModal() {
  Modal.show('新建销售订单', `
    <div class="form-row"><span>客户 <i class="req">*</i></span><select name="account_id" id="so-account" required><option value="">加载客户中…</option></select></div>
    <div class="form-row"><span>产品 <i class="req">*</i></span><select name="part_id" id="so-part" required><option value="">加载产品中…</option></select></div>
    <div class="form-cols">
      <div class="form-row"><span>数量 <i class="req">*</i></span><input type="number" name="quantity" min="1" required></div>
      <div class="form-row"><span>单价（元）<i class="req">*</i></span><input type="number" name="unit_price_yuan" min="0" step="0.01" required></div>
    </div>
    <div class="form-cols">
      <div class="form-row"><span>下单日期</span><input type="date" name="order_date"></div>
      <div class="form-row"><span>要求交期</span><input type="date" name="requested_delivery_date"></div>
    </div>
    <div class="form-row"><span>备注</span><textarea name="notes" rows="2"></textarea></div>
  `, async (data) => {
    await API.post('/v1/sales/orders', {
      account_id: data.account_id, order_date: data.order_date, requested_delivery_date: data.requested_delivery_date, notes: data.notes,
      lines: [{ part_id: data.part_id, quantity: Number(data.quantity), unit_price_cents: Math.round((Number(data.unit_price_yuan) || 0) * 100) }],
    });
    toast('销售订单已创建');
    loadSalesData();
  });
  fillSelect('so-account', '/v1/crm/accounts?limit=200', a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`, '请选择客户');
  fillSelect('so-part', '/v1/mfg/parts?limit=200', p => p.kind === 'product' ? `<option value="${esc(p.id)}">${esc(p.part_number)} · ${esc(p.name)}</option>` : '', '请选择产品');
}

function openCreateSupplyModal() {
  if (_scTab === 'requisitions') {
    Modal.show('新建请购单', `
      <div class="form-row"><span>物料 <i class="req">*</i></span><select name="part_id" id="pr-part" required><option value="">加载物料中…</option></select></div>
      <div class="form-cols">
        <div class="form-row"><span>数量 <i class="req">*</i></span><input type="number" name="quantity" min="1" required></div>
        <div class="form-row"><span>预计单价（元）</span><input type="number" name="price_yuan" min="0" step="0.01"></div>
      </div>
      <div class="form-cols">
        <div class="form-row"><span>需求日期</span><input type="date" name="need_date"></div>
        <div class="form-row"><span>原因</span><input name="reason" placeholder="补库 / 项目用料"></div>
      </div>
      <p style="font-size:9px;color:var(--muted)">创建后自动提交审批（采购经理/财务）。</p>
    `, async (data) => {
      const pr = await API.post('/v1/purchase/requisitions', {
        need_date: data.need_date, reason: data.reason,
        lines: [{ part_id: data.part_id, quantity: Number(data.quantity), expected_unit_price_cents: Math.round((Number(data.price_yuan) || 0) * 100) }],
      });
      if (pr?.id) await API.post(`/v1/purchase/requisitions/${pr.id}/submit`, {});
      toast('请购单已创建并提交审批');
      loadSupplychainData();
    });
    fillSelect('pr-part', '/v1/mfg/parts?limit=200', p => `<option value="${esc(p.id)}">${esc(p.part_number)} · ${esc(p.name)}</option>`, '请选择物料');
  } else {
    Modal.show('新建采购订单', `
      <div class="form-row"><span>供应商 <i class="req">*</i></span><select name="supplier_id" id="po-supplier" required><option value="">加载供应商中…</option></select></div>
      <div class="form-row"><span>物料 <i class="req">*</i></span><select name="part_id" id="po-part" required><option value="">加载物料中…</option></select></div>
      <div class="form-cols">
        <div class="form-row"><span>数量 <i class="req">*</i></span><input type="number" name="quantity" min="1" required></div>
        <div class="form-row"><span>单价（元）<i class="req">*</i></span><input type="number" name="unit_price_yuan" min="0" step="0.01" required></div>
      </div>
      <div class="form-cols">
        <div class="form-row"><span>下单日期</span><input type="date" name="order_date"></div>
        <div class="form-row"><span>预计到货</span><input type="date" name="expected_delivery_date"></div>
      </div>
    `, async (data) => {
      await API.post('/v1/purchase/orders', {
        supplier_id: data.supplier_id, order_date: data.order_date, expected_delivery_date: data.expected_delivery_date,
        lines: [{ part_id: data.part_id, quantity: Number(data.quantity), unit_price_cents: Math.round((Number(data.unit_price_yuan) || 0) * 100) }],
      });
      toast('采购订单已创建');
      loadSupplychainData();
    });
    fillSelect('po-supplier', '/v1/purchase/suppliers?limit=200', s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`, '请选择供应商');
    fillSelect('po-part', '/v1/mfg/parts?limit=200', p => `<option value="${esc(p.id)}">${esc(p.part_number)} · ${esc(p.name)}</option>`, '请选择物料');
  }
}

const moduleCreateHandlers = {
  projects: openCreateProjectModal,
  knowledge: openCreateKnowledgeModal,
  contracts: openCreateContractModal,
  dev: openCreateDevModal,
  manufacturing: openCreateWorkOrderModal,
  supplychain: openCreateSupplyModal,
  quality: openCreateInspectionModal,
  equipment: openCreateEquipmentModal,
  sales: openCreateSalesOrderModal,
  crm: () => {
    if (_crmTab === 'accounts') {
      Modal.show('新建客户档案', `
        <div class="form-row"><span>客户名称 <i class="req">*</i></span><input name="name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>行业</span><select name="industry"><option value="">请选择</option><option value="retail">零售</option><option value="tech">科技</option><option value="manufacturing">制造</option><option value="finance">金融</option><option value="healthcare">医疗</option><option value="education">教育</option><option value="real_estate">房地产</option><option value="other">其他</option></select></div>
          <div class="form-row"><span>规模</span><select name="company_size"><option value="">请选择</option><option value="1-50">1-50人</option><option value="51-200">51-200人</option><option value="201-1000">201-1000人</option><option value="1000+">1000人以上</option></select></div>
        </div>
        <div class="form-row"><span>网站</span><input name="website" placeholder="https://…"></div>
        <div class="form-row"><span>年收入（元）</span><input type="number" name="revenue_yuan" min="0"></div>
        ${PersonPicker.html('owner_person_id','客户负责人')}
      `, async (data) => {
        await API.post('/v1/crm/accounts', { name: data.name, industry: data.industry, company_size: data.company_size, website: data.website, annual_revenue_cents: data.revenue_yuan ? data.revenue_yuan*100 : null, owner_person_id: data.owner_person_id });
        toast('客户档案已创建'); loadCRMData();
      });
    } else {
      Modal.show('新建商机', `
        <div class="form-row"><span>商机名称 <i class="req">*</i></span><input name="name" required></div>
        <div class="form-row"><span>客户名称 <i class="req">*</i></span><input name="customer_name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>金额（元）</span><input type="number" name="amount_yuan" min="0"></div>
          <div class="form-row"><span>赢单概率(%)</span><input type="number" name="win_probability" value="60" min="0" max="100"></div>
        </div>
        <div class="form-row"><span>预计签约日期</span><input type="date" name="expected_close_date"></div>
        ${PersonPicker.html('owner_person_id','销售负责人')}
      `, async (data) => {
        await API.post('/v1/crm/opportunities', { name: data.name, customer_name: data.customer_name, amount_cents: (data.amount_yuan||0)*100, win_probability: data.win_probability, expected_close_date: data.expected_close_date, owner_person_id: data.owner_person_id });
        toast('商机已创建'); loadCRMData();
      });
    }
  },
  hr: () => {
    if (_hrTab === 'roster') {
      Modal.show('新增员工', `
        <div class="form-row"><span>姓名 <i class="req">*</i></span><input name="display_name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>工号</span><input name="employee_number" placeholder="如 EMP-001"></div>
          <div class="form-row"><span>雇佣类型</span><select name="employment_type">
            ${Object.entries(EMP_TYPE).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
          </select></div>
        </div>
        <div class="form-row"><span>邮箱</span><input type="email" name="primary_email"></div>
        <div class="form-row"><span>手机</span><input name="mobile" placeholder="1xx xxxx xxxx"></div>
        <div class="form-cols">
          <div class="form-row"><span>入职日期 <i class="req">*</i></span><input type="date" name="start_date" required value="${new Date().toISOString().slice(0,10)}"></div>
          <div class="form-row"><span>试用期截止</span><input type="date" name="probation_end_date"></div>
        </div>
        <div class="form-row"><span>办公地点</span><input name="work_location" placeholder="北京总部 / 上海分公司 / 远程"></div>
        ${PersonPicker.html('manager_person_id','直属上级')}
        <p style="font-size:8px;color:var(--muted);padding:8px;background:var(--jade-soft);border-radius:6px">入职后可在员工详情中添加合同、设置部门和职位。</p>
      `, async (data) => {
        await API.post('/v1/hr/employees', data);
        toast('员工已入职'); loadHRData();
      });
    } else if (_hrTab === 'leave') {
      Modal.show('申请假期', `
        <div class="form-row"><span>假期类型 <i class="req">*</i></span><select name="leave_type">
          ${Object.entries(LEAVE_TYPE).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
        </select></div>
        <div class="form-cols">
          <div class="form-row"><span>开始日期 <i class="req">*</i></span><input type="date" name="start_date" required></div>
          <div class="form-row"><span>结束日期 <i class="req">*</i></span><input type="date" name="end_date" required></div>
        </div>
        <div class="form-row"><span>天数 <i class="req">*</i></span><input type="number" name="days" min="0.5" step="0.5" required></div>
        <div class="form-row"><span>请假原因</span><textarea name="reason" rows="2"></textarea></div>
        <p style="font-size:8px;color:var(--muted);margin-top:4px">提交后将通知审批人（飞书配置后自动推送飞书消息）</p>
      `, async (data) => {
        await API.post('/v1/hr/leave-requests', data);
        toast('请假申请已提交'); loadHRData();
      });
    } else {
      Modal.show('发起招聘需求', `
        <div class="form-row"><span>岗位名称 <i class="req">*</i></span><input name="title" required></div>
        <div class="form-cols">
          <div class="form-row"><span>需求人数</span><input type="number" name="headcount" value="1" min="1"></div>
          <div class="form-row"><span>期望入职</span><input type="date" name="expected_start_date"></div>
        </div>
        <div class="form-row"><span>招聘原因</span><textarea name="reason" rows="3" placeholder="业务扩张 / 人员离职替补 / 新项目…"></textarea></div>
        <div class="form-row"><span>岗位职责</span><textarea name="description" rows="4" placeholder="主要职责与要求…"></textarea></div>
        ${PersonPicker.html('owner_person_id','招聘负责人')}
      `, async (data) => {
        await API.post('/v1/hr/requisitions', data);
        toast('招聘需求已创建'); loadHRData();
      });
    }
  },
  finance: () => {
    const finTabActions = {
      expenses: () => Modal.show('提交报销', `
        <div class="form-row"><span>报销类别 <i class="req">*</i></span><select name="category">
          ${Object.entries(EXP_CAT).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
        </select></div>
        <div class="form-cols">
          <div class="form-row"><span>金额（元）<i class="req">*</i></span><input type="number" name="amount_yuan" required min="0" step="0.01"></div>
          <div class="form-row"><span>发生日期</span><input type="date" name="expense_date"></div>
        </div>
        <div class="form-row"><span>说明</span><input name="description" placeholder="费用说明"></div>
        <p style="font-size:8px;padding:8px;background:var(--jade-soft);border-radius:6px;color:var(--jade)">提交后将发送飞书消息给审批人（需配置飞书）</p>
      `, async (data) => {
        await API.post('/v1/finance/expenses', { category: data.category, amount_cents: Math.round((data.amount_yuan||0)*100), expense_date: data.expense_date, description: data.description });
        toast('报销申请已提交'); loadFinanceData();
      }),
      budgets: () => Modal.show('设置预算', `
        <div class="form-row"><span>预算类别 <i class="req">*</i></span><select name="category">
          ${Object.entries(EXP_CAT).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
        </select></div>
        <div class="form-cols">
          <div class="form-row"><span>年度 <i class="req">*</i></span><input type="number" name="period_year" value="${new Date().getFullYear()}" required></div>
          <div class="form-row"><span>季度（可选）</span><select name="period_quarter"><option value="">全年</option><option value="1">Q1</option><option value="2">Q2</option><option value="3">Q3</option><option value="4">Q4</option></select></div>
        </div>
        <div class="form-row"><span>预算金额（元）<i class="req">*</i></span><input type="number" name="amount_yuan" required min="0"></div>
      `, async (data) => {
        await API.post('/v1/finance/budgets', { category: data.category, period_year: data.period_year, period_quarter: data.period_quarter || null, total_amount_cents: Math.round((data.amount_yuan||0)*100) });
        toast('预算已设置'); loadFinanceData();
      }),
      invoices: () => Modal.show('新建发票', `
        <div class="form-row"><span>发票类型</span><select name="invoice_type"><option value="receivable">应收（客户付款）</option><option value="payable">应付（我方付款）</option></select></div>
        <div class="form-row"><span>对方名称 <i class="req">*</i></span><input name="counterparty_name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>金额（元）<i class="req">*</i></span><input type="number" name="amount_yuan" required min="0"></div>
          <div class="form-row"><span>到期日</span><input type="date" name="due_date"></div>
        </div>
        <div class="form-row"><span>发票号</span><input name="invoice_number"></div>
      `, async (data) => {
        await API.post('/v1/finance/invoices', { invoice_type: data.invoice_type, counterparty_name: data.counterparty_name, amount_cents: Math.round((data.amount_yuan||0)*100), due_date: data.due_date, invoice_number: data.invoice_number });
        toast('发票已创建'); loadFinanceData();
      }),
      payments: () => Modal.show('新建收款计划', `
        <div class="form-row"><span>客户名称 <i class="req">*</i></span><input name="customer_name" required></div>
        <div class="form-row"><span>里程碑 <i class="req">*</i></span><input name="milestone" required placeholder="合同签署首款 / 项目验收尾款…"></div>
        <div class="form-cols">
          <div class="form-row"><span>金额（元）<i class="req">*</i></span><input type="number" name="amount_yuan" required min="0"></div>
          <div class="form-row"><span>预计到账 <i class="req">*</i></span><input type="date" name="due_date" required></div>
        </div>
      `, async (data) => {
        await API.post('/v1/finance/payments', { customer_name: data.customer_name, milestone: data.milestone, amount_cents: Math.round((data.amount_yuan||0)*100), due_date: data.due_date });
        toast('收款计划已创建'); loadFinanceData();
      })
    };
    (finTabActions[_financeTab] || finTabActions.expenses)();
  },
  it: () => {
    const itTabActions = {
      vendors: () => Modal.show('新建供应商', `
        <div class="form-row"><span>供应商名称 <i class="req">*</i></span><input name="name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>类别</span><select name="category">
            ${Object.entries(VENDOR_CAT).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
          </select></div>
          <div class="form-row"><span>SLA响应（小时）</span><input type="number" name="sla_response_hours" placeholder="4" min="1"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>联系人</span><input name="contact_name"></div>
          <div class="form-row"><span>联系邮件</span><input type="email" name="contact_email"></div>
        </div>
        <div class="form-row"><span>联系电话</span><input name="contact_phone"></div>
        <div class="form-row"><span>网站</span><input name="website" placeholder="https://…"></div>
        <div class="form-cols">
          <div class="form-row"><span>合同金额（元）</span><input type="number" name="contract_yuan" min="0"></div>
          <div class="form-row"><span>合同到期</span><input type="date" name="contract_end_date"></div>
        </div>
      `, async (data) => {
        await API.post('/v1/it/vendors', { ...data, contract_value_cents: data.contract_yuan ? data.contract_yuan*100 : null });
        toast('供应商已添加'); loadITData();
      }),
      assets: () => Modal.show('登记资产', `
        <div class="form-row"><span>资产名称 <i class="req">*</i></span><input name="name" required></div>
        <div class="form-row"><span>类别 <i class="req">*</i></span><select name="category">
          <option value="hardware">硬件</option><option value="software">软件</option>
          <option value="saas">SaaS订阅</option><option value="network">网络</option>
          <option value="certificate">证书/域名</option><option value="other">其他</option>
        </select></div>
        <div class="form-cols">
          <div class="form-row"><span>厂商</span><input name="vendor"></div>
          <div class="form-row"><span>型号</span><input name="model"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>购买日期</span><input type="date" name="purchase_date"></div>
          <div class="form-row"><span>许可到期</span><input type="date" name="license_expires_at"></div>
        </div>
        <div class="form-row"><span>位置</span><input name="location"></div>
        ${PersonPicker.html('assigned_person_id','分配给')}
      `, async (data) => {
        await API.post('/v1/it/assets', data);
        toast('资产已登记'); loadITData();
      }),
      tickets: () => Modal.show('提交服务工单', `
        <div class="form-row"><span>问题标题 <i class="req">*</i></span><input name="title" required placeholder="简洁描述问题"></div>
        <div class="form-row"><span>类别</span><select name="category">
          <option value="hardware">硬件问题</option><option value="software">软件问题</option>
          <option value="account">账号权限</option><option value="network">网络问题</option>
          <option value="other">其他</option>
        </select></div>
        <div class="form-row"><span>优先级</span><select name="priority"><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select></div>
        <div class="form-row"><span>详细描述</span><textarea name="description" rows="4" placeholder="详细说明问题现象和影响范围…"></textarea></div>
      `, async (data) => {
        await API.post('/v1/it/tickets', data);
        toast('工单已提交'); loadITData();
      }),
      licenses: () => Modal.show('登记软件许可', `
        <div class="form-row"><span>软件名称 <i class="req">*</i></span><input name="software_name" required></div>
        <div class="form-cols">
          <div class="form-row"><span>厂商</span><input name="vendor"></div>
          <div class="form-row"><span>许可类型</span><select name="license_type"><option value="subscription">订阅</option><option value="perpetual">永久</option><option value="per_seat">按席位</option><option value="volume">批量</option></select></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><span>总席位数</span><input type="number" name="total_seats" value="1" min="1"></div>
          <div class="form-row"><span>到期日</span><input type="date" name="expiry_date"></div>
        </div>
        <div class="form-row"><span>年费/续费（元）</span><input type="number" name="renewal_yuan" min="0"></div>
      `, async (data) => {
        await API.post('/v1/it/licenses', { software_name: data.software_name, vendor: data.vendor, license_type: data.license_type, total_seats: data.total_seats, expiry_date: data.expiry_date, renewal_cost_cents: data.renewal_yuan ? data.renewal_yuan*100 : null });
        toast('许可证已登记'); loadITData();
      })
    };
    (itTabActions[_itTab] || itTabActions.assets)();
  },
  knowledge: () => Modal.show('新建知识条目', `
    <div class="form-row"><span>标题 <i class="req">*</i></span><input name="title" required></div>
    <div class="form-row"><span>内容</span><textarea name="content" rows="6" placeholder="支持 Markdown 格式，可留空后续填写"></textarea></div>
    <div class="form-cols">
      <div class="form-row"><span>类型</span><select name="content_type"><option value="markdown">Markdown</option><option value="link">链接</option><option value="feishu_doc">飞书文档</option><option value="pdf">PDF</option></select></div>
      <div class="form-row"><span>权限</span><select name="classification"><option value="internal">内部</option><option value="public">公开</option><option value="confidential">保密</option></select></div>
    </div>
    <div class="form-row"><span>来源链接</span><input name="source_url" placeholder="https://…"></div>
    <div class="form-row"><span>标签（空格分隔）</span><input name="tags_input" placeholder="运营 规范 2026"></div>
  `, async (data) => {
    const tags = (data.tags_input||'').split(/[\s,]+/).filter(Boolean);
    await API.post('/v1/knowledge/items', { title: data.title, content: data.content, content_type: data.content_type, classification: data.classification, source_url: data.source_url, tags });
    toast('知识条目已创建'); loadKnowledgeData();
  }),
  strategy: () => openCreatePeriodModal()
};

// ──────────────────────────────────────────────────────────────
// 全局暴露（供 app.js 和 HTML 内联事件使用）
// ──────────────────────────────────────────────────────────────
window.openCandidateDetail = openCandidateDetail;
window.updateCandidateStatus = updateCandidateStatus;
window.openAddCandidateModal = openAddCandidateModal;
window.openAddContactModal = openAddContactModal;
window.openAddActivityModal = openAddActivityModal;
window.openCreateOfferModal = openCreateOfferModal;
window.openRequisitionDetail = openRequisitionDetail;
window.openKRDetail = openKRDetail;
window.openCheckinModal = openCheckinModal;
window.openCreateInitiativeModal = openCreateInitiativeModal;
window.loadStrategyData = loadStrategyData;

window.FeishuHQ = {
  API, Modal, Drawer, toast, esc, money,
  sendAIMessage, moduleDataLoaders, moduleCreateHandlers, handleModuleAIAnalysis, wireMetricDrills,
  prefetch: (paths) => Promise.allSettled((paths || []).map(path => API.get(path))),
  invalidateCache: (all = false) => { API._apiGen++; API._getCache.clear(); API._clearLocal(all); },
  PersonPicker, getDevTab: () => _devTab, getSupplyTab: () => _scTab
};

// ═══ AI 治理（docs/19）：定时任务 / 我的工具 / 管理员审计 / 组织与个人全景 ═══
async function loadAIData() {
  const wrap = document.querySelector('#ai-schedules');
  if (!wrap) return;
  // 重新进入 AI 页面时开新对话；历史对话仍可从“历史对话”恢复。
  if (!document.querySelector('#ai-main-flow .user-message')) currentConversationId = null;
  let tools = [], schedules = [];
  try {
    [tools, schedules] = await Promise.all([
      API.get('/v1/ai/tools').then(r => r.items || []),
      API.get('/v1/ai/schedules').then(r => r.items || []),
    ]);
  } catch {}
  const writeTools = tools.filter(t => t.risk_level === 'L2');
  API.get('/v1/ai/status').then(status => {
    const banner = document.getElementById('ai-status-banner');
    if (!banner) return;
    if (status.configured) {
      banner.className = 'ai-status-banner';
      banner.innerHTML = `已连接 <b>${esc(status.model || 'AI 模型')}</b> · 只会读取你有权限的数据 · 单次最长 ${Math.round((status.timeout_ms || 45000) / 1000)} 秒`;
    } else {
      banner.className = 'ai-status-banner warn';
      banner.innerHTML = `AI 模型尚未配置，当前只能浏览界面，无法生成回答。请联系管理员在部署环境设置 <code>MODEL_API_KEY</code>（可选 <code>MODEL_BASE_URL</code> / <code>MODEL_NAME</code>）。`;
    }
  }).catch(() => {
    const banner = document.getElementById('ai-status-banner');
    if (banner) { banner.className = 'ai-status-banner warn'; banner.textContent = '无法获取 AI 状态，请检查网络或联系管理员。'; }
  });
  const list = !schedules.length
    ? '<p style="font-size:10px;color:var(--muted);padding:8px 14px">还没有定时任务。让 AI 每天早上自动查一次库存/账龄，或每周一生成经营周报。</p>'
    : `<table class="data-table"><thead><tr><th>名称</th><th>工具</th><th>间隔</th><th>下次运行</th><th>已运行</th><th>状态</th><th>操作</th></tr></thead><tbody>${
        schedules.map(sch => `<tr>
          <td><b>${esc(sch.name)}</b></td><td><code style="font-size:9px">${esc(sch.tool_name)}</code></td>
          <td>每 ${sch.interval_minutes} 分钟</td><td>${sch.next_run_at ? new Date(sch.next_run_at).toLocaleString('zh-CN') : '—'}</td>
          <td>${sch.run_count} 次</td>
          <td><span class="status-pill ${sch.status === 'active' ? '' : 'warning'}">${sch.status === 'active' ? '运行中' : '已暂停'}</span></td>
          <td><button data-schedule-toggle="${esc(sch.id)}" data-next="${sch.status === 'active' ? 'paused' : 'active'}" style="font-size:9px;color:var(--blue);background:none;border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer">${sch.status === 'active' ? '暂停' : '恢复'}</button>
              <button data-schedule-del="${esc(sch.id)}" style="font-size:9px;color:var(--red);background:none;border:1px solid var(--line);border-radius:6px;padding:3px 8px;cursor:pointer;margin-left:4px">删除</button></td>
        </tr>`).join('')}</tbody></table>`;
  wrap.innerHTML = `<header class="panel-head"><div><span class="section-kicker">SCHEDULED AI</span><h2>定时任务（AI 主动办事）</h2></div><button data-ai-schedule-new type="button">新建定时任务 ＋</button></header>
    ${list}<p style="font-size:9px;color:var(--muted);padding:8px 14px">以你的身份、你的权限定时执行；权限被回收任务自动停摆；管理员可在「管理设置 → AI 使用审计」查看全员使用。</p>`;
}

function resetAIChat() {
  currentConversationId = null;
  const flow = document.querySelector('#ai-main-flow');
  if (flow) {
    flow.innerHTML = `<div class="assistant-message ai-welcome-message"><span class="ai-orb">✦</span><p>新对话已开始。可以问我经营数据、项目风险、回款、审批，或让我起草一份分析。</p></div>`;
  }
  document.querySelector('.hero-composer textarea')?.focus();
}

async function openAIHistory() {
  let items = [];
  try { items = (await API.get('/v1/ai/conversations')).items || []; } catch (e) { toast('历史对话加载失败：' + e.message, 'error'); return; }
  Modal.show('历史对话', items.length ? `<div style="display:flex;flex-direction:column;gap:6px">
    ${items.map(c => `<button type="button" onclick="window.openAIConversation('${esc(c.id)}')" style="text-align:left;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);cursor:pointer">
      <b style="font-size:10px">${esc(c.title || c.first_message || '未命名对话')}</b>
      <span style="display:block;margin-top:3px;color:var(--muted);font-size:9px">${new Date(c.created_at).toLocaleString('zh-CN')} · ${c.message_count} 条消息</span>
    </button>`).join('')}</div>` : '<p class="empty-hint" style="padding:16px">还没有历史对话，先在下方问一个问题。</p>', null, { hideSubmit: true });
}

window.openAIConversation = async (id) => {
  try {
    const { items } = await API.get(`/v1/ai/conversations/${id}/messages`);
    Modal.hide();
    currentConversationId = id;
    const flow = document.querySelector('#ai-main-flow');
    if (!flow) return;
    flow.innerHTML = '';
    for (const m of items || []) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (!m.content) continue;
      const bubble = document.createElement('div');
      bubble.className = m.role === 'user' ? 'user-message' : 'assistant-message';
      const cits = Array.isArray(m.citations) ? m.citations : [];
      bubble.innerHTML = `<p>${m.role === 'user' ? esc(m.content) : aiText(m.content)}</p>${m.role === 'assistant' ? `<div class="ai-citations">${cits.map(c => `<button type="button" class="ai-citation" data-ai-citation="${esc(c.type)}" data-ai-id="${esc(c.id)}">${esc(c.title)} ↗</button>`).join('')}</div>` : ''}`;
      flow.append(bubble);
    }
    flow.closest('.ai-thread-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast('对话加载失败：' + e.message, 'error'); }
};

function showAIManageAgents() {
  Modal.show('我的智能体', `<div style="font-size:10px;line-height:1.8;color:var(--muted)">
    <p>当前提供 3 个内置智能体，运行时会以你的身份和权限取数：</p>
    <p><b style="color:var(--ink)">销售参谋</b>：漏斗、重点商机、本周跟进清单</p>
    <p><b style="color:var(--ink)">项目督导</b>：交付风险、责任人、本周动作</p>
    <p><b style="color:var(--ink)">招聘助手</b>：开放职位、候选人阶段、卡点</p>
    <p>定时任务可在 AI 总部下方创建；权限被回收后任务会自动停摆。</p>
  </div>`, null, { hideSubmit: true });
}

async function showAIPermissionLog() {
  try {
    const { items } = await API.get('/v1/ai/tools');
    Modal.show('AI 可调用的工具', `<div style="font-size:9px;color:var(--muted);margin-bottom:8px">这些工具都经过与你的账号相同的权限校验；写操作仍受审批/确认约束。</div>
      <div style="max-height:360px;overflow:auto"><table class="data-table"><thead><tr><th>工具</th><th>风险</th><th>动作</th></tr></thead><tbody>
      ${(items || []).map(t => `<tr><td><code style="font-size:9px">${esc(t.name)}</code></td><td>${esc(t.risk_level)}</td><td>${esc(t.action)}</td></tr>`).join('')}
      </tbody></table></div>`, null, { hideSubmit: true });
  } catch (e) { toast('权限记录加载失败：' + e.message, 'error'); }
}

function openAICitation(type, id) {
  if (type === 'project') return openProjectDetail(id);
  if (type === 'account') return openAccountDetail(id);
  if (type === 'opportunity') return openOpportunityDetail(id);
  if (type === 'contract') return openContractDetail(id);
  const path = { invoice: 'finance', knowledge: 'knowledge', work_order: 'manufacturing', purchase_order: 'supplychain', sales_order: 'sales', part: 'manufacturing' }[type] || 'overview';
  window.renderView?.(path);
  toast(`已定位到${type}模块，可搜索该记录`);
}

document.addEventListener('click', async event => {
  const citation = event.target.closest('[data-ai-citation]');
  if (citation) { openAICitation(citation.dataset.aiCitation, citation.dataset.aiId); return; }
  const promptBtn = event.target.closest('[data-ai-prompt], [data-agent-prompt]');
  if (promptBtn) {
    const prompt = promptBtn.dataset.aiPrompt || promptBtn.dataset.agentPrompt;
    if (prompt) sendAIMessage(prompt);
    return;
  }
  if (event.target.closest('#ai-new-chat')) { resetAIChat(); return; }
  if (event.target.closest('#ai-history-btn')) { openAIHistory(); return; }
  if (event.target.closest('#ai-manage-agents')) { showAIManageAgents(); return; }
  if (event.target.closest('#ai-permission-log')) { showAIPermissionLog(); return; }
  const retry = event.target.closest('[data-ai-retry]');
  if (retry) { sendAIMessage(retry.dataset.aiRetry); return; }
  const newBtn = event.target.closest('[data-ai-schedule-new]');
  if (newBtn) {
    try {
      const { items } = await API.get('/v1/ai/tools');
      const usable = items.filter(t => ['get_workspace_overview', 'query_finance', 'query_projects', 'query_crm', 'query_hr', 'search_knowledge', 'query_team_overview', 'queue_weekly_report'].includes(t.name));
      if (!usable.length) { showToast('当前没有可定时执行的工具', 'error'); return; }
      Modal.show('新建定时任务', `
        <div class="form-row"><span>让 AI 定时做什么 <i class="req">*</i></span><select name="tool_name" required>
          ${usable.map(t => `<option value="${esc(t.name)}">${esc(t.description || t.name)}</option>`).join('')}
        </select></div>
        <div class="form-row"><span>任务名称 <i class="req">*</i></span><input name="name" required placeholder="如：每天检查库存预警"></div>
        <div class="form-row"><span>执行频率</span><select name="interval_minutes">
          <option value="60">每小时</option><option value="1440" selected>每天</option><option value="10080">每周</option>
        </select></div>
        <p style="font-size:9px;color:var(--muted)">以你的身份、你的权限执行；权限被回收后任务自动停摆。</p>
      `, async (data) => {
        await API.post('/v1/ai/schedules', { name: data.name, tool_name: data.tool_name, args: {}, interval_minutes: Number(data.interval_minutes) || 1440 });
        showToast('定时任务已创建，到点自动以你的身份执行');
        loadAIData();
      });
    } catch (e) { showToast('创建失败：' + e.message, 'error'); }
    return;
  }
  const toggleBtn = event.target.closest('[data-schedule-toggle]');
  if (toggleBtn) {
    try {
      await API.patch(`/v1/ai/schedules/${toggleBtn.dataset.scheduleToggle}`, { status: toggleBtn.dataset.next });
      loadAIData();
    } catch (e) { showToast('操作失败：' + e.message, 'error'); }
    return;
  }
  const delBtn = event.target.closest('[data-schedule-del]');
  if (delBtn) {
    if (!confirm('删除该定时任务？')) return;
    try { await API.del(`/v1/ai/schedules/${delBtn.dataset.scheduleDel}`); loadAIData(); }
    catch (e) { showToast('删除失败：' + e.message, 'error'); }
  }
});

// ── 管理设置：AI 使用审计面板（仅管理员数据可达，其余视角静默隐藏）──
const _origLoadRbac = loadRbacPanel;
loadRbacPanel = async function () {
  await _origLoadRbac();
  const host = document.querySelector('#rbac-panel');
  if (!host) return;
  const audit = document.createElement('section');
  audit.className = 'panel';
  audit.style.cssText = 'margin:16px 0 20px;padding:16px';
  audit.innerHTML = '<div class="eyebrow" style="margin-bottom:10px"><span></span>AI 使用审计（全员）</div><p class="loading-text">加载中…</p>';
  host.after(audit);
  try {
    const u = await API.get('/v1/ai/admin/usage?days=30');
    const rows = (u.per_person || []).filter(p => p.tool_calls || p.conversations || p.denied_calls);
    audit.innerHTML = `<div class="eyebrow" style="margin-bottom:10px"><span></span>AI 使用审计（近 30 天 · 管理员）</div>
      <div style="font-size:10px;margin-bottom:10px">对话 ${rows.reduce((s, p) => s + Number(p.conversations), 0)} · 工具调用 ${rows.reduce((s, p) => s + Number(p.tool_calls), 0)} · <span style="color:var(--red)">被拒 ${u.denied_total}</span></div>
      ${rows.length ? `<table class="data-table"><thead><tr><th>人员</th><th>对话</th><th>工具调用</th><th>被拒</th></tr></thead><tbody>${
        rows.map(p => `<tr><td>${esc(p.person_name)}</td><td>${p.conversations}</td><td>${p.tool_calls}</td><td style="${Number(p.denied_calls) ? 'color:var(--red);font-weight:600' : ''}">${p.denied_calls}</td></tr>`).join('')}</tbody></table>` : '<p style="font-size:10px;color:var(--muted)">近 30 天暂无 AI 使用记录</p>'}
      <details style="margin-top:10px"><summary style="font-size:10px;cursor:pointer">最近工具调用明细（50 条）</summary>
      <div style="max-height:220px;overflow:auto;font-size:9px;color:var(--muted);line-height:1.7">${(u.recent_calls || []).map(c =>
        `<div>${new Date(c.created_at).toLocaleString('zh-CN')} · <b style="color:${c.outcome === 'success' ? 'var(--muted)' : 'var(--red)'}">${c.outcome}</b> · ${esc(c.tool_name || '')} · ${String(c.actor_id).replace('ai:', 'AI@').slice(0, 14)}…</div>`).join('') || '无'}</div></details>`;
  } catch { audit.remove(); }
};

// ── 组织全景：树 + 部门面板 + 我的团队 ──
async function loadOrgData() {
  const wrap = document.querySelector('#org-content');
  if (!wrap) return;
  wrap.innerHTML = '<p class="loading-text" style="padding:20px">正在生成组织全景…</p>';
  const stats = document.querySelectorAll('.module-metrics .metric-card strong');
  let tree, team, att = null;
  try {
    [tree, team] = await Promise.all([
      API.get('/v1/org/tree'),
      API.get('/v1/teams/my').catch(() => ({ members: [], totals: { headcount: 0, open_tasks: 0, done_30d: 0, open_defects: 0 } })),
    ]);
    try { att = await API.get('/v1/hr/attendance/calendar'); } catch {}
  } catch (e) { wrap.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; return; }
  if (stats[0]) stats[0].textContent = String(tree.total_units ?? 0);
  if (stats[1]) stats[1].textContent = '—';
  if (stats[2]) stats[2].textContent = String(team.totals?.headcount ?? 0);
  if (stats[3]) stats[3].textContent = att ? `出勤 ${att.present}` : '—';

  const renderNode = (node, depth) => `
    <div class="org-node" data-unit="${esc(node.id)}" style="padding:7px 10px;margin:3px 0 3px ${depth * 16}px;border:1px solid var(--line-soft);border-radius:8px;cursor:pointer;background:#fff">
      <b style="font-size:11px">${esc(node.name)}</b>
      <span style="font-size:9px;color:var(--muted);margin-left:6px">${esc(node.type)} · ${node.headcount} 人${node.manager ? ' · 主管 ' + esc(node.manager.name) : ''}</span>
    </div>${node.children.map(c => renderNode(c, depth + 1)).join('')}`;
  const treeHtml = (tree.roots || []).map(r => renderNode(r, 0)).join('') || '<p style="font-size:10px;color:var(--muted)">暂无组织数据（接入飞书后自动同步）</p>';
  const teamHtml = (team.members || []).length
    ? team.members.map(m => `<button data-panorama="${esc(m.person_id)}" style="width:100%;text-align:left;padding:8px;background:none;border:0;border-bottom:1px solid var(--line-soft);cursor:pointer">
        <b style="font-size:10px">${esc(m.display_name)}</b>
        <span style="font-size:9px;color:var(--muted);margin-left:6px">在途 ${m.open_tasks} · 近30天完成 ${m.done_30d} · 缺陷 ${m.open_defects}</span>
        <span style="float:right;font-size:9px;color:var(--blue)">全景 →</span></button>`).join('')
    : '<p style="font-size:10px;color:var(--muted)">你不是任何人的直属上级（或暂无下属数据）</p>';
  wrap.innerHTML = `<div style="padding:20px;display:grid;grid-template-columns:1.4fr 1fr;gap:14px">
    <div class="panel" style="padding:16px"><div class="eyebrow" style="margin-bottom:10px"><span></span>组织架构（与飞书一致 · 点击部门看全景）</div>
      <div style="max-height:520px;overflow:auto">${treeHtml}</div>
      <p style="font-size:9px;color:var(--muted);margin-top:8px">${esc(tree.source_note || '')}</p></div>
    <div>
      <div class="panel" style="padding:16px;margin-bottom:14px"><div class="eyebrow" style="margin-bottom:8px"><span></span>我的团队（直属）</div>
        <div style="font-size:10px;margin-bottom:6px">在途任务 ${team.totals?.open_tasks ?? 0} · 近30天完成 ${team.totals?.done_30d ?? 0} · 未结缺陷 ${team.totals?.open_defects ?? 0}</div>
        <div style="max-height:220px;overflow:auto">${teamHtml}</div></div>
      <div class="panel" id="org-unit-panel" style="padding:16px"><div class="eyebrow"><span></span>部门全景</div>
        <p style="font-size:10px;color:var(--muted);padding:8px 0">点击左侧任意部门查看聚合：成员在途/完成、项目数、考勤（主管/HR 可见细节）。</p></div>
    </div></div>`;
  wrap.querySelectorAll('[data-unit]').forEach(node => node.addEventListener('click', async () => {
    const panel = wrap.querySelector('#org-unit-panel');
    panel.innerHTML = '<p class="loading-text" style="padding:8px">加载部门全景…</p>';
    try {
      const d = await API.get(`/v1/org/units/${node.dataset.unit}/panorama`);
      panel.innerHTML = `<div class="eyebrow" style="margin-bottom:8px"><span></span>${esc(d.unit.name)}（${esc(d.unit.manager_name || '未设主管')}）</div>
        <div style="font-size:10px;margin-bottom:8px">在编 ${d.headcount} · 在途任务 ${d.totals.open_tasks} · 近30天完成 ${d.totals.done_30d} · 未结缺陷 ${d.totals.open_defects} · 项目 ${d.totals.active_projects}${d.attendance_this_month ? ` · 本月出勤 ${d.attendance_this_month.present_days} 天/补卡 ${d.attendance_this_month.makeup_days} 次` : ''}</div>
        ${d.members ? d.members.map(m => `<button data-panorama="${esc(m.person_id)}" style="width:100%;text-align:left;padding:6px;background:none;border:0;border-bottom:1px solid var(--line-soft);cursor:pointer">
            <b style="font-size:10px">${esc(m.display_name)}</b><span style="font-size:9px;color:var(--muted);margin-left:6px">在途 ${m.open_tasks} · 完成 ${m.done_30d} · 缺陷 ${m.open_defects}</span>
            <span style="float:right;font-size:9px;color:var(--blue)">全景 →</span></button>`).join('')
          : '<p style="font-size:9px;color:var(--muted)">成员明细需主管/HR/管理员视角</p>'}`;
      panel.querySelectorAll('[data-panorama]').forEach(b => b.addEventListener('click', () => openPanoramaModal(b.dataset.panorama)));
    } catch (e) { panel.innerHTML = `<p class="error-hint" style="padding:8px">加载失败：${esc(e.message)}</p>`; }
  }));
}

// ── 个人全景弹窗（self/主管/HR/管理员=full；同事=limited 公开面）──
let panoramaModal = null;
async function openPanoramaModal(personId) {
  if (!panoramaModal) {
    panoramaModal = document.createElement('div');
    panoramaModal.className = 'demo-modal panorama-modal';
    panoramaModal.innerHTML = `<button class="demo-modal-backdrop" aria-label="关闭"></button>
      <section role="dialog" aria-modal="true" aria-label="个人全景" style="max-width:720px">
      <header><div><small>PERSON 360°</small><h2 id="panorama-name">个人全景</h2></div>
      <button class="panorama-close" type="button" aria-label="关闭" style="background:none;border:0;font-size:18px;cursor:pointer;color:var(--muted)">×</button></header>
      <div class="panorama-wrap" style="padding:0 18px 18px;max-height:64vh;overflow:auto"></div></section>`;
    document.body.append(panoramaModal);
    panoramaModal.addEventListener('click', e => { if (e.target.closest('.demo-modal-backdrop,.panorama-close')) panoramaModal.classList.remove('open'); });
  }
  panoramaModal.classList.add('open');
  const wrap = panoramaModal.querySelector('.panorama-wrap');
  wrap.innerHTML = '<p class="loading-text" style="padding:20px">正在聚合这个人的全部工作足迹…</p>';
  let d;
  try { d = await API.get(`/v1/people/${personId}/panorama`); }
  catch (e) { wrap.innerHTML = `<p class="error-hint" style="padding:20px">加载失败：${esc(e.message)}</p>`; return; }
  panoramaModal.querySelector('#panorama-name').textContent = `${d.person.name} · ${d.person.org}${d.visibility === 'full' ? '' : '（公开视角）'}`;
  const blk = (title, inner) => `<div class="panel" style="padding:12px;margin-bottom:12px"><div class="eyebrow" style="margin-bottom:8px"><span></span>${esc(title)}</div>${inner}</div>`;
  const years = d.person.tenure_days != null ? (d.person.tenure_days / 365).toFixed(1) + ' 年' : '—';
  let html = `<div style="font-size:10px;color:var(--muted);margin-bottom:10px">${esc(d.person.email || '')} · 工号 ${esc(d.person.employee_number || '—')} · 司龄 ${years}</div>`;
  html += blk('OKR', (d.okr.key_results || []).length || (d.okr.initiatives || []).length
    ? (d.okr.key_results || []).map(k => `<div style="padding:4px 0;font-size:10px">🎯 ${esc(k.title)} <span style="color:var(--muted)">${k.progress}%${k.live_value != null ? ` · 实时 ${k.live_value}${k.live_unit || ''}` : ''}</span></div>`).join('')
      + (d.okr.initiatives || []).map(i => `<div style="padding:2px 0;font-size:9px;color:var(--muted)">↳ ${esc(i.title)}（${esc(i.status)}）</div>`).join('')
    : '<span style="font-size:10px;color:var(--muted)">暂无主持的 KR / 执行项</span>');
  html += blk('项目与任务', `<div style="font-size:10px;margin-bottom:6px">在途任务 <b>${d.projects.tasks_open}</b> · 近30天完成 <b>${d.projects.tasks_done_30d}</b> · 累计工时 <b>${Math.round(d.projects.total_hours)}h</b></div>`
    + (d.projects.items || []).map(p => `<div style="padding:3px 0;font-size:10px">${p.role === 'owner' ? '👑' : '·'} ${esc(p.name)} <span style="color:var(--muted)">${p.progress}%（${esc(p.status)}）</span></div>`).join(''));
  html += blk('研发', `<div style="font-size:10px">未结缺陷 <b>${d.delivery.defects_open}</b> · 近30天关闭 <b>${d.delivery.defects_closed_30d}</b> · 负责需求 <b>${d.delivery.requirements_owned}</b></div>`);
  if (d.visibility === 'full') {
    html += blk('审批', `<div style="font-size:10px">待我审批 <b>${d.approvals.waiting_me}</b> · 近期发起 ${(d.approvals.initiated || []).length} 件</div>`);
    html += blk('财务 / 考勤', `<div style="font-size:10px">本月报销 ${money(d.finance.month_cents)}（在途 ${money(d.finance.pending_cents)}） · 本月出勤 ${d.attendance_this_month.present_days} 天（补卡 ${d.attendance_this_month.makeup_days}）</div>`);
    html += blk('绩效', (d.reviews || []).length
      ? d.reviews.map(r => `<div style="font-size:10px;padding:2px 0">${esc(r.cycle)} · ${esc(r.status)}${r.overall_rating != null ? ` · 总分 <b>${Number(r.overall_rating).toFixed(2)}</b>` : ''}</div>`).join('')
      : '<span style="font-size:10px;color:var(--muted)">暂无考核记录</span>');
    html += blk('AI 使用', `<div style="font-size:10px">对话 ${d.ai_usage.conversations} 次 · AI 代为执行工具 ${d.ai_usage.tool_calls} 次</div>`);
  } else {
    html += '<p style="font-size:9px;color:var(--muted)">审批/财务/考勤/绩效/AI 详情仅本人、直属主管、HR 与管理员可见（数据最小化）</p>';
  }
  wrap.innerHTML = html;
}

document.addEventListener('click', event => {
  const btn = event.target.closest('[data-panorama]');
  if (btn) openPanoramaModal(btn.dataset.panorama);
});

// 统一委托：带名字参数的按钮不再拼 inline onclick，避免姓名中的引号逃逸。
document.addEventListener('click', event => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const { act, id, name } = el.dataset;
  const handlers = {
    'create-opp-account': () => openCreateOppForAccount(id, name),
    'create-offer': () => openCreateOfferModal(id, name),
    'edit-employee': () => openEditEmployeeModal(id, name),
    'transfer-employee': () => openTransferModal(id, name),
    'offboard-employee': () => openOffboardModal(id, name),
    'add-org-unit': () => openAddOrgUnitModal(id, name),
  };
  const fn = handlers[act];
  if (fn) { event.preventDefault(); fn(); }
});
