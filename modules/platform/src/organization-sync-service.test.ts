import test from "node:test";
import assert from "node:assert/strict";
import { OrganizationSyncService } from "./organization-sync-service.ts";
import type { FeishuOrganizationSource } from "../../../packages/connectors/feishu/src/index.ts";

test("组织同步按父部门、人员、成员关系、停用顺序在一个事务中执行", async () => {
  const calls: string[] = [];
  let eventPayload: Record<string, unknown> | undefined;
  const source: FeishuOrganizationSource = {
    async fetchFullSnapshot() {
      return {
        providerTenantId: "fs-1",
        mode: "full",
        capturedAt: "2026-08-30T00:00:00.000Z",
        orgUnits: [
          { externalId: "child", parentExternalId: "root", name: "研发部", active: true },
          { externalId: "root", name: "总部", active: true }
        ],
        people: [{
          externalId: "u1",
          name: "甲",
          primaryMobileSensitive: "sensitive-value-must-not-enter-event",
          departmentExternalIds: ["child"],
          primaryDepartmentExternalId: "child",
          active: true
        }]
      };
    },
    async fetchDeltaSnapshot() {
      throw new Error("not_used");
    }
  };
  const repository = {
    async loadProjection() {
      return {
        orgUnits: [{ externalId: "old", fingerprint: "old", active: true }],
        people: [{ externalId: "old-user", fingerprint: "old", active: true }]
      };
    },
    async transaction(_tenantId: string, work) {
      calls.push("transaction:start");
      const result = await work({
        async upsertOrgUnit(unit) { calls.push(`org:${unit.externalId}`); },
        async upsertPerson(person) { calls.push(`person:${person.externalId}`); },
        async replaceMemberships(change) { calls.push(`membership:${change.personExternalId}`); },
        async disablePerson(id) { calls.push(`disable-person:${id}`); },
        async disableOrgUnit(id) { calls.push(`disable-org:${id}`); },
        async saveCursor() { calls.push("cursor"); },
        async enqueueEvent(event) { calls.push("event"); eventPayload = event.payload; }
      });
      calls.push("transaction:end");
      return result;
    }
  };

  const summary = await new OrganizationSyncService(repository, source).syncFull("tenant-a");
  assert.deepEqual(calls, [
    "transaction:start",
    "org:root",
    "org:child",
    "person:u1",
    "membership:u1",
    "disable-person:old-user",
    "disable-org:old",
    "cursor",
    "event",
    "transaction:end"
  ]);
  assert.equal(summary.peopleUpserted, 1);
  assert.doesNotMatch(JSON.stringify(eventPayload), /sensitive-value/);
});

