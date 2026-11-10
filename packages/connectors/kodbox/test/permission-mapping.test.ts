import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKodboxUsername,
  generateDepartmentPath,
  topologicalSortDepartments,
  getDepartmentUserIds,
  createPermissionAuditLog,
  type FeishuUser,
  type FeishuDepartment,
  type PermissionMappingRule,
} from "../src/permission-mapping.ts";

const mockUsers: FeishuUser[] = [
  { openId: "ou_1", name: "张三", departmentIds: ["dept_1"], status: "active" },
  { openId: "ou_2", name: "李四", departmentIds: ["dept_1", "dept_2"], status: "active" },
  { openId: "ou_3", name: "王五", departmentIds: ["dept_3"], status: "inactive" },
  { openId: "ou_4", name: "赵六", departmentIds: ["dept_2"], status: "active" },
];

const mockDepts: FeishuDepartment[] = [
  { openDepartmentId: "dept_1", name: "研发部", parentOpenDepartmentId: "dept_root", status: "active" },
  { openDepartmentId: "dept_2", name: "前端组", parentOpenDepartmentId: "dept_1", status: "active" },
  { openDepartmentId: "dept_3", name: "市场部", parentOpenDepartmentId: "dept_root", status: "active" },
  { openDepartmentId: "dept_root", name: "总部", status: "active" },
];

test("generateKodboxUsername 生成符合格式的用户名", () => {
  const username = generateKodboxUsername("ou_abc123");
  assert.equal(username, "fs_ou_abc123");
});

test("generateKodboxUsername 处理特殊字符", () => {
  const username = generateKodboxUsername("ou_abc@#$%");
  assert.equal(username, "fs_ou_abc____");
});

test("generateDepartmentPath 生成正确的部门路径", () => {
  const path = generateDepartmentPath("研发部", "/共享文件/部门文件");
  assert.equal(path, "/共享文件/部门文件/研发部");
});

test("generateDepartmentPath 处理特殊字符和空格", () => {
  const path = generateDepartmentPath("前端/后端组", "/共享文件");
  assert.equal(path, "/共享文件/前端_后端组");
});

test("topologicalSortDepartments 父部门在子部门之前", () => {
  const sorted = topologicalSortDepartments(mockDepts);
  const dept1Idx = sorted.findIndex((d) => d.openDepartmentId === "dept_1");
  const dept2Idx = sorted.findIndex((d) => d.openDepartmentId === "dept_2");
  const rootIdx = sorted.findIndex((d) => d.openDepartmentId === "dept_root");

  assert.ok(rootIdx < dept1Idx, "根部门应在研发部之前");
  assert.ok(dept1Idx < dept2Idx, "研发部应在前端组之前");
});

test("topologicalSortDepartments 忽略循环依赖", () => {
  const cyclicDepts: FeishuDepartment[] = [
    { openDepartmentId: "a", parentOpenDepartmentId: "b", name: "A", status: "active" },
    { openDepartmentId: "b", parentOpenDepartmentId: "a", name: "B", status: "active" },
  ];
  const sorted = topologicalSortDepartments(cyclicDepts);
  assert.equal(sorted.length, 2);
});

test("getDepartmentUserIds 只返回活跃用户", () => {
  const rules: PermissionMappingRule[] = [
    { departmentId: "dept_1", kodboxPath: "/test", permission: "read", inheritToChildren: false },
  ];
  const ids = getDepartmentUserIds(mockDepts, mockUsers, "dept_1", false);
  assert.deepEqual(ids.sort(), ["ou_1", "ou_2"].sort());
  assert.ok(!ids.includes("ou_3"), "非活跃用户不应包含");
});

test("getDepartmentUserIds inheritToChildren 包含子部门用户", () => {
  const ids = getDepartmentUserIds(mockDepts, mockUsers, "dept_1", true);
  // dept_1 有 ou_1, ou_2；dept_2 是子部门，有 ou_2, ou_4
  assert.ok(ids.includes("ou_1"));
  assert.ok(ids.includes("ou_2"));
  assert.ok(ids.includes("ou_4"));
  assert.ok(!ids.includes("ou_3"));
});

test("getDepartmentUserIds 不包含非活跃部门", () => {
  const deptsWithInactive: FeishuDepartment[] = [
    ...mockDepts,
    { openDepartmentId: "dept_4", parentOpenDepartmentId: "dept_1", name: "已解散组", status: "deleted" },
  ];
  const usersWithInactiveDept: FeishuUser[] = [
    ...mockUsers,
    { openId: "ou_5", name: "测试", departmentIds: ["dept_4"], status: "active" },
  ];
  const ids = getDepartmentUserIds(deptsWithInactive, usersWithInactiveDept, "dept_1", true);
  assert.ok(!ids.includes("ou_5"), "已解散部门的用户不应包含");
});

test("createPermissionAuditLog 生成完整的审计记录", () => {
  const log = createPermissionAuditLog({
    tenantId: "tenant_1",
    action: "grant",
    targetType: "user",
    targetId: "ou_1",
    kodboxPath: "/共享文件/部门文件/研发部",
    newPermission: "read_write",
    operatorId: "ou_admin",
    reason: "新员工入职授权",
  });

  assert.ok(log.id);
  assert.equal(log.tenantId, "tenant_1");
  assert.equal(log.action, "grant");
  assert.equal(log.targetType, "user");
  assert.equal(log.targetId, "ou_1");
  assert.equal(log.kodboxPath, "/共享文件/部门文件/研发部");
  assert.equal(log.newPermission, "read_write");
  assert.equal(log.operatorId, "ou_admin");
  assert.equal(log.reason, "新员工入职授权");
  assert.ok(log.createdAt);
  // 验证 ISO 8601 格式
  assert.ok(!isNaN(Date.parse(log.createdAt)));
});