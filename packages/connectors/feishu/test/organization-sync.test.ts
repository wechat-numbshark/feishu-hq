import test from "node:test";
import assert from "node:assert/strict";
import {
  planFeishuOrganizationSync,
  snapshotFingerprint,
  type CurrentOrganizationProjection,
  type FeishuOrganizationSnapshot
} from "../src/organization-sync.ts";

const empty: CurrentOrganizationProjection = { orgUnits: [], people: [] };

function snapshot(overrides: Partial<FeishuOrganizationSnapshot> = {}): FeishuOrganizationSnapshot {
  return {
    providerTenantId: "feishu-tenant-1",
    mode: "full",
    capturedAt: "2026-08-30T00:00:00.000Z",
    orgUnits: [],
    people: [],
    ...overrides
  };
}

test("父部门总是在子部门之前执行", () => {
  const plan = planFeishuOrganizationSync(empty, snapshot({
    orgUnits: [
      { externalId: "child", parentExternalId: "root", name: "研发部", active: true },
      { externalId: "root", name: "总部", active: true }
    ]
  }));
  assert.deepEqual(plan.orgUnitUpserts.map((item) => item.externalId), ["root", "child"]);
});

test("指纹一致的对象不重复写入", () => {
  const unit = { externalId: "root", name: "总部", active: true };
  const plan = planFeishuOrganizationSync({
    orgUnits: [{ externalId: "root", active: true, fingerprint: snapshotFingerprint(unit) }],
    people: []
  }, snapshot({ orgUnits: [unit] }));
  assert.equal(plan.orgUnitUpserts.length, 0);
  assert.equal(plan.stats.unchangedOrgUnits, 1);
});

test("完整快照会停用已经消失的人员和部门", () => {
  const plan = planFeishuOrganizationSync({
    orgUnits: [{ externalId: "old-dept", active: true, fingerprint: "old" }],
    people: [{ externalId: "old-user", active: true, fingerprint: "old" }]
  }, snapshot());
  assert.deepEqual(plan.orgUnitDisables, ["old-dept"]);
  assert.deepEqual(plan.personDisables, ["old-user"]);
});

test("增量快照不会停用未出现的对象", () => {
  const plan = planFeishuOrganizationSync({
    orgUnits: [{ externalId: "old-dept", active: true, fingerprint: "old" }],
    people: [{ externalId: "old-user", active: true, fingerprint: "old" }]
  }, snapshot({ mode: "delta" }));
  assert.deepEqual(plan.orgUnitDisables, []);
  assert.deepEqual(plan.personDisables, []);
});

test("循环部门关系会被拒绝", () => {
  assert.throws(() => planFeishuOrganizationSync(empty, snapshot({
    orgUnits: [
      { externalId: "a", parentExternalId: "b", name: "A", active: true },
      { externalId: "b", parentExternalId: "a", name: "B", active: true }
    ]
  })), /org_unit_cycle/);
});

test("重复外部 ID 会被拒绝", () => {
  assert.throws(() => planFeishuOrganizationSync(empty, snapshot({
    people: [
      { externalId: "u1", name: "甲", departmentExternalIds: [], active: true },
      { externalId: "u1", name: "乙", departmentExternalIds: [], active: true }
    ]
  })), /person_duplicate_external_id/);
});

test("人员主部门必须属于其部门成员关系", () => {
  assert.throws(() => planFeishuOrganizationSync(empty, snapshot({
    orgUnits: [
      { externalId: "d1", name: "一部", active: true },
      { externalId: "d2", name: "二部", active: true }
    ],
    people: [{
      externalId: "u1",
      name: "甲",
      departmentExternalIds: ["d1"],
      primaryDepartmentExternalId: "d2",
      active: true
    }]
  })), /primary_department_not_in_memberships/);
});

