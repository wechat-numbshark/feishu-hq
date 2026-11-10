import test from "node:test";
import assert from "node:assert/strict";
import { hasCapability, expandCapabilities, MANAGEABLE_ROLES, ROLE_LABELS } from "../src/authz.ts";

test("企业管理员拥有全部能力", () => {
  assert.equal(hasCapability(["tenant_admin"], "hr.manage"), true);
  assert.equal(hasCapability(["tenant_admin"], "finance.approve"), true);
  assert.equal(hasCapability(["tenant_admin"], "people.manage_roles"), true);
  assert.deepEqual(expandCapabilities(["tenant_admin"]), ["*"]);
});

test("人事管理员可管理人事与薪资，但无财务与角色管理权限", () => {
  assert.equal(hasCapability(["hr_manager"], "hr.manage"), true);
  assert.equal(hasCapability(["hr_manager"], "hr.salary.read"), true);
  assert.equal(hasCapability(["hr_manager"], "hr.salary.write"), true);
  assert.equal(hasCapability(["hr_manager"], "hr.leave.approve"), true);
  assert.equal(hasCapability(["hr_manager"], "finance.manage"), false);
  assert.equal(hasCapability(["hr_manager"], "people.manage_roles"), false);
});

test("财务管理员可管理财务与审批报销，但无人事权限", () => {
  assert.equal(hasCapability(["finance_manager"], "finance.manage"), true);
  assert.equal(hasCapability(["finance_manager"], "finance.approve"), true);
  assert.equal(hasCapability(["finance_manager"], "hr.manage"), false);
  assert.equal(hasCapability(["finance_manager"], "hr.salary.read"), false);
});

test("部门主管仅可审批团队请假与报销", () => {
  assert.equal(hasCapability(["manager"], "hr.leave.approve"), true);
  assert.equal(hasCapability(["manager"], "finance.approve"), true);
  assert.equal(hasCapability(["manager"], "hr.manage"), false);
  assert.equal(hasCapability(["manager"], "hr.salary.read"), false);
  assert.equal(hasCapability(["manager"], "finance.manage"), false);
});

test("普通员工不具备敏感管理能力，仅保留自助与协作能力", () => {
  assert.equal(hasCapability(["employee"], "hr.manage"), false);
  assert.equal(hasCapability(["employee"], "finance.approve"), false);
  assert.equal(hasCapability([], "hr.salary.read"), false);
  assert.deepEqual(expandCapabilities(["employee"]), [
    "project.write", "knowledge.write", "purchase.write", "ops.write", "sw.write", "it.ticket", "self.service",
  ]);
});

test("管理员专属能力不会下放给任何岗位角色", () => {
  for (const role of ["hr_manager", "finance_manager", "manager", "employee"]) {
    assert.equal(hasCapability([role], "people.manage_roles"), false, `${role} 不应拥有 people.manage_roles`);
    assert.equal(hasCapability([role], "approval.manage"), false, `${role} 不应拥有 approval.manage`);
  }
});

test("多角色叠加能力取并集", () => {
  const roles = ["hr_manager", "finance_manager"];
  assert.equal(hasCapability(roles, "hr.manage"), true);
  assert.equal(hasCapability(roles, "finance.manage"), true);
  const caps = expandCapabilities(roles);
  assert.ok(caps.includes("hr.salary.read"));
  assert.ok(caps.includes("finance.approve"));
});

test("可分配角色目录均有中文标签", () => {
  for (const code of MANAGEABLE_ROLES) {
    assert.ok(ROLE_LABELS[code], `${code} 缺少标签`);
  }
});
