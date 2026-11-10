const sidebar = document.querySelector('.sidebar');
const aiRail = document.querySelector('.ai-rail');
const content = document.querySelector('#content');
const pageTitle = document.querySelector('#page-title');
const overviewMarkup = content.innerHTML;
let workspaceState = null;
let authStatus = { demoMode: true, feishu: { configured: false } };
let sessionState = null;
let demoState = { opportunities:[], projects:[], requisitions:[], payments:[], workflows:[] };

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}

// 说明：指标与表格均为骨架占位，真实数据由 api.js 的各模块 loader 拉取后覆盖。
// 此处只保留“标签/列名/按钮”等静态结构，不再写死任何业务数字或示例行。
const modules = {
  projects: {
    eyebrow: 'PROJECT COMMAND', title: '项目作战室', intro: '从目标、资源到交付风险，在一张图里看清所有项目。',
    action: '新建项目', stats: ['进行中项目', '整体健康度', '项目合同额', '团队负荷'],
    filters: ['全部项目', '我负责的', '有风险', '本周交付']
  },
  strategy: {
    eyebrow: 'STRATEGIC OKR', title: '战略 OKR', intro: '将公司使命拆解为可追踪的季度目标，让每个人的工作与战略方向保持对齐。',
    action: '新建 OKR 周期',
    stats: ['整体进度', '活跃目标', '关键结果', '综合置信度'],
    noTable: true
  },
  crm: {
    eyebrow: 'REVENUE ENGINE', title: '客户与销售', intro: '从第一条线索到回款，把增长过程变成可管理的流水线。', action: '新增商机',
    stats: ['销售漏斗', '活跃商机', '加权赢单率', '累计回款'], filters: ['全部商机', '方案阶段', '商务谈判', '等待签约']
  },
  hr: {
    eyebrow: 'PEOPLE & CULTURE', title: '人才与组织', intro: '让招聘、入职、绩效与员工服务围绕同一份组织数据运转。', action: '发起招聘',
    stats: ['在职员工', '开放职位', '候选人', '待转正'], filters: ['招聘看板', '员工名册', '入转调离', '组织洞察']
  },
  finance: {
    eyebrow: 'FINANCE CONTROL', title: '财务管理', intro: '预算、合同、收支和审批彼此联动，看清公司的钱。', action: '提交报销',
    stats: ['资金账户', '累计回款', '本月支出', '应收账款'], filters: ['资金总览', '应收', '应付', '待我审批']
  },
  it: {
    eyebrow: 'DIGITAL OPERATIONS', title: 'IT 与资产', intro: '统一管理账号、设备、软件、服务请求与安全风险。', action: '登记资产',
    stats: ['数字资产', '活跃账号', '服务可用性', '待处理工单'], filters: ['资产台账', '服务工单', '账号权限', '安全中心']
  },
  approvals: {
    eyebrow: 'APPROVAL CENTER', title: '审批中心', intro: '请假、报销、入职、离职、采购——所有跨系统审批在一个地方发起和处理。', action: null,
    stats: ['待我审批', '我发起的', '本月已通过', '审批流配置'],
    noTable: true
  },
  contracts: {
    eyebrow: 'CONTRACT & BILLING', title: '合同与订阅', intro: '起草、评审、签署到收款计划一站式管理；SaaS 订阅实时汇总 MRR/ARR。', action: '起草合同',
    stats: ['合同总额(签署)', '生效合同', 'MRR 月经常性收入', 'ARR 年化收入'], filters: ['全部合同', '草稿', '评审中', '已签署', '订阅管理']
  },
  dev: {
    eyebrow: 'ENGINEERING DELIVERY', title: '研发中心', intro: '需求池、缺陷、迭代燃尽与版本发布，软件交付全程可见。', action: '提需求',
    stats: ['需求池', '开放缺陷', '活跃迭代', '近30天发布'], filters: ['需求池', '缺陷跟踪', '迭代 Sprint', '版本发布']
  },
  org: {
    eyebrow: 'ORG PANORAMA', title: '组织全景', intro: '组织架构与飞书一致：从公司到部门到个人，逐层看清在发生什么（主管/HR 可见细节）。',
    action: null,
    stats: ['部门数', '在职成员', '我的团队', '本月出勤'],
    noTable: true
  },
  workbench: {
    eyebrow: 'MY WORKBENCH', title: '我的工作台', intro: '按岗位聚合：我的打卡、任务、请假与审批，加上岗位专属经营区块与快捷入口。',
    action: null,
    stats: ['待我审批', '我的开放任务', '7 天内到期', '今日打卡'],
    noTable: true
  },
  dashboard: {
    eyebrow: 'EXECUTIVE DASHBOARD', title: '高层看板', intro: '财务、销售、订阅、交付、制造与人力的一次性经营聚合（仅管理层可见）。',
    action: null,
    stats: ['本月回款', '本月支出', '待收应收', '待审批'],
    noTable: true
  },
  knowledge: {
    eyebrow: 'KNOWLEDGE LAKE', title: '知识与文件', intro: '飞书文档、业务数据和 NAS 文件统一编目，由权限安全地交给 AI。', action: '新建知识条目',
    stats: ['知识条目', '可检索覆盖率', '文件存储', '本周 AI 引用'], filters: ['全部知识', '飞书文档', 'NAS 文件', '业务记录']
  },
  manufacturing: {
    eyebrow: 'MANUFACTURING EXECUTION', title: '制造执行', intro: '工单、物料、BOM 与实时 KPI：把车间执行与经营数据接到同一条链上。',
    action: '新建工单', stats: ['未结工单', '在制数量', '质量良率', '准交率 OTD'], noTable: true
  },
  supplychain: {
    eyebrow: 'SUPPLY CHAIN', title: '供应链', intro: '请购 → 采购 → 收货 → 库存，价格、交期与安全库存一目了然。',
    action: '新建请购', stats: ['待审批 PR', '未结 PO', '供应商', '库存预警'], noTable: true
  },
  quality: {
    eyebrow: 'QUALITY MANAGEMENT', title: '质量管理', intro: '来料/过程/出货检验与不合格处置，质量结论直接联动库存。',
    action: '新建检验', stats: ['未结检验', '不合格 NCR', '本月判定', '供应商质量'], noTable: true
  },
  equipment: {
    eyebrow: 'EQUIPMENT & MAINTENANCE', title: '设备管理', intro: '设备台账、点检保养、停机与 OEE，减少非计划停机。',
    action: '登记设备', stats: ['设备总数', '待保养', '本月停机', 'OEE'], noTable: true
  },
  sales: {
    eyebrow: 'SALES ORDERS', title: '销售订单', intro: '订单确认、发货出库与毛利，和 CRM 商机、合同回款打通。',
    action: '新建订单', stats: ['本月订单', '待发货', '已发货', '订单毛利'], noTable: true
  }
};

function moduleMarkup(key, data) {
  const headers = key === 'projects' ? ['项目','负责人','进度','截止时间','状态','预算'] : ['事项','所属 / 说明','负责人','规模','阶段 / 状态','更新时间'];
  // 去写死：指标值/表格行均为占位，真实值由 api.js 的 loadXxxData 覆盖；无数据时保留“—/加载中”，不伪造。
  const filterLabel = f => String(f).replace(/\s+\d+\s*(条|个|项|人)?$/, '').trim();
  const tableSection = data.noTable
    ? `<section class="module-table-panel no-table-panel"><header class="table-toolbar"></header><div class="data-table-wrap" id="${key}-content" style="min-height:120px"><p class="loading-text" style="padding:20px">加载中…</p></div></section>`
    : `<section class="panel module-table-panel"><header class="table-toolbar"><div class="filter-tabs">${(data.filters||[]).map((f,i)=>`<button class="${i===0?'active':''}" type="button">${filterLabel(f)}</button>`).join('')}</div><div class="table-tools"><button type="button">⌕ 搜索</button><button type="button">⇅ 筛选</button><button type="button">⊞ 视图</button></div></header><div class="data-table-wrap"><table class="data-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${headers.length}"><p class="loading-text" style="padding:20px">正在加载真实数据…</p></td></tr></tbody></table></div><footer class="table-footer"><span data-role="row-count"></span><div><button type="button">←</button><b>1</b><button type="button">→</button></div></footer></section>`;
  const canCreate = Boolean(window.FeishuHQ?.moduleCreateHandlers?.[key]);
  const devActions = { requirements: '提需求', defects: '提缺陷', iterations: '新建迭代', versions: '新建版本' };
  const supplyActions = { requisitions: '新建请购', orders: '新建采购单' };
  const createLabel = key === 'dev' ? (devActions[window.FeishuHQ?.getDevTab?.()] || data.action)
    : key === 'supplychain' ? (supplyActions[window.FeishuHQ?.getSupplyTab?.()] || data.action)
    : data.action;
  const exportEntity = { projects: 'projects', crm: 'accounts', hr: 'employees', finance: 'expenses' }[key];
  const importEntity = { crm: 'accounts', hr: 'employees' }[key];
  return `<div class="module-page"><div class="module-hero"><div><div class="eyebrow"><span></span>${data.eyebrow}</div><h1>${data.title}</h1><p>${data.intro}</p></div><div class="welcome-actions">${exportEntity ? `<button class="btn ghost" type="button" data-export="${exportEntity}">导出 CSV</button>` : ''}${importEntity ? `<button class="btn ghost" type="button" data-import-template="${importEntity}">下载模板</button><button class="btn ghost" type="button" data-import="${importEntity}">导入 CSV</button>` : ''}${canCreate ? `<button class="btn primary module-create" type="button">＋ ${createLabel}</button>` : ''}</div></div>
  <section class="metric-grid module-metrics">${data.stats.map((label,i)=>`<article class="metric-card ${i===0?'revenue':''}"><div class="metric-top"><span>${esc(label)}</span></div><strong data-stat="${i}">—</strong></article>`).join('')}</section>
  ${tableSection}
  <section class="insight-bar"><span class="ai-orb">✦</span><div><small>AI 洞察</small><b data-role="module-insight">点击右上角「让 AI 深入分析」，将基于当前真实数据为你生成洞察。</b></div><button class="ask-ai" type="button" data-module="${key}">让 AI 深入分析 →</button></section></div>`;
}

function aiPageMarkup() {
  return `<div class="module-page ai-hq-page"><div class="module-hero"><div><div class="eyebrow"><span></span>ENTERPRISE INTELLIGENCE</div><h1>AI 总部</h1><p>在权限边界内理解全公司数据，并替你完成跨系统工作。</p></div><button class="btn ghost" type="button" id="ai-manage-agents">管理智能体</button></div>
  <section class="ai-command-center"><div class="ai-greeting"><div class="big-orb">✦</div><div><span>总部助理</span><h2>今天想从哪里开始？</h2><p>我已连接项目、销售、人事、财务、IT、知识库和飞书协作数据。</p></div></div>
    <form class="hero-composer" id="ai-hero-composer"><textarea aria-label="向 AI 总部提问" placeholder="例如：分析本月回款差距，并给销售负责人分别生成跟进任务"></textarea><div><span class="ai-data-note">数据来自你的权限范围</span><button type="submit">发送 ↑</button></div></form>
    <div class="prompt-grid">
      <button type="button" data-ai-prompt="生成本周管理层经营简报，汇总项目、销售、财务的关键变化，并给出三条行动建议"><span>经营分析</span><b>生成本周管理层经营简报</b><small>汇总项目、销售、财务关键变化</small></button>
      <button type="button" data-ai-prompt="分析当前延期项目的资源负荷，给出重新排期建议；如果需要调配，请说明需要谁审批"><span>跨系统执行</span><b>为延期项目重新安排资源</b><small>分析负荷并发起调配审批</small></button>
      <button type="button" data-ai-prompt="查找历史同类项目的经验与复盘，只引用我有权限查看的内容"><span>知识问答</span><b>查找历史同类项目经验</b><small>仅检索我有权限查看的内容</small></button>
    </div>
  </section>
  <section class="panel ai-thread-panel">
    <header class="panel-head"><div><span class="section-kicker">CONVERSATION</span><h2>与总部助理对话</h2></div><div class="ai-thread-actions"><button type="button" id="ai-history-btn">历史对话</button><button type="button" id="ai-new-chat">新对话</button></div></header>
    <div id="ai-status-banner" class="ai-status-banner"><span class="loading-text">正在检查 AI 连接…</span></div>
    <div class="chat-flow ai-main-flow" id="ai-main-flow">
      <div class="assistant-message ai-welcome-message"><span class="ai-orb">✦</span><p>你好，我是总部助理。可以问我经营数据、项目风险、回款、审批，或让我起草一份分析。</p></div>
    </div>
  </section>
  <section class="panel" id="ai-schedules" style="margin-bottom:16px"><header class="panel-head"><div><span class="section-kicker">SCHEDULED AI</span><h2>定时任务（AI 主动办事）</h2></div><button data-ai-schedule-new type="button">新建定时任务 ＋</button></header><p class="loading-text" style="padding:14px">加载中…</p></section>
  <div class="agent-grid"><section class="panel"><header class="panel-head"><div><span class="section-kicker">MY AGENTS</span><h2>我的智能体</h2></div><button type="button" data-ai-schedule-new>管理定时任务 →</button></header><div class="agent-list">
    <article><i>销</i><div><b>销售参谋</b><small>分析漏斗 · 跟进客户 · 生成周报</small></div><button type="button" class="agent-run" data-agent-prompt="分析当前销售漏斗：哪些商机最值得优先跟进？给出本周跟进清单和话术要点">运行 →</button></article>
    <article><i>项</i><div><b>项目督导</b><small>识别风险 · 催办任务 · 整理例会</small></div><button type="button" class="agent-run" data-agent-prompt="识别当前有交付风险的项目，列出风险点、责任人和本周应完成的动作">运行 →</button></article>
    <article><i>人</i><div><b>招聘助手</b><small>筛选简历 · 安排面试 · 生成评价</small></div><button type="button" class="agent-run" data-agent-prompt="汇总当前招聘进展：开放职位、候选人阶段、卡点，并给出下一步建议">运行 →</button></article>
  </div></section><section class="panel permission-card"><span class="section-kicker">SAFE BY DESIGN</span><h2>AI 与你拥有相同权限</h2><p>每一次读取和执行都会经过租户、角色、数据范围与敏感级别校验，并写入审计日志。</p><div><span>✓ 默认拒绝</span><span>✓ 全程留痕</span><span>✓ 高风险需确认</span></div><button type="button" id="ai-permission-log">查看 AI 权限记录 →</button></section></div></div>`;
}

function money(cents) { return `¥ ${Math.round(Number(cents||0)/100).toLocaleString('zh-CN')}`; }
function demoPageMarkup() {
  const latest = demoState.workflows?.[0];
  return `<div class="module-page demo-page"><div class="module-hero demo-hero"><div><div class="eyebrow"><span></span>GUIDED BUSINESS TOUR</div><h1>用一笔订单，跑通整家公司</h1><p>从赢得商机到项目立项、人才补充和首期收款，亲手体验总部 OS 如何消除系统割裂。</p></div><button class="btn primary start-demo-flow" type="button">开始跨模块演示 <span>→</span></button></div>
  <section class="demo-safety"><span>体验企业</span><b>可放心操作，全部数据与正式企业隔离</b><p>这里产生的内容均标记为演示数据，可随时一键重置。</p><button class="reset-demo" type="button">重置体验数据</button></section>
  <section class="demo-flow-map"><article class="sales"><i>01</i><span>◎</span><small>CRM</small><h3>赢得商机</h3><p>录入客户、金额与预计签约日</p></article><b>→</b><article class="delivery"><i>02</i><span>◫</span><small>项目</small><h3>自动立项</h3><p>继承客户、预算与交付周期</p></article><b>→</b><article class="talent"><i>03</i><span>♙</span><small>人才</small><h3>补充资源</h3><p>按项目缺口发起招聘需求</p></article><b>→</b><article class="cash"><i>04</i><span>¥</span><small>财务</small><h3>生成收款</h3><p>按合同金额安排首期款</p></article></section>
  <div class="demo-grid"><section class="panel demo-activity"><header class="panel-head"><div><span class="section-kicker">LIVE BUSINESS DATA</span><h2>演示业务记录</h2></div><em>${demoState.workflows.length} 条完整链路</em></header>${latest?`<article class="latest-flow"><div class="flow-success">✓</div><div><small>最近一次跨模块协作</small><h3>${esc(latest.summary.projectName)}</h3><p>${esc(latest.summary.customerName)} · 合同 ${money(Number(latest.summary.amountYuan)*100)} · 首期 ${money(Number(latest.summary.paymentYuan)*100)}</p></div><time>${new Date(latest.created_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></article>`:`<div class="demo-empty"><span>◇</span><h3>还没有你创建的业务链</h3><p>用 1 分钟完成一次真实的跨模块协作。</p><button class="start-demo-flow" type="button">创建第一条演示链路</button></div>`}<div class="demo-counts"><button data-view-jump="crm"><b>${demoState.opportunities.length}</b><span>商机</span></button><button data-view-jump="projects"><b>${demoState.projects.length}</b><span>项目</span></button><button data-view-jump="hr"><b>${demoState.requisitions.length}</b><span>招聘需求</span></button><button data-view-jump="finance"><b>${demoState.payments.length}</b><span>收款计划</span></button></div></section>
  <section class="panel demo-proof"><span class="section-kicker">WHAT HAPPENS</span><h2>一次提交，四个系统同步</h2><ol><li><i>✓</i><div><b>数据不是复制粘贴</b><p>客户、金额和项目关联由系统自动继承。</p></div></li><li><i>✓</i><div><b>权限仍然有效</b><p>每次读取都带租户边界，AI 也不能越权。</p></div></li><li><i>✓</i><div><b>全程留有证据</b><p>创建与重置都会写入不可混淆的审计事件。</p></div></li></ol></section></div></div>`;
}

function settingsPageMarkup() {
  const connections = workspaceState?.snapshot?.connections ?? [];
  const statusLabel = { connected:'已连接', configured:'已配置', awaiting_credentials:'等待凭据', planned:'计划接入' };
  const callbackUrl = authStatus.feishu.redirectUri || `${location.origin}/v1/feishu/callback`;
  const scopes = authStatus.feishu.requiredScopes || [];
  const canSync = authStatus.feishu.configured && sessionState?.mode === 'feishu' && workspaceState?.user?.role === 'tenant_admin';
  return `<div class="module-page settings-page"><div class="module-hero"><div><div class="eyebrow"><span></span>ADMINISTRATION</div><h1>管理设置</h1><p>统一管理企业、数据连接、成员权限和 AI 安全边界。</p></div></div>
  <section class="settings-grid"><article class="settings-summary"><span class="section-kicker">WORKSPACE</span><div class="settings-company"><i>${esc(workspaceState?.tenant?.name?.slice(0,1) || '未')}</i><div><h2>${esc(workspaceState?.tenant?.name || '体验企业')}</h2><p>${esc(workspaceState?.tenant?.code || '')} · ${workspaceState?.tenant?.memberCount ?? 0} 位成员</p></div></div><dl><div><dt>部署方式</dt><dd>由部署环境决定</dd></div><div><dt>数据区域</dt><dd>${esc(workspaceState?.tenant?.region || '本地部署')}</dd></div><div><dt>当前套餐</dt><dd>${esc(workspaceState?.tenant?.plan || '—')}</dd></div><div><dt>租户隔离</dt><dd class="good">RLS 已启用</dd></div></dl></article>
  <article class="panel connection-panel"><header class="panel-head"><div><span class="section-kicker">CONNECTIONS</span><h2>系统连接</h2></div></header><div class="connection-list">${connections.length ? connections.map(c=>`<div><span class="connector-logo ${esc(c.key)}">${esc(c.name.slice(0,1))}</span><p><b>${esc(c.name)}</b><small>${Number(c.records||0).toLocaleString()} 条可用记录</small></p><em class="connection-status ${esc(c.status)}"><i></i>${esc(statusLabel[c.status]||c.status)}</em></div>`).join('') : '<p style="padding:20px;color:var(--muted);font-size:10px">暂无外部连接。生产环境通过环境变量配置飞书 / NAS / AI 后在此展示。</p>'}</div></article></section>
  <section class="panel security-panel"><header class="panel-head"><div><span class="section-kicker">ACCESS CONTROL</span><h2>权限与 AI 安全</h2></div><button type="button" data-view-jump="settings">查看角色配置 →</button></header><div class="security-grid"><article><i>01</i><div><b>默认拒绝</b><p>未声明能力的写操作默认拒绝，越权请求返回 403。</p></div><span>策略</span></article><article><i>02</i><div><b>租户与行级隔离</b><p>数据库 RLS 强制租户边界，列表与详情共用同一数据域。</p></div><span>RLS</span></article><article><i>03</i><div><b>AI 权限继承</b><p>智能体在委托人的角色与数据域内执行，并全程审计。</p></div><span>策略</span></article><article><i>04</i><div><b>高风险二次确认</b><p>付款、删除、对外发送等动作按风险等级要求确认。</p></div><span>策略</span></article></div></section>
  <section class="panel" id="ai-config-panel" style="margin-top:12px"><header class="panel-head"><div><span class="section-kicker">AI PROVIDER</span><h2>AI 模型与预算</h2></div><span id="ai-config-state" class="status-pill">加载中…</span></header><div style="padding:16px 18px"><p class="loading-text">加载中…</p></div></section>
  <section class="panel" id="audit-panel" style="margin-top:12px"><header class="panel-head"><div><span class="section-kicker">AUDIT TRAIL</span><h2>最近操作审计</h2></div><button type="button" data-audit-refresh>刷新</button></header><div class="audit-list" style="padding:8px 18px"><p class="loading-text" style="padding:12px">加载中…</p></div></section>
  <section class="panel" id="rbac-panel" style="margin-bottom:20px"><p class="loading-text" style="padding:16px">加载中…</p></section>
  <section class="setup-callout ${authStatus.feishu.configured?'done':''}"><div><span>${authStatus.feishu.configured?'✓':'飞'}</span><div><small>飞书应用连接</small><h2>${authStatus.feishu.configured?'飞书应用凭据已配置':'完成飞书 OAuth 后即可同步真实组织'}</h2><p>${authStatus.feishu.configured?'OAuth、PKCE 与组织同步接口已经就绪。':'系统不会复用其他产品密钥，请为总部 OS 创建独立飞书应用。'}</p></div></div><button class="${canSync?'start-sync':'show-setup'}" type="button">${canSync?'立即同步组织':'查看配置指引'} →</button></section>
  <section class="panel onboarding-panel ${authStatus.feishu.configured?'configured':''}"><header class="panel-head"><div><span class="section-kicker">FEISHU ONBOARDING</span><h2>${authStatus.feishu.configured?'飞书连接检查清单':'三步连接飞书'}</h2></div><a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">打开飞书开发者后台 ↗</a></header><div class="onboarding-steps">
    <article><i>01</i><div><b>创建企业自建应用</b><p>在飞书开发者后台创建“总部 OS”应用，获取 App ID 与 App Secret。Secret 只写入服务器环境变量，不经过浏览器。</p></div><span>${authStatus.feishu.configured?'完成':'待操作'}</span></article>
    <article><i>02</i><div><b>配置 OAuth 回调地址</b><p>将下面地址原样添加到应用的安全设置。正式接入建议使用 HTTPS 域名。</p><code>${esc(callbackUrl)}</code><button data-copy-callback type="button">复制</button></div><span>${authStatus.feishu.redirectUri?'完成':'待操作'}</span></article>
    <article><i>03</i><div><b>申请最小通讯录权限</b><p>仅申请组织同步必需的只读权限，并在数据权限中选择允许同步的部门范围。</p><div class="scope-list">${scopes.map(scope=>`<code>${esc(scope)}</code>`).join('')}</div></div><span>${authStatus.feishu.configured?'检查后台':'待操作'}</span></article>
  </div><footer><div><b>代码侧已经完成</b><span>授权码 5 分钟一次性使用 · PKCE S256 · state 防伪 · Token 不写入前端 · 同步操作仅企业管理员可发起</span></div>${authStatus.feishu.configured?`<button class="${canSync?'start-sync':'feishu-relogin'}" type="button">${canSync?'同步部门与成员':'使用飞书管理员重新登录'}</button>`:'<span>等待服务器凭据</span>'}</footer></section></div>`;
}

function renderView(view, updateHash = true) {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'overview') { content.innerHTML = overviewMarkup; pageTitle.textContent = '经营总览'; }
  else if (view === 'ai') { content.innerHTML = aiPageMarkup(); pageTitle.textContent = 'AI 总部'; }
  else if (view === 'demo' && sessionState?.mode === 'demo') { content.innerHTML = demoPageMarkup(); pageTitle.textContent = '演示中心'; }
  else if (view === 'settings') { content.innerHTML = settingsPageMarkup(); pageTitle.textContent = '管理设置'; }
  else if (modules[view]) { content.innerHTML = moduleMarkup(view, modules[view]); pageTitle.textContent = modules[view].title; }
  else return;
  document.body.dataset.view = view;
  window.FeishuHQ?.wireMetricDrills?.();
  if (updateHash) history.replaceState(null, '', `#${view}`);
  sidebar?.classList.remove('open');
  // 不要用 content.scrollIntoView：它会把“体验企业”安全提示条一起滚出视口。
  window.scrollTo({ top: 0, behavior: 'smooth' });
  hydrateWorkspace();
  // 认证完成前只渲染骨架，避免初始 renderView 和登录后各拉一遍数据。
  if (sessionState && window.FeishuHQ?.moduleDataLoaders?.[view]) {
    window.FeishuHQ.moduleDataLoaders[view]();
  }
}
window.renderView = renderView;

document.querySelectorAll('.nav-item').forEach(link => link.addEventListener('click', event => { event.preventDefault(); renderView(link.dataset.view); }));
document.querySelector('.mobile-menu')?.addEventListener('click', () => sidebar?.classList.toggle('open'));

// ── 一键换公司（demo 模式）：左下角公司切换器 ──
const companyMenu = document.createElement('div');
companyMenu.className = 'account-menu company-menu';
document.body.append(companyMenu);
async function openCompanyMenu() {
  companyMenu.innerHTML = '<b>切换演示公司</b><small>数据完全隔离，随时切换</small><p class="loading-text" style="padding:8px">加载公司列表…</p>';
  companyMenu.classList.toggle('open');
  try {
    const res = await fetch('/v1/demo/companies', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'unavailable');
    const current = workspaceState?.tenant?.name ?? '';
    companyMenu.innerHTML = '<b>切换演示公司</b><small>各公司数据完全隔离（RLS）</small>' + (data.items || []).map(c =>
      '<button data-demo-company="' + esc(c.key) + '" class="' + (c.name === current ? 'current' : '') + '"><span>' + esc(c.name) + '</span><em>' + esc(c.industry) + '</em><i>' + esc(c.description) + '</i></button>'
    ).join('');
  } catch {
    companyMenu.innerHTML = '<b>切换演示公司</b><small>暂时不可用，请稍后再试</small>';
  }
}
companyMenu.addEventListener('click', async event => {
  const btn = event.target.closest('[data-demo-company]');
  if (!btn) return;
  companyMenu.classList.remove('open');
  try {
    const res = await fetch('/v1/session/demo', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company: btn.dataset.demoCompany }),
    });
    if (!res.ok) throw new Error();
    location.reload();
  } catch { showToast('切换失败，请稍后再试', 'error'); }
});
document.querySelector('.company-switch')?.addEventListener('click', () => {
  if (sessionState?.mode === 'demo') openCompanyMenu();
  else showToast('演示公司切换仅在体验模式下可用，正式身份请使用飞书登录');
});

// ── 岗位切换（docs/17 演示：以真实岗位身份进入，感受权限与工作台差异）──
let demoCompanyKey = '';
let demoCompaniesCache = null;
const demoPersonaCache = new Map();
const personaModal = document.createElement('div');
personaModal.className = 'demo-modal persona-modal';
personaModal.innerHTML = `<button class="demo-modal-backdrop" aria-label="关闭"></button><section role="dialog" aria-modal="true" aria-label="切换岗位"><header><div><small>SWITCH POSITION</small><h2>以哪个岗位进入？</h2></div><button class="close-persona-modal" type="button" aria-label="关闭">×</button></header><div class="persona-list" id="persona-list"><p class="loading-text" style="padding:20px">加载岗位中…</p></div><footer><p>切换后以该岗位的真实权限重新进入：角色、数据范围与工作台区块随岗位变化</p></footer></section>`;
document.body.append(personaModal);
async function resolveDemoCompanyKey() {
  if (demoCompanyKey) return demoCompanyKey;
  try {
    if (!demoCompaniesCache) demoCompaniesCache = await fetch('/v1/demo/companies', { credentials: 'same-origin' }).then(r => r.json());
    const hit = (demoCompaniesCache.items || []).find(c => c.tenantId && c.tenantId === workspaceState?.tenant?.id);
    demoCompanyKey = hit?.key || 'standard';
  } catch { demoCompanyKey = 'standard'; }
  return demoCompanyKey;
}
async function warmPersonaCache() {
  try {
    const key = await resolveDemoCompanyKey();
    if (demoPersonaCache.has(key)) return;
    const res = await fetch('/v1/demo/personas?company=' + encodeURIComponent(key), { credentials: 'same-origin' });
    if (res.ok) demoPersonaCache.set(key, await res.json());
  } catch {}
}

async function openPersonaModal() {
  personaModal.classList.add('open');
  const listEl = personaModal.querySelector('#persona-list');
  try {
    const key = await resolveDemoCompanyKey();
    let data = demoPersonaCache.get(key);
    if (!data) {
      const res = await fetch('/v1/demo/personas?company=' + encodeURIComponent(key), { credentials: 'same-origin' });
      data = await res.json();
      if (!res.ok) throw new Error();
      demoPersonaCache.set(key, data);
    }
    listEl.innerHTML = (data.items || []).map(p =>
      `<button data-persona="${esc(p.personId)}" class="${p.isAdmin ? 'admin' : ''}">
         <i>${esc(p.name.slice(0, 1))}</i>
         <div><b>${esc(p.name)} · ${esc(p.title)}</b><small>${esc(p.org)}</small><p>${esc(p.duty)}</p></div>
         <em>${p.isAdmin ? '管理员' : '员工视角'}</em>
       </button>`).join('');
    listEl.querySelectorAll('[data-persona]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        const res2 = await fetch('/v1/session/demo', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ company: demoCompanyKey || 'standard', person: btn.dataset.persona }),
        });
        if (!res2.ok) throw new Error();
        const next = await res2.json();
        try { localStorage.setItem('hq_has_session', '1'); } catch {}
        // 换岗位必须清掉旧岗位的工作区/API 缓存，否则会显示上一个人的权限与数据。
        workspaceCacheClear();
        window.FeishuHQ?.invalidateCache?.();
        const footer = personaModal.querySelector('footer p');
        if (footer) footer.textContent = '正在切换岗位并重新加载权限…';
        sessionState = { authenticated: true, mode: 'demo', ...next };
        workspaceState = next.workspace || null;
        history.replaceState(null, '', '#workbench');
        // 新会话 Cookie 已生效，先并行拉工作台，别等页面渲染后才发请求。
        window.FeishuHQ?.prefetch?.(['/v1/workbench', '/v1/teams/my']);
        personaModal.classList.remove('open');
        if (workspaceState) {
          await finishWorkspaceLoad(false);
          renderView('workbench', false);
        } else {
          await loadWorkspace();
          renderView('workbench', false);
        }
        if (footer) footer.textContent = '切换后以该岗位的真实权限重新进入：角色、数据范围与工作台区块随岗位变化';
        showToast(`已切换为 ${btn.querySelector('b')?.textContent || '新岗位'}`);
      } catch {
        const footer = personaModal.querySelector('footer p');
        if (footer) footer.textContent = '切换后以该岗位的真实权限重新进入：角色、数据范围与工作台区块随岗位变化';
        showToast('岗位切换失败，请稍后再试', 'error');
        btn.disabled = false;
      }
    }));
  } catch { listEl.innerHTML = '<p class="error-hint" style="padding:20px">岗位列表暂时不可用，请稍后再试</p>'; }
}
personaModal.addEventListener('click', e => {
  if (e.target.closest('.demo-modal-backdrop,.close-persona-modal')) personaModal.classList.remove('open');
});
document.addEventListener('click', event => {
  if (!event.target.closest('.company-menu') && !event.target.closest('.company-switch')) companyMenu.classList.remove('open');
});
document.addEventListener('click', event => {
  const jump = event.target.closest('[data-view-jump]'); if (jump) renderView(jump.dataset.viewJump);
  const exportBtn = event.target.closest('[data-export]');
  if (exportBtn) { window.location.assign(`/v1/export/${encodeURIComponent(exportBtn.dataset.export)}`); }
  const importBtn = event.target.closest('[data-import]');
  if (importBtn) openImportDialog(importBtn.dataset.import);
  const importTemplateBtn = event.target.closest('[data-import-template]');
  if (importTemplateBtn) window.location.assign(`/v1/import/${encodeURIComponent(importTemplateBtn.dataset.importTemplate)}/template`);
  if (event.target.closest('[data-audit-refresh]')) {
    if (sessionState?.mode) window.FeishuHQ?.moduleDataLoaders?.settings?.();
  }
  if (event.target.closest('.ask-ai')) {
    const module = location.hash.slice(1) || 'overview';
    if (window.FeishuHQ?.handleModuleAIAnalysis && module !== 'overview' && module !== 'ai') {
      window.FeishuHQ.handleModuleAIAnalysis(module, `分析${modules[module]?.title || module}的当前状态，给出关键洞察和行动建议`);
    } else { openAI(); }
  }
  if (event.target.closest('.module-create')) {
    const view = location.hash.slice(1) || 'overview';
    const handler = window.FeishuHQ?.moduleCreateHandlers?.[view];
    if (handler) handler(); else showToast('该模块暂未开放创建入口');
  }
  if (event.target.closest('.show-setup')) document.querySelector('.onboarding-panel')?.scrollIntoView({behavior:'smooth',block:'center'});
  if (event.target.closest('[data-copy-callback]')) { navigator.clipboard?.writeText(authStatus.feishu.redirectUri || `${location.origin}/v1/feishu/callback`); showToast('回调地址已复制'); }
  if (event.target.closest('.feishu-relogin')) window.location.assign('/v1/feishu/login');
  if (event.target.closest('.start-sync')) startFeishuSync(event.target.closest('.start-sync'));
  if (event.target.closest('.start-demo-flow')) openDemoWizard();
  if (event.target.closest('.reset-demo')) resetDemoData(event.target.closest('.reset-demo'));
  const suggestion = event.target.closest('.suggestions button, .prompt-grid button');
  if (suggestion) { const textarea = document.querySelector('.ai-composer textarea, .hero-composer textarea'); if (textarea) { textarea.value = suggestion.querySelector('b')?.textContent || suggestion.textContent.trim(); textarea.focus(); } }
});
function openAI() { if (window.innerWidth <= 930) { aiRail?.classList.add('open'); aiRail?.querySelector('textarea')?.focus(); } else renderView('ai'); }
document.querySelector('.ai-head > button')?.addEventListener('click', () => aiRail?.classList.remove('open'));
document.addEventListener('submit', async event => {
  if (!event.target.matches('.ai-composer, .hero-composer')) return;
  event.preventDefault();
  const textarea = event.target.querySelector('textarea');
  const message = textarea.value.trim();
  if (!message) return;
  textarea.value = '';
  if (window.FeishuHQ?.sendAIMessage) {
    // 如果是侧边栏 composer，不需要跳转到 AI 页
    const isSideRail = event.target.matches('.ai-composer');
    if (!isSideRail && !document.querySelector('#content .ai-hq-page')) renderView('ai');
    await window.FeishuHQ.sendAIMessage(message);
  } else {
    showToast('AI 已收到任务，正在进行权限检查与数据分析');
  }
});
async function openImportDialog(entity) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.style.display = 'none';
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const csv = await file.text();
      const post = async (dryRun) => {
        const res = await fetch(`/v1/import/${encodeURIComponent(entity)}`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ csv, dryRun }),
        });
        const data = await res.json().catch(() => ({}));
        return { res, data };
      };
      const { res, data } = await post(true);
      if (!res.ok) {
        showToast(data.error === 'missing_required_columns'
          ? `缺少必填列：${(data.columns || []).join('、')}`
          : (data.error || '导入校验失败'), 'error');
        return;
      }
      if (data.errors?.length) {
        const preview = data.errors.slice(0, 6).map(e => `第 ${e.row} 行：${e.message}`).join('\n');
        alert(`校验未通过（${data.errors.length} 行错误）\n\n${preview}${data.errors.length > 6 ? '\n…' : ''}`);
        return;
      }
      const entityLabel = { employees: '员工', accounts: '客户', parts: '物料' }[entity] || '记录';
      if (!confirm(`校验通过：共 ${data.valid} 行，确认导入${entityLabel}？`)) return;
      const committed = await post(false);
      if (!committed.res.ok) {
        showToast(committed.data.error || '导入失败', 'error');
        return;
      }
      showToast(`导入完成：${committed.data.imported} 行`);
      if (entity === 'employees') window.FeishuHQ?.moduleDataLoaders?.hr?.();
      else if (entity === 'parts') window.FeishuHQ?.moduleDataLoaders?.manufacturing?.();
      else window.FeishuHQ?.moduleDataLoaders?.crm?.();
    } catch (error) {
      showToast('导入失败：' + (error.message || '文件读取错误'), 'error');
    }
  });
  input.click();
}

function showToast(message, type) { (window.FeishuHQ?.toast || function(m){ let el = document.querySelector('.app-toast'); if (!el) { el = document.createElement('div'); el.className = 'app-toast'; document.body.append(el); } el.textContent = m; el.classList.add('show'); clearTimeout(showToast._t); showToast._t = setTimeout(() => el.classList.remove('show'), 2600); })(message, type); }

const palette = document.createElement('div'); palette.className = 'command-palette';
palette.innerHTML = `<button class="palette-backdrop" aria-label="关闭搜索"></button><section role="dialog" aria-modal="true" aria-label="全局搜索"><header><span>⌕</span><input aria-label="搜索" placeholder="搜索项目、客户、人员、知识，或直接问 AI"><kbd>ESC</kbd></header><div class="palette-body"><div class="palette-results"></div><small>快速前往</small>${Object.entries({overview:'经营总览',workbench:'我的工作台',org:'组织全景',dashboard:'高层看板',ai:'AI 总部',projects:'项目管理',dev:'研发中心',strategy:'战略 OKR',crm:'客户与销售',contracts:'合同与订阅',hr:'人才与招聘',finance:'财务管理',it:'IT 与资产',knowledge:'知识与文件',approvals:'审批中心',settings:'管理设置'}).map(([key,label])=>`<button data-palette-view="${key}"><span>${key==='ai'?'✦':'→'}</span><b>${label}</b><em>打开</em></button>`).join('')}</div><footer>输入问题后按回车，可直接交给总部助理</footer></section>`;
document.body.append(palette);
function togglePalette(show) { palette.classList.toggle('open', show); if (show) palette.querySelector('input').focus(); }
document.querySelector('.command-trigger')?.addEventListener('click', () => togglePalette(true));
palette.addEventListener('click', event => {
  if (event.target.matches('.palette-backdrop')) togglePalette(false);
  const view = event.target.closest('[data-palette-view]')?.dataset.paletteView;
  if (view) { togglePalette(false); renderView(view); return; }
  const hit = event.target.closest('[data-palette-hit]');
  if (hit) {
    togglePalette(false);
    const link = hit.dataset.paletteLink || '#overview';
    renderView(link.replace('#', ''));
  }
});
const SEARCH_TYPE_LABELS = { project: '项目', account: '客户', opportunity: '商机', person: '人员', knowledge: '知识', contract: '合同', task: '任务' };
let searchTimer = null;
async function runPaletteSearch(keyword) {
  const box = palette.querySelector('.palette-results');
  if (!box) return;
  if (!keyword.trim()) { box.innerHTML = ''; return; }
  try {
    const res = await fetch('/v1/search?q=' + encodeURIComponent(keyword.trim()), { credentials: 'same-origin' });
    if (!res.ok) { box.innerHTML = ''; return; }
    const data = await res.json();
    const items = (data.items || []).slice(0, 12);
    box.innerHTML = items.length ? `<small>搜索结果</small>${items.map(item => `
      <button data-palette-hit data-palette-link="${esc(item.link)}">
        <span>${esc(SEARCH_TYPE_LABELS[item.type] || item.type)}</span>
        <b>${esc(item.title)}</b>
        <em>${esc(item.subtitle || '')}</em>
      </button>`).join('')}` : '<small>没有找到匹配结果，按回车可交给 AI</small>';
  } catch { box.innerHTML = ''; }
}
palette.querySelector('input').addEventListener('input', event => {
  const value = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runPaletteSearch(value), 250);
});
palette.querySelector('input').addEventListener('keydown', event => {
  const buttons = [...palette.querySelectorAll('.palette-results button')];
  const active = palette.querySelector('.palette-results button.active');
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!buttons.length) return;
    event.preventDefault();
    const idx = active ? buttons.indexOf(active) : -1;
    const next = event.key === 'ArrowDown' ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length;
    buttons.forEach((b, i) => b.classList.toggle('active', i === next));
    return;
  }
  if (event.key === 'Enter' && event.target.value.trim()) {
    if (active) { event.preventDefault(); active.click(); return; }
    const prompt = event.target.value;
    togglePalette(false); renderView('ai');
    setTimeout(() => { const t = document.querySelector('.hero-composer textarea'); t.value = prompt; t.focus(); }, 50);
  }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); togglePalette(true); } if (event.key === 'Escape') { togglePalette(false); aiRail?.classList.remove('open'); sidebar?.classList.remove('open'); } });
const initialView = location.hash.slice(1); if (initialView && (initialView === 'ai' || initialView === 'settings' || initialView === 'demo' || modules[initialView])) renderView(initialView, false);
// 与登录态校验并行预取当前页数据；API 层有 10 秒缓存和并发去重，页面渲染后直接命中。
const PREFETCH_BY_VIEW = {
  // 只预热“下一跳最可能点”的工作台，避免 8 个请求抢慢链路。
  overview: ['/v1/workbench', '/v1/teams/my'],
  workbench: ['/v1/workbench', '/v1/teams/my'],
  projects: ['/v1/projects?limit=200'],
  crm: ['/v1/crm/opportunities?limit=200', '/v1/crm/accounts?limit=100'],
  finance: ['/v1/finance/overview', '/v1/finance/payments?limit=200', '/v1/finance/expenses?limit=100'],
  hr: ['/v1/hr/employees?limit=200', '/v1/hr/requisitions?limit=100', '/v1/hr/candidates?limit=100'],
  contracts: ['/v1/sales/contracts?limit=200'],
  manufacturing: ['/v1/mfg/work-orders?limit=200', '/v1/mfg/kpis'],
  supplychain: ['/v1/purchase/orders?limit=200'],
  quality: ['/v1/qms/inspections?limit=200', '/v1/qms/ncrs?limit=200'],
  equipment: ['/v1/equipment/assets?limit=200', '/v1/equipment/oee?limit=100'],
  it: ['/v1/it/assets?limit=200', '/v1/it/tickets?limit=100'],
  dev: ['/v1/sw/requirements?limit=100', '/v1/sw/defects?limit=100'],
};
window.FeishuHQ?.prefetch?.(PREFETCH_BY_VIEW[initialView || 'overview'] || []);
// 鼠标悬停/触摸即开始取下一页数据，点击时通常已在途或命中缓存。
document.querySelectorAll('.nav-item').forEach(link => {
  const warm = () => window.FeishuHQ?.prefetch?.(PREFETCH_BY_VIEW[link.dataset.view] || []);
  link.addEventListener('mouseenter', warm, { passive: true });
  link.addEventListener('touchstart', warm, { passive: true });
  link.addEventListener('focus', warm);
});
// 系统状态必须来自真实健康检查，不能用模块数量冒充。
fetch('/health').then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) })).then(({ ok, data }) => {
  const status = document.querySelector('.system-state');
  if (!status) return;
  if (ok && data.database === 'connected') status.innerHTML = '<span class="ok"></span> 服务与数据库正常';
  else if (ok) status.innerHTML = '<span class="warn"></span> 服务正常 · 数据库未连接';
  else status.innerHTML = '<span class="bad"></span> 服务异常，请检查部署';
}).catch(() => { const status = document.querySelector('.system-state'); if (status) status.innerHTML = '<span class="bad"></span> 无法连接服务'; });

// 移动端顶栏有 4 个子元素（菜单/面包屑/搜索/用户），3 列会把头像挤到第二行盖住演示提示条。
function applyMobileTopbarLayout() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  if (window.matchMedia('(max-width: 700px)').matches) {
    topbar.style.setProperty('grid-template-columns', 'auto 1fr auto auto', 'important');
  } else {
    topbar.style.removeProperty('grid-template-columns');
  }
}
applyMobileTopbarLayout();
setTimeout(applyMobileTopbarLayout, 60);
window.addEventListener('load', applyMobileTopbarLayout);
window.addEventListener('resize', applyMobileTopbarLayout, { passive: true });

function hydrateWorkspace() {
  if (!workspaceState) return;
  const { tenant, user, snapshot } = workspaceState;
  if (window.FeishuHQ) {
    window.FeishuHQ.currentUserName = user.display_name || '';
    // 本地 API 缓存按“租户 + 用户”隔离，切岗位/换公司不会读到上一个人的数据。
    window.FeishuHQ.cacheScope = `${tenant.id}:${user.id || user.personId || user.display_name || 'me'}`;
  }
  document.querySelector('.company-switch b').textContent = tenant.name;
  document.querySelector('.company-switch small').textContent = `${tenant.plan === 'professional' ? '专业版' : tenant.plan} · ${tenant.memberCount} 人`;
  document.querySelector('.company-avatar').textContent = tenant.name.slice(0, 1);
  document.querySelector('.user-button span').textContent = user.displayName.slice(0, 2);
  const accountName = document.querySelector('[data-account-name]');
  const accountRole = document.querySelector('[data-account-role]');
  if (accountName) accountName.textContent = user.displayName;
  if (accountRole) accountRole.textContent = `${user.role === 'tenant_admin' ? '企业管理员' : '成员'}${sessionState?.mode === 'demo' ? ' · 体验会话' : ''}`;
  const hour = new Date().getHours();
  const greetWord = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const greeting = document.querySelector('.welcome-row h1'); if (greeting) greeting.textContent = `${greetWord}，${user.displayName}。`;
  const dateEl = document.querySelector('.welcome-row .eyebrow');
  if (dateEl) {
    const now = new Date();
    const days = ['周日','周一','周二','周三','周四','周五','周六'];
    const d = `${now.getFullYear()} 年 ${now.getMonth()+1} 月 ${now.getDate()} 日 · ${days[now.getDay()]}`;
    dateEl.innerHTML = `<span></span> ${d}`;
  }
  const values = [snapshot.metrics?.monthly_receipts?.value, snapshot.metrics?.sales_pipeline?.value, snapshot.metrics?.project_health?.value != null ? `${snapshot.metrics.project_health.value}%` : null, snapshot.metrics?.headcount?.value != null ? `${snapshot.metrics.headcount.value}人` : null];
  document.querySelectorAll('.metric-grid:not(.module-metrics) .metric-card>strong').forEach((node,index)=>{ if(values[index]) node.textContent=values[index]; });
}

function workspaceCacheRead() {
  try {
    const cached = JSON.parse(localStorage.getItem('hq_workspace_cache') || 'null');
    if (!cached || Date.now() - Number(cached.at || 0) > 30 * 60_000) return null;
    return cached;
  } catch { return null; }
}
function workspaceCacheWrite() {
  try { localStorage.setItem('hq_workspace_cache', JSON.stringify({ workspace: workspaceState, mode: sessionState?.mode || 'demo', sid: sessionState?.session_id || '', at: Date.now() })); } catch {}
}
function workspaceCacheClear() {
  try { localStorage.removeItem('hq_workspace_cache'); } catch {}
}

async function finishWorkspaceLoad(loadCurrentView = true) {
  document.body.classList.remove('auth-pending','unauthenticated');
  document.body.classList.add('authenticated');
  hydrateWorkspace();
  workspaceCacheWrite();
  window.FeishuHQ?.wireMetricDrills?.();
  ensureDemoBanner();
  // 通知、能力、演示数据都不阻塞首屏；能并行就不要串行。
  loadNotifications();
  const demoPromise = sessionState?.mode === 'demo' ? loadDemoData().catch(() => {}) : Promise.resolve();
  fetch('/v1/me/capabilities', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(caps => { if (caps && window.FeishuHQ) window.FeishuHQ.caps = caps; })
    .catch(() => {});
  const currentView = location.hash.slice(1) || 'overview';
  if (sessionState?.mode === 'demo' && currentView === 'demo') await demoPromise;
  if (sessionState?.mode === 'demo') setTimeout(warmPersonaCache, 600);
  if (loadCurrentView) window.FeishuHQ?.moduleDataLoaders?.[currentView]?.();
}

async function loadWorkspace() {
  const response = await fetch('/v1/workspace', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('workspace_unavailable');
  workspaceState = await response.json();
  await finishWorkspaceLoad();
}

async function loadDemoData() {
  const response = await fetch('/v1/demo/workspace',{credentials:'same-origin'});
  if (response.ok) demoState = await response.json();
}

function ensureDemoBanner() {
  document.querySelector('.demo-session-banner')?.remove();
  document.body.classList.toggle('demo-session',sessionState?.mode==='demo');
  if(sessionState?.mode!=='demo') return;
  const banner=document.createElement('section'); banner.className='demo-session-banner';
  banner.innerHTML='<span>体验企业</span><p><b>这是安全的演示环境</b><small>左下角切换公司 · 右上角可切换岗位体验不同权限</small></p><span style="display:flex;gap:8px"><button data-open-demo>开始引导 →</button><button data-switch-persona class="btn primary" type="button">切换岗位</button></span>';
  banner.querySelector('[data-switch-persona]')?.addEventListener('click', () => openPersonaModal());
  document.querySelector('.workspace')?.insertBefore(banner,document.querySelector('.main-grid'));
  banner.querySelector('button').addEventListener('click',()=>renderView('demo'));
}

const demoModal=document.createElement('div'); demoModal.className='demo-modal';
demoModal.innerHTML=`<button class="demo-modal-backdrop" aria-label="关闭"></button><section role="dialog" aria-modal="true" aria-labelledby="demo-dialog-title"><header><div><small>CROSS-MODULE WORKFLOW</small><h2 id="demo-dialog-title">创建一条真实业务链</h2></div><button class="close-demo-modal" type="button" aria-label="关闭">×</button></header><div class="wizard-progress"><i class="active"></i><i></i><i></i><i></i><span>商机</span><span>项目</span><span>人才</span><span>收款</span></div><form class="demo-flow-form"><div class="wizard-fields"><label><span>客户名称</span><input name="customerName" value="拾光零售" maxlength="200" required></label><label><span>商机名称</span><input name="opportunityName" value="门店经营数字化升级" maxlength="200" required></label><label><span>合同金额（元）</span><input name="amountYuan" type="number" value="680000" min="1000" required></label><label><span>预计签约日</span><input name="expectedCloseDate" type="date" value="2026-09-18" required></label><label><span>项目名称</span><input name="projectName" value="拾光零售数字化一期" required></label><label><span>项目开始</span><input name="startDate" type="date" value="2026-09-21" required></label><label><span>计划交付</span><input name="endDate" type="date" value="2026-12-18" required></label><label class="checkbox-field"><input name="hiringEnabled" type="checkbox" checked><span><b>同步发起招聘需求</b><small>为交付团队补充所需人才</small></span></label><label><span>招聘岗位</span><input name="jobTitle" value="实施顾问" required></label><label><span>需求人数</span><input name="headcount" type="number" value="2" min="1" max="20" required></label><label><span>首期款比例</span><div class="suffix-input"><input name="paymentPercent" type="number" value="30" min="1" max="100" required><i>%</i></div></label><label><span>预计收款日</span><input name="paymentDueDate" type="date" value="2026-09-30" required></label></div><footer><p><i>✓</i> 提交后将在 CRM、项目、人才和财务中同时生成演示记录</p><button class="btn primary" type="submit">确认并运行流程 <span>→</span></button></footer></form><div class="wizard-result"><span>✓</span><small>跨模块流程运行成功</small><h2>一笔订单，已经变成可执行的公司计划</h2><div></div><button class="btn primary finish-demo" type="button">查看业务链路</button></div></section>`;
document.body.append(demoModal);
function openDemoWizard(){demoModal.classList.add('open');demoModal.querySelector('input')?.focus();}
function closeDemoWizard(){demoModal.classList.remove('open','completed');}
demoModal.addEventListener('click',event=>{if(event.target.closest('.demo-modal-backdrop,.close-demo-modal'))closeDemoWizard();if(event.target.closest('.finish-demo')){closeDemoWizard();renderView('demo');}});
demoModal.querySelector('.demo-flow-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;button.innerHTML='正在联动四个系统…';const data=Object.fromEntries(new FormData(form));data.hiringEnabled=form.elements.hiringEnabled.checked;data.amountYuan=Number(data.amountYuan);data.headcount=Number(data.headcount);data.paymentPercent=Number(data.paymentPercent);
  const submitOnce=()=>Promise.race([
    fetch('/v1/demo/workflows/sales-to-delivery',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(data)})
      .then(async response=>{const result=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(result.error||('HTTP '+response.status)),{http:true});return result;}),
    new Promise((_,rej)=>setTimeout(()=>rej(Object.assign(new Error('网络超时'),{network:true})),20000))
  ]);
  const fail=msg=>{showToast(msg,'error');button.disabled=false;button.innerHTML='确认并运行流程 <span>→</span>';};
  (async()=>{for(let attempt=1;attempt<=3;attempt++){try{
    const result=await submitOnce();
    await loadDemoData();
    demoModal.classList.add('completed');
    demoModal.querySelector('.wizard-result div').innerHTML=`<b>${esc(result.summary.customerName)}</b><span>${esc(result.code)} · 首期款 ${money(result.summary.paymentYuan*100)}</span>`;
    return;
  }catch(e){
    if(!(e&&e.network)){fail('流程没有完成：'+(e.message||'请检查表单输入'));return;}
    if(attempt<3){button.innerHTML=`网络波动，自动重试 ${attempt}/3…`;await new Promise(r=>setTimeout(r,900));}
  }}
  fail('当前网络到服务器不稳定，请再点一次重试（演示数据可随时重置）');})();});

async function resetDemoData(button){if(!confirm('只会清除体验企业中由演示流程产生的数据，确定重置吗？'))return;button.disabled=true;button.textContent='正在重置…';try{const response=await fetch('/v1/demo/reset',{method:'POST',credentials:'same-origin'});if(!response.ok)throw new Error();await loadDemoData();renderView('demo');showToast('体验数据已恢复为空白状态');}catch{showToast('重置失败，请稍后再试');button.disabled=false;button.textContent='重置体验数据';}}

async function startFeishuSync(button) {
  button.disabled = true; button.textContent = '正在同步…';
  try {
    const response = await fetch('/v1/integrations/feishu/sync', { method:'POST', credentials:'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'sync_failed');
    await loadWorkspace(); renderView('settings'); showToast(`同步完成：${result.departments} 个部门，${result.people} 位成员`);
  } catch (error) { showToast(error.message === 'feishu_identity_not_linked' ? '请先使用飞书管理员身份登录' : '同步失败，请检查飞书权限范围'); button.disabled = false; button.textContent = '重新同步 →'; }
}

async function initializeAuth() {
  // 两个请求互不依赖，并行发出；命中本标签页缓存时先用旧工作区渲染，再后台校验。
  const sessionPromise = fetch('/v1/session', { credentials: 'same-origin' });
  const statusPromise = fetch('/v1/auth/status');
  const cached = document.documentElement.classList.contains('session-expected') ? workspaceCacheRead() : null;
  if (cached?.workspace) {
    workspaceState = cached.workspace;
    sessionState = { authenticated: true, mode: cached.mode || 'demo' };
    await finishWorkspaceLoad();
  }
  const [statusResponse, sessionResponse] = await Promise.all([statusPromise, sessionPromise]);
  if (statusResponse.ok) authStatus = await statusResponse.json();
  if (sessionResponse.ok) {
    const liveSession = await sessionResponse.json();
    const staleTenant = Boolean(cached?.workspace && workspaceState?.tenant?.id && liveSession.workspace?.tenant?.id && workspaceState.tenant.id !== liveSession.workspace.tenant.id);
    const sessionChanged = Boolean(cached?.workspace && (!cached.sid || (liveSession.session_id && cached.sid !== liveSession.session_id)));
    sessionState = liveSession;
    try { localStorage.setItem('hq_has_session', '1'); } catch {}
    if (liveSession.workspace) {
      workspaceState = liveSession.workspace;
      if (!cached?.workspace || staleTenant || sessionChanged) {
        // 新会话（换岗位/换浏览器账号）：旧 API 本地缓存立即失效，避免审批/待办串数据。
        if (sessionChanged) window.FeishuHQ?.invalidateCache?.(true);
        await finishWorkspaceLoad();
        if (sessionChanged) renderView(location.hash.slice(1) || 'overview', false);
      } else {
        hydrateWorkspace();
        workspaceCacheWrite();
      }
    } else {
      await loadWorkspace();
    }
    if (location.hash === '#demo' && sessionState.mode === 'demo') renderView('demo', false);
    if (new URLSearchParams(location.search).get('oauth') === 'connected') {
      history.replaceState(null, '', location.pathname + location.hash);
      showToast('飞书身份连接成功');
    }
    return;
  }
  try { localStorage.removeItem('hq_has_session'); } catch {}
  workspaceCacheClear();
  document.documentElement.classList.remove('session-expected');
  document.body.classList.remove('auth-pending');
  document.body.classList.add('unauthenticated');
}

document.querySelector('.demo-login')?.addEventListener('click', async event => {
  const button = event.currentTarget; const status = document.querySelector('.login-status');
  button.disabled = true; status.textContent = '正在建立安全体验会话…';
  try { const response = await fetch('/v1/session/demo', { method:'POST', credentials:'same-origin' }); if(!response.ok) throw new Error(); try { localStorage.setItem('hq_has_session', '1'); } catch {} sessionState={mode:'demo'}; await loadWorkspace(); renderView('demo'); }
  catch { status.textContent = '暂时无法进入体验企业，请稍后重试。'; button.disabled = false; }
});
document.querySelector('.feishu-login')?.addEventListener('click', (event) => {
  event.preventDefault();
  const status = document.querySelector('.login-status');
  if (status) status.textContent = '飞书登录暂未开放，请先进入体验企业。';
});

// ── 站内通知中心（真实数据；与飞书消息互补）──
const notificationMenu = document.createElement('div');
notificationMenu.className = 'account-menu notification-menu';
notificationMenu.innerHTML = '<b>通知</b><small class="notification-summary">加载中…</small><div class="notification-list"><p class="loading-text" style="padding:12px">加载中…</p></div><button data-notification-read-all type="button">全部标为已读</button>';
document.body.append(notificationMenu);

async function loadNotifications() {
  try {
    const res = await fetch('/v1/notifications?limit=30', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    const dot = document.querySelector('#notification-dot');
    if (dot) dot.style.display = Number(data.unread) > 0 ? '' : 'none';
    const summary = notificationMenu.querySelector('.notification-summary');
    if (summary) summary.textContent = Number(data.unread) > 0 ? `${data.unread} 条未读` : '全部已读';
    const list = notificationMenu.querySelector('.notification-list');
    const items = data.items || [];
    list.innerHTML = items.length ? items.map(n => `
      <button class="notification-item ${n.read_at ? '' : 'unread'}" data-notification-id="${esc(n.id)}" data-notification-link="${esc(n.link || '')}">
        <i>${esc((n.kind || 'system').slice(0, 1).toUpperCase())}</i>
        <div><b>${esc(n.title)}</b><p>${esc(n.body || '')}</p><time>${new Date(n.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
      </button>`).join('') : '<p class="empty-hint" style="padding:14px;color:var(--muted);font-size:10px">暂无通知</p>';
  } catch { /* 静默失败，不影响主流程 */ }
}

document.querySelector('.notification-button')?.addEventListener('click', async (event) => {
  event.stopPropagation();
  const open = notificationMenu.classList.toggle('open');
  event.currentTarget.setAttribute('aria-expanded', String(open));
  if (open) await loadNotifications();
});
notificationMenu.addEventListener('click', async (event) => {
  const readAll = event.target.closest('[data-notification-read-all]');
  if (readAll) {
    await fetch('/v1/notifications/read-all', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
    await loadNotifications();
    return;
  }
  const item = event.target.closest('[data-notification-id]');
  if (!item) return;
  await fetch(`/v1/notifications/${encodeURIComponent(item.dataset.notificationId)}/read`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
  notificationMenu.classList.remove('open');
  const link = item.dataset.notificationLink;
  if (link && link.startsWith('/#')) renderView(link.slice(2));
  await loadNotifications();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.notification-menu') && !event.target.closest('.notification-button')) {
    notificationMenu.classList.remove('open');
  }
});
setInterval(() => { if (sessionState) loadNotifications(); }, 60_000);

const accountMenu = document.createElement('div'); accountMenu.className = 'account-menu'; accountMenu.innerHTML = '<b data-account-name>当前用户</b><small data-account-role>加载中…</small><button data-account-settings>管理设置</button><button data-switch-persona-menu>切换岗位（演示）</button><button data-signout>退出登录</button>';
accountMenu.addEventListener('click', e => { if (e.target.closest('[data-switch-persona-menu]')) { if (sessionState?.mode === 'demo') { accountMenu.classList.remove('open'); openPersonaModal(); } else showToast('岗位切换仅在体验模式下可用'); } }); document.body.append(accountMenu);
document.querySelector('.user-button')?.addEventListener('click', () => accountMenu.classList.toggle('open'));
accountMenu.addEventListener('click', async event => { if(event.target.closest('[data-account-settings]')){accountMenu.classList.remove('open');renderView('settings');} if(event.target.closest('[data-signout]')){try{localStorage.removeItem('hq_has_session')}catch{} workspaceCacheClear(); window.FeishuHQ?.invalidateCache?.(true); await fetch('/v1/session',{method:'DELETE',credentials:'same-origin'});location.reload();} });

initializeAuth().catch(() => { document.body.classList.remove('auth-pending'); document.body.classList.add('unauthenticated'); document.querySelector('.login-status').textContent = '服务连接失败，请刷新页面重试。'; });
