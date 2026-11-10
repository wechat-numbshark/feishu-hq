import { readdir, readFile } from "node:fs/promises";

const migrationDir = new URL("../database/migrations/", import.meta.url);
const files = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();

if (files.length === 0) throw new Error("No SQL migrations found");

let expected = 1;
for (const file of files) {
  const prefix = Number(file.slice(0, 4));
  if (prefix !== expected) throw new Error(`Expected migration ${String(expected).padStart(4, "0")}, got ${file}`);
  const sql = await readFile(new URL(file, migrationDir), "utf8");
  if ((sql.match(/\bBEGIN\s*;/gi) ?? []).length !== 1) throw new Error(`${file} must contain exactly one BEGIN`);
  if ((sql.match(/\bCOMMIT\s*;/gi) ?? []).length !== 1) throw new Error(`${file} must contain exactly one COMMIT`);
  if (/\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i.test(sql)) throw new Error(`${file} contains a destructive DROP`);
  if (/PASSWORD\s*=|sk-or-v1-|BEGIN PRIVATE KEY/i.test(sql)) throw new Error(`${file} may contain a secret`);
  expected += 1;
}

console.log(JSON.stringify({ status: "ok", migrations: files.length }, null, 2));

