// M2 审批内核 + 设置生效：全部走真实 HTTP 与真实库读回。
// 覆盖：阈值边界触发审批 / 直属上级自动指派 / 角色步骤进入待指派 / 职责分离 / 版本快照 / 幂等唯一键。
export default async function run({ api, cookies, readBack, dbExpectError, check, T }) {
  const SUITE = "M2";

  // 生效前置：管理员把报销审批阈值设为 200000（分）
  const patch = await api(cookies.admin, "PATCH", "/v1/settings/finance", { approval_threshold_cents: 200000 });
  check(SUITE, `管理员 PATCH 阈值=200000 -> ${patch.status}`, patch.status === 200);

  // 边界1：等于阈值 -> 不建审批
  const eq = await api(cookies.employee, "POST", "/v1/finance/expenses", { category: "supplies", amount_cents: 200000, expense_date: "2026-02-01", description: "M2-eq" });
  check(SUITE, `金额=阈值200000 needs_approval=${eq.body?.needs_approval} (期望 false)`, eq.status === 201 && eq.body?.needs_approval === false, `body=${JSON.stringify(eq.body)}`);
  const { rows: eqInst } = await readBack(`SELECT id FROM platform.approval_instances WHERE tenant_id=$1 AND resource_id=$2`, [T.tenant, eq.body.id]);
  check(SUITE, `等于阈值未建审批实例 (rows=${eqInst.length})`, eqInst.length === 0);

  // 边界2：严格大于阈值 -> 建审批 + 选人为直属上级
  const gt = await api(cookies.employee, "POST", "/v1/finance/expenses", { category: "travel", amount_cents: 200001, expense_date: "2026-02-01", description: "M2-gt" });
  const expId = gt.body.id;
  check(SUITE, `金额>阈值 needs_approval=${gt.body?.needs_approval} (期望 true)`, gt.status === 201 && gt.body?.needs_approval === true, `body=${JSON.stringify(gt.body)}`);

  const { rows: inst } = await readBack(
    `SELECT id, status, current_step, total_steps FROM platform.approval_instances WHERE tenant_id=$1 AND resource_id=$2`, [T.tenant, expId]);
  check(SUITE, `超阈值创建 1 个审批实例`, inst.length === 1, JSON.stringify(inst[0] ?? {}));
  const instanceId = inst[0]?.id;
  const { rows: act1 } = await readBack(
    `SELECT step_order, approver_person_id, status FROM platform.approval_actions WHERE instance_id=$1 ORDER BY step_order`, [instanceId]);
  check(SUITE, `第1步自动指派直属上级(manager)`, act1[0]?.step_order === 1 && act1[0]?.approver_person_id === T.manager,
    `approver=${act1[0]?.approver_person_id}`);

  // 职责分离：非审批人(finance)决策第1步 -> 403
  const wrong = await api(cookies.finance, "POST", `/v1/approvals/${instanceId}/decide`, { decision: "approved" });
  check(SUITE, `非审批人 finance 决策第1步 -> ${wrong.status} (期望 403 permission_denied)`,
    wrong.status === 403 && wrong.body?.error === "permission_denied");

  // 正确审批人(manager)批准第1步 -> 推进到第2步(role，待指派 approver=null)
  const ok1 = await api(cookies.manager, "POST", `/v1/approvals/${instanceId}/decide`, { decision: "approved", comment: "同意" });
  check(SUITE, `直属上级批准第1步 -> ${ok1.status} newStatus=${ok1.body?.newStatus} (期望 pending)`,
    ok1.status === 200 && ok1.body?.newStatus === "pending");

  const { rows: act2 } = await readBack(
    `SELECT step_order, approver_person_id FROM platform.approval_actions WHERE instance_id=$1 AND step_order=2`, [instanceId]);
  check(SUITE, `第2步为角色步骤进入待指派(approver IS NULL)`, act2.length === 1 && act2[0].approver_person_id === null);

  // 版本快照已落库
  const { rows: snaps } = await readBack(
    `SELECT snapshot_jsonb FROM platform.approval_flow_versions WHERE instance_id=$1`, [instanceId]);
  check(SUITE, `决策产生版本快照 (rows=${snaps.length})`, snaps.length >= 1);

  // 幂等唯一键：重复插入同一 idempotency_key 必须被数据库拒绝
  const { rows: keys } = await readBack(`SELECT idempotency_key FROM platform.approval_idempotency_keys WHERE tenant_id=$1 AND resource_id=$2`, [T.tenant, expId]);
  check(SUITE, `审批幂等键已记录`, keys.length === 1);
  const dupErr = await dbExpectError(
    `INSERT INTO platform.approval_idempotency_keys (id, tenant_id, resource_type, resource_id, requester_person_id, flow_code, idempotency_key)
     VALUES (gen_random_uuid(), $1, 'expense', $2, $3, 'expense', $4)`,
    [T.tenant, expId, T.employee, keys[0]?.idempotency_key]);
  check(SUITE, `重复幂等键被唯一约束拒绝`, /duplicate key|violates unique/i.test(dupErr || ""), dupErr || "(未报错)");

  // 自批禁止：提交人自身拥有 finance.approve 能力时，自己审批自己提交的报销 -> 403 self_approval_forbidden
  // （用 finance 角色提交并自批：先过 assertCapability(finance.approve)，再命中 submitter==approver 职责分离）
  const selfExp = await api(cookies.finance, "POST", "/v1/finance/expenses", { category: "meals", amount_cents: 5000, expense_date: "2026-02-02", description: "M2-self" });
  const selfApprove = await api(cookies.finance, "POST", `/v1/finance/expenses/${selfExp.body.id}/approve`, { approved: true });
  check(SUITE, `提交人自批报销 -> ${selfApprove.status} (期望 403 self_approval_forbidden)`,
    selfApprove.status === 403 && selfApprove.body?.error === "self_approval_forbidden", `body=${JSON.stringify(selfApprove.body)}`);

  // 非提交人(manager)批准该低于阈值的报销 -> 200 且状态 approved（业务回写读回）
  const finApprove = await api(cookies.manager, "POST", `/v1/finance/expenses/${selfExp.body.id}/approve`, { approved: true });
  const { rows: expRow } = await readBack(`SELECT status, approver_person_id FROM finance.expenses WHERE id=$1`, [selfExp.body.id]);
  check(SUITE, `他人批准低于阈值报销 -> ${finApprove.status}，库中 status=${expRow[0]?.status}`,
    finApprove.status === 200 && expRow[0]?.status === "approved");
}
