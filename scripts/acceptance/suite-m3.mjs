// M3 三条核心业务链：真实记录 ID + 关联 + 状态流转，逐环节以真实库读回核验。
export default async function run({ api, cookies, readBack, check, T }) {
  const SUITE = "M3";

  // ── 链1：商机 → 项目 → 回款 ──────────────────────────────
  const opp = await api(cookies.admin, "POST", "/v1/crm/opportunities", {
    name: "M3-智慧园区项目", customer_name: "甲方集团", amount_cents: 8000000, stage: "qualified",
  });
  check(SUITE, `链1 建商机 -> ${opp.status}`, opp.status === 201, `id=${opp.body?.id}`);
  const oppId = opp.body.id;

  const proj = await api(cookies.admin, "POST", "/v1/projects", {
    name: "M3-交付项目", customer_name: "甲方集团", budget_cents: 8000000, source_opportunity_id: oppId,
  });
  const { rows: projRow } = await readBack(`SELECT id, source_opportunity_id, status FROM project.projects WHERE id=$1`, [proj.body.id]);
  check(SUITE, `链1 建项目并关联商机`, proj.status === 201 && projRow[0]?.source_opportunity_id === oppId,
    `link=${projRow[0]?.source_opportunity_id}`);

  const pay = await api(cookies.finance, "POST", "/v1/finance/payments", {
    customer_name: "甲方集团", amount_cents: 2400000, due_date: "2026-06-30", milestone: "首付款", project_id: proj.body.id,
  });
  const { rows: payRow } = await readBack(`SELECT project_id, status FROM finance.payment_plans WHERE id=$1`, [pay.body.id]);
  check(SUITE, `链1 建回款计划并关联项目`, pay.status === 201 && payRow[0]?.project_id === proj.body.id,
    `pay=${pay.body?.id} status=${payRow[0]?.status}`);

  // 状态流转：商机推进到 proposal
  await api(cookies.admin, "PATCH", `/v1/crm/opportunities/${oppId}`, { stage: "proposal" });
  const { rows: oppStage } = await readBack(`SELECT stage FROM crm.opportunities WHERE id=$1`, [oppId]);
  check(SUITE, `链1 商机状态流转 qualified->proposal`, oppStage[0]?.stage === "proposal", `stage=${oppStage[0]?.stage}`);

  // ── 链2：招聘需求 → 入职 → 资产领用 ──────────────────────
  const req = await api(cookies.hr, "POST", "/v1/hr/requisitions", { title: "M3-后端工程师", headcount: 1, reason: "业务扩张" });
  check(SUITE, `链2 建招聘需求 -> ${req.status}`, req.status === 201, `id=${req.body?.id}`);
  await api(cookies.hr, "PATCH", `/v1/hr/requisitions/${req.body.id}`, { status: "approved" });
  const { rows: reqRow } = await readBack(`SELECT status FROM hr.job_requisitions WHERE id=$1`, [req.body.id]);
  check(SUITE, `链2 需求审批通过 open->approved`, reqRow[0]?.status === "approved", `status=${reqRow[0]?.status}`);

  const hire = await api(cookies.hr, "POST", "/v1/hr/employees", { display_name: "M3-新员工", primary_email: "m3hire@acceptance.test", employee_number: "M3-HIRE-001" });
  const newPersonId = hire.body?.person_id;
  const { rows: hireRow } = await readBack(`SELECT person_id, status FROM platform.employments WHERE id=$1`, [hire.body?.id]);
  check(SUITE, `链2 新员工入职并生成任职 -> ${hire.status}`, hire.status === 201 && !!newPersonId && hireRow[0]?.status === "active", `person=${newPersonId} body=${JSON.stringify(hire.body)}`);

  const asset = await api(cookies.admin, "POST", "/v1/it/assets", { name: "M3-MacBook Pro", category: "hardware", assigned_person_id: newPersonId });
  const { rows: assetRow } = await readBack(`SELECT assigned_person_id, status FROM it.assets WHERE id=$1`, [asset.body.id]);
  check(SUITE, `链2 资产领用并指派给新员工`, asset.status === 201 && assetRow[0]?.assigned_person_id === newPersonId,
    `asset=${asset.body?.id}`);

  // ── 链3：费用 → 审批（两级可决策）→ 财务业务回写 ─────────
  // 先把 expense 流程改为「直属上级 -> 指定财务(person)」，使两都能被决策，从而触发终态回写。
  const flowPatch = await api(cookies.admin, "PATCH", "/v1/approval-flows/expense", {
    steps: [
      { order: 1, type: "manager", label: "直属上级" },
      { order: 2, type: "person", label: "财务复核", person_id: T.finance },
    ],
  });
  check(SUITE, `链3 配置两级可决策审批流 -> ${flowPatch.status}`, flowPatch.status === 200);

  const exp3 = await api(cookies.employee, "POST", "/v1/finance/expenses", { category: "hardware", amount_cents: 300000, expense_date: "2026-03-01", description: "M3-chain3" });
  const { rows: inst3 } = await readBack(`SELECT id, current_step, status FROM platform.approval_instances WHERE tenant_id=$1 AND resource_id=$2`, [T.tenant, exp3.body.id]);
  const inst3Id = inst3[0]?.id;
  check(SUITE, `链3 超阈值生成审批实例`, inst3.length === 1 && inst3[0].status === "pending", `inst=${inst3Id}`);

  const d1 = await api(cookies.manager, "POST", `/v1/approvals/${inst3Id}/decide`, { decision: "approved" });
  check(SUITE, `链3 上级批准第1步 -> ${d1.body?.newStatus} (pending)`, d1.status === 200 && d1.body?.newStatus === "pending");
  const d2 = await api(cookies.finance, "POST", `/v1/approvals/${inst3Id}/decide`, { decision: "approved" });
  check(SUITE, `链3 财务批准第2步 -> ${d2.body?.newStatus} (approved)`, d2.status === 200 && d2.body?.newStatus === "approved",
    `status=${d2.status} body=${JSON.stringify(d2.body)}`);

  const { rows: instFinal } = await readBack(`SELECT status, resolved_at FROM platform.approval_instances WHERE id=$1`, [inst3Id]);
  const { rows: expFinal } = await readBack(`SELECT status FROM finance.expenses WHERE id=$1`, [exp3.body.id]);
  check(SUITE, `链3 审批终态 approved 且业务表回写`,
    instFinal[0]?.status === "approved" && instFinal[0]?.resolved_at != null && expFinal[0]?.status === "approved",
    `instance=${instFinal[0]?.status} expense=${expFinal[0]?.status}`);
}
