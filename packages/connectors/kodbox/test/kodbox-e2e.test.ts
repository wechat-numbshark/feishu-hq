/**
 * Kodbox E2E 集成测试
 * 真实连接运行在 localhost:8080 的 Kodbox 服务
 * 验证：上传、下载、分享、撤销分享、权限映射、用户/部门同步
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  KodboxClient,
  createKodboxClient,
  syncFeishuOrganizationToKodbox,
  generateKodboxUsername,
  generateDepartmentPath,
  topologicalSortDepartments,
  getDepartmentUserIds,
} from "../src/index.ts";
import type {
  FeishuUser,
  FeishuDepartment,
  PermissionMappingRule,
} from "../src/permission-mapping.ts";

// 测试配置 - 使用 docker-compose.yml 中的默认值
const KODBOX_CONFIG = {
  baseUrl: "http://localhost:8080",
  username: "admin",
  password: "change_me",
  timeoutMs: 30000,
};

let kodboxClient: KodboxClient;

test.before(async () => {
  kodboxClient = createKodboxClient(KODBOX_CONFIG);
  // 预热登录
  const auth = await kodboxClient.login();
  assert.equal(auth.code, 0, `Kodbox 登录失败: ${auth.message}`);
  assert.ok(auth.data?.token, "登录应返回 token");
});

test.after(async () => {
  // 清理测试创建的资源（可选，视情况保留以便人工检查）
});

test("Kodbox E2E - 登录认证", async () => {
  const auth = await kodboxClient.login();
  assert.equal(auth.code, 0);
  assert.ok(auth.data?.token);
  assert.ok(auth.data?.user?.uid > 0);
});

test("Kodbox E2E - 列出根目录", async () => {
  const list = await kodboxClient.list("/");
  assert.equal(list.code, 0);
  assert.ok(Array.isArray(list.data.list));
});

test("Kodbox E2E - 创建目录并验证存在", async () => {
  const testDirName = `e2e_test_${Date.now()}`;
  const mkdirResp = await kodboxClient.mkdir("/", testDirName);
  assert.equal(mkdirResp.code, 0, `创建目录失败: ${mkdirResp.message}`);

  const exists = await kodboxClient.exists(`/${testDirName}`);
  assert.equal(exists, true, "目录应存在");

  // 清理
  await kodboxClient.delete([`/${testDirName}`]);
});

test("Kodbox E2E - 上传文件、下载、验证内容", async () => {
  const testDir = `e2e_test_${Date.now()}`;
  await kodboxClient.mkdir("/", testDir);

  const fileName = "test_content.txt";
  const fileContent = `E2E test content ${Date.now()}`;
  const fileBlob = new Blob([fileContent], { type: "text/plain" });

  const uploadResp = await kodboxClient.upload(`/${testDir}`, fileBlob, fileName);
  assert.equal(uploadResp.code, 0, `上传失败: ${uploadResp.message}`);
  assert.ok(uploadResp.data?.fid);

  const downloadBlob = await kodboxClient.download(`/${testDir}/${fileName}`);
  const downloadedText = await downloadBlob.text();
  assert.equal(downloadedText, fileContent, "下载内容应与上传一致");

  // 清理
  await kodboxClient.delete([`/${testDir}`]);
});

test("Kodbox E2E - 创建分享链接并撤销", async () => {
  const testDir = `e2e_share_${Date.now()}`;
  await kodboxClient.mkdir("/", testDir);

  const fileName = "share_test.txt";
  const fileBlob = new Blob(["share test content"], { type: "text/plain" });
  await kodboxClient.upload(`/${testDir}`, fileBlob, fileName);

  // 创建分享
  const shareResp = await kodboxClient.createShare(`/${testDir}/${fileName}`, {
    password: "test123",
    expireDays: 1,
    permission: "read",
  });
  assert.equal(shareResp.code, 0, `创建分享失败: ${shareResp.message}`);
  assert.ok(shareResp.data?.share_id);
  assert.ok(shareResp.data?.share_url);
  const shareId = shareResp.data.share_id;

  // 验证分享链接可访问（可选，因为需要额外处理密码）
  assert.ok(shareResp.data.share_url.includes("share"));

  // 撤销分享
  const revokeResp = await kodboxClient.revokeShare(shareId);
  assert.equal(revokeResp.code, 0, `撤销分享失败: ${revokeResp.message}`);

  // 清理
  await kodboxClient.delete([`/${testDir}`]);
});

test("Kodbox E2E - 设置/获取路径权限", async () => {
  const testDir = `e2e_perm_${Date.now()}`;
  await kodboxClient.mkdir("/", testDir);

  // 先创建一个测试用户
  const testUsername = `test_user_${Date.now()}`;
  const createUserResp = await kodboxClient.createUser(testUsername, "TestPass123!", "user", `/${testDir}/home`);
  if (createUserResp.code !== 0) {
    // 用户可能已存在，忽略
  }

  // 获取用户列表找到刚创建的用户
  const usersResp = await kodboxClient.listUsers();
  assert.equal(usersResp.code, 0);
  const testUser = usersResp.data.list.find((u) => u.username === testUsername);
  assert.ok(testUser, "测试用户应存在");

  // 设置权限
  const permResp = await kodboxClient.setPathPermission(`/${testDir}`, String(testUser.uid), "read_write");
  assert.equal(permResp.code, 0, `设置权限失败: ${permResp.message}`);

  // 获取权限列表验证
  const permList = await kodboxClient.getPathPermissions(`/${testDir}`);
  assert.equal(permList.code, 0);
  const found = permList.data.find((p) => p.user_id === String(testUser.uid) && p.permission === "read_write");
  assert.ok(found, "权限应已设置");

  // 清理
  await kodboxClient.delete([`/${testDir}`]);
});

test("Kodbox E2E - 完整权限映射流程：飞书用户/部门同步到 Kodbox", async () => {
  // 模拟飞书组织数据
  const feishuUsers: FeishuUser[] = [
    {
      openId: `ou_e2e_user1_${Date.now()}`,
      unionId: `union_${Date.now()}_1`,
      userId: "user1",
      name: "测试用户1",
      email: "user1@test.example",
      departmentIds: ["dept_rd"],
      primaryDepartmentId: "dept_rd",
      status: "active",
    },
    {
      openId: `ou_e2e_user2_${Date.now()}`,
      unionId: `union_${Date.now()}_2`,
      userId: "user2",
      name: "测试用户2",
      email: "user2@test.example",
      departmentIds: ["dept_fe"],
      primaryDepartmentId: "dept_fe",
      status: "active",
    },
  ];

  const feishuDepartments: FeishuDepartment[] = [
    {
      openDepartmentId: "dept_rd",
      name: "研发部",
      status: "active",
    },
    {
      openDepartmentId: "dept_fe",
      parentOpenDepartmentId: "dept_rd",
      name: "前端组",
      status: "active",
    },
  ];

  const mappingRules: PermissionMappingRule[] = [
    {
      departmentId: "dept_rd",
      kodboxPath: "/共享文件/部门文件/研发部",
      permission: "read_write",
      inheritToChildren: true,
    },
    {
      departmentId: "dept_fe",
      kodboxPath: "/共享文件/部门文件/研发部/前端组",
      permission: "write",
      inheritToChildren: false,
    },
  ];

  const result = await syncFeishuOrganizationToKodbox(
    kodboxClient,
    feishuUsers,
    feishuDepartments,
    mappingRules
  );

  // 验证同步结果
  assert.ok(result.usersCreated >= 2, `应创建至少 2 个用户，实际: ${result.usersCreated}`);
  assert.ok(result.directoriesCreated >= 2, `应创建至少 2 个部门目录，实际: ${result.directoriesCreated}`);
  assert.ok(result.permissionsApplied >= 2, `应应用至少 2 条权限，实际: ${result.permissionsApplied}`);
  assert.equal(result.errors.length, 0, `不应有错误: ${result.errors.join(", ")}`);

  // 验证用户主目录存在
  for (const user of feishuUsers) {
    const homePath = `/个人文件/${user.name}_${user.openId.slice(0, 8)}`;
    const exists = await kodboxClient.exists(homePath);
    assert.equal(exists, true, `用户主目录 ${homePath} 应存在`);
  }

  // 验证部门目录存在
  assert.ok(await kodboxClient.exists("/共享文件/部门文件/研发部"), "研发部目录应存在");
  assert.ok(await kodboxClient.exists("/共享文件/部门文件/研发部/前端组"), "前端组目录应存在");

  // 验证权限已应用（通过列出权限检查）
  const permRd = await kodboxClient.getPathPermissions("/共享文件/部门文件/研发部");
  assert.equal(permRd.code, 0);
  assert.ok(permRd.data.length >= 2, "研发部目录应有至少 2 个用户权限");

  const permFe = await kodboxClient.getPathPermissions("/共享文件/部门文件/研发部/前端组");
  assert.equal(permFe.code, 0);
  assert.ok(permFe.data.length >= 1, "前端组目录应有至少 1 个用户权限");
});

test("Kodbox E2E - generateKodboxUsername 生成正确格式", () => {
  const username = generateKodboxUsername("ou_abc123");
  assert.equal(username, "fs_ou_abc123");
});

test("Kodbox E2E - generateDepartmentPath 生成正确路径", () => {
  const path = generateDepartmentPath("研发部", "/共享文件/部门文件");
  assert.equal(path, "/共享文件/部门文件/研发部");
});

test("Kodbox E2E - topologicalSortDepartments 父部门在前", () => {
  const depts: FeishuDepartment[] = [
    { openDepartmentId: "child", parentOpenDepartmentId: "parent", name: "子部门", status: "active" },
    { openDepartmentId: "parent", name: "父部门", status: "active" },
  ];
  const sorted = topologicalSortDepartments(depts);
  assert.equal(sorted[0].openDepartmentId, "parent");
  assert.equal(sorted[1].openDepartmentId, "child");
});

test("Kodbox E2E - getDepartmentUserIds 正确获取部门及子部门用户", () => {
  const depts: FeishuDepartment[] = [
    { openDepartmentId: "parent", name: "父部门", status: "active" },
    { openDepartmentId: "child", parentOpenDepartmentId: "parent", name: "子部门", status: "active" },
  ];
  const users: FeishuUser[] = [
    { openId: "u1", name: "用户1", departmentIds: ["parent"], primaryDepartmentId: "parent", status: "active" },
    { openId: "u2", name: "用户2", departmentIds: ["child"], primaryDepartmentId: "child", status: "active" },
    { openId: "u3", name: "用户3", departmentIds: ["other"], primaryDepartmentId: "other", status: "active" },
  ];

  const withChildren = getDepartmentUserIds(depts, users, "parent", true);
  assert.ok(withChildren.includes("u1"));
  assert.ok(withChildren.includes("u2"));
  assert.ok(!withChildren.includes("u3"));

  const withoutChildren = getDepartmentUserIds(depts, users, "parent", false);
  assert.ok(withoutChildren.includes("u1"));
  assert.ok(!withoutChildren.includes("u2"));
});