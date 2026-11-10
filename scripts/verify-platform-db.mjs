import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const composeArgs = [
  "compose",
  "--env-file", ".env.example",
  "-f", "deploy/compose/docker-compose.yml"
];
const database = "feishu_hq_test";
// The Compose database owner is hq_admin. Migrations run as that role; the SQL
// integration test switches to hq_app so RLS and grants are exercised.
const migrationUser = "hq_admin";

function runDocker(args, options = {}) {
  const result = spawnSync("docker", [...composeArgs, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input: options.input
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

runDocker(["up", "-d", "--wait", "postgres"]);
runDocker(["exec", "-T", "postgres", "dropdb", "-U", migrationUser, "--if-exists", database]);
runDocker(["exec", "-T", "postgres", "createdb", "-U", migrationUser, database]);

const migrationDir = new URL("../database/migrations/", import.meta.url);
const migrations = (await readdir(migrationDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();

for (const migration of migrations) {
  const sql = await readFile(new URL(migration, migrationDir), "utf8");
  runDocker([
    "exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", migrationUser, "-d", database
  ], { input: sql });
  const checksum = createHash("sha256").update(sql).digest("hex");
  const escapedVersion = migration.replaceAll("'", "''");
  runDocker([
    "exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", migrationUser, "-d", database,
    "-c", `INSERT INTO platform.schema_migrations(version, checksum) VALUES ('${escapedVersion}', '${checksum}')`
  ]);
}

const testDir = new URL("../database/tests/", import.meta.url);
const tests = (await readdir(testDir)).filter((name) => name.endsWith(".sql")).sort();
for (const test of tests) {
  const sql = await readFile(new URL(test, testDir), "utf8");
  runDocker([
    "exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1",
    "-U", migrationUser, "-d", database
  ], { input: sql });
}

const migrationCount = runDocker([
  "exec", "-T", "postgres", "psql", "-X", "-A", "-t",
  "-U", migrationUser, "-d", database,
  "-c", "SELECT count(*) FROM platform.schema_migrations"
]).trim();

console.log(JSON.stringify({
  status: "ok",
  database,
  migrationsApplied: Number(migrationCount),
  sqlTests: tests.length
}, null, 2));

