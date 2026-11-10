import {
  planFeishuOrganizationSync,
  type CurrentOrganizationProjection,
  type FeishuOrganizationSnapshot,
  type FeishuOrganizationSource,
  type FeishuOrgUnitSnapshot,
  type FeishuPersonSnapshot,
  type OrganizationSyncPlan
} from "../../../packages/connectors/feishu/src/index.ts";

export interface OrganizationSyncTransaction {
  upsertOrgUnit(unit: FeishuOrgUnitSnapshot & { fingerprint: string }): Promise<void>;
  upsertPerson(person: FeishuPersonSnapshot & { fingerprint: string }): Promise<void>;
  replaceMemberships(change: OrganizationSyncPlan["membershipReplacements"][number]): Promise<void>;
  disablePerson(externalId: string): Promise<void>;
  disableOrgUnit(externalId: string): Promise<void>;
  saveCursor(providerTenantId: string, cursor: string | undefined, capturedAt: string): Promise<void>;
  enqueueEvent(event: {
    eventType: "platform.organization.synced.v1";
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface OrganizationSyncRepository {
  loadProjection(tenantId: string, providerTenantId: string): Promise<CurrentOrganizationProjection>;
  transaction<T>(tenantId: string, work: (transaction: OrganizationSyncTransaction) => Promise<T>): Promise<T>;
}

// 用 type 而非 interface：对象字面量类型拥有隐式索引签名，可直接作为 outbox 事件 payload（Record<string, unknown>）。
export type OrganizationSyncSummary = {
  providerTenantId: string;
  mode: "full" | "delta";
  orgUnitsUpserted: number;
  peopleUpserted: number;
  membershipsReplaced: number;
  orgUnitsDisabled: number;
  peopleDisabled: number;
  unchangedOrgUnits: number;
  unchangedPeople: number;
  cursor?: string;
};

export class OrganizationSyncService {
  private readonly repository: OrganizationSyncRepository;
  private readonly source: FeishuOrganizationSource;

  constructor(
    repository: OrganizationSyncRepository,
    source: FeishuOrganizationSource
  ) {
    this.repository = repository;
    this.source = source;
  }

  async syncFull(tenantId: string): Promise<OrganizationSyncSummary> {
    return this.execute(tenantId, await this.source.fetchFullSnapshot());
  }

  async syncDelta(tenantId: string, cursor: string): Promise<OrganizationSyncSummary> {
    return this.execute(tenantId, await this.source.fetchDeltaSnapshot(cursor));
  }

  private async execute(
    tenantId: string,
    snapshot: FeishuOrganizationSnapshot
  ): Promise<OrganizationSyncSummary> {
    const current = await this.repository.loadProjection(tenantId, snapshot.providerTenantId);
    const plan = planFeishuOrganizationSync(current, snapshot);

    const summary: OrganizationSyncSummary = {
      providerTenantId: plan.providerTenantId,
      mode: plan.mode,
      orgUnitsUpserted: plan.orgUnitUpserts.length,
      peopleUpserted: plan.personUpserts.length,
      membershipsReplaced: plan.membershipReplacements.length,
      orgUnitsDisabled: plan.orgUnitDisables.length,
      peopleDisabled: plan.personDisables.length,
      unchangedOrgUnits: plan.stats.unchangedOrgUnits,
      unchangedPeople: plan.stats.unchangedPeople,
      cursor: plan.cursor
    };

    await this.repository.transaction(tenantId, async (transaction) => {
      for (const unit of plan.orgUnitUpserts) await transaction.upsertOrgUnit(unit);
      for (const person of plan.personUpserts) await transaction.upsertPerson(person);
      for (const change of plan.membershipReplacements) await transaction.replaceMemberships(change);
      for (const externalId of plan.personDisables) await transaction.disablePerson(externalId);
      for (const externalId of plan.orgUnitDisables) await transaction.disableOrgUnit(externalId);

      await transaction.saveCursor(plan.providerTenantId, plan.cursor, snapshot.capturedAt);
      await transaction.enqueueEvent({
        eventType: "platform.organization.synced.v1",
        idempotencyKey: `feishu-org-sync:${plan.providerTenantId}:${plan.mode}:${plan.cursor ?? snapshot.capturedAt}`,
        payload: summary
      });
    });

    return summary;
  }
}
