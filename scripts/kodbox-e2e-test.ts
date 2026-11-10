import { KodboxClient } from "../packages/connectors/kodbox/src/kodbox-client.ts";

const client = new KodboxClient({
  baseUrl: "http://localhost:8080",
  username: "admin",
  password: "admin123",
});

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

async function main() {
  const login = await client.login();
  assert(login.code === 0 && login.data?.token, "login failed");
  console.log("login: ok");

  const root = await client.list("/");
  assert(root.code === 0, "list root failed");
  console.log("list root: ok");

  const dir = await client.mkdir("/", "e2e-test");
  assert(dir.code === 0, "mkdir failed");
  console.log("mkdir: ok");

  const fileContent = "hello from kodbox e2e test";
  const upload = await client.upload("/e2e-test", new Blob([fileContent]), "hello.txt");
  assert(upload.code === 0 && upload.data?.fid, "upload failed");
  console.log("upload: ok");

  const exists = await client.exists("/e2e-test/hello.txt");
  assert(exists, "uploaded file not found");
  console.log("exists: ok");

  const downloaded = await client.download("/e2e-test/hello.txt");
  assert(downloaded.size > 0, "download failed");
  console.log("download: ok");

  const share = await client.createShare("/e2e-test/hello.txt", { password: "123456", permission: "read" });
  assert(share.code === 0 && share.data?.share_id, "create share failed");
  console.log("create share: ok");

  const revoke = await client.revokeShare(share.data.share_id);
  assert(revoke.code === 0, "revoke share failed");
  console.log("revoke share: ok");

  const users = await client.listUsers();
  assert(users.code === 0, "list users failed");
  console.log("list users: ok");

  const deleted = await client.delete(["/e2e-test"]);
  assert(deleted.code === 0, "delete failed");
  console.log("delete: ok");

  console.log("kodbox_e2e_all_passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
