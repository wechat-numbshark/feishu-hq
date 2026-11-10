import { createHash } from "node:crypto";

export type SyncMode = "full" | "delta";

export interface FeishuOrgUnitSnapshot {
  externalId: string;
  parentExternalId?: string;
  name: string;
  leaderExternalId?: string;
  order?: number;
  active: boolean;
  sourceUpdatedAt?: string;
}

export interface FeishuPersonSnapshot {
  externalId: string;
  unionId?: string;
  name: string;
  primaryEmail?: string;
  primaryMobileSensitive?: string;
  avatarUrl?: string;
  departmentExternalIds: string[];
  primaryDepartmentExternalId?: string;
  active: boolean;
  sourceUpdatedAt?: string;
}

export interface FeishuOrganizationSnapshot {
  providerTenantId: string;
  mode: SyncMode;
  cursor?: string;
  capturedAt: string;
  orgUnits: FeishuOrgUnitSnapshot[];
  people: FeishuPersonSnapshot[];
}

export interface CurrentExternalRecord {
  externalId: string;
  fingerprint: string;
  active: boolean;
}

export interface CurrentOrganizationProjection {
  orgUnits: CurrentExternalRecord[];
  people: CurrentExternalRecord[];
}

export interface OrganizationSyncPlan {
  providerTenantId: string;
  mode: SyncMode;
  cursor?: string;
  orgUnitUpserts: Array<FeishuOrgUnitSnapshot & { fingerprint: string }>;
  personUpserts: Array<FeishuPersonSnapshot & { fingerprint: string }>;
  membershipReplacements: Array<{
    personExternalId: string;
    departmentExternalIds: string[];
    primaryDepartmentExternalId?: string;
  }>;
  orgUnitDisables: string[];
  personDisables: string[];
  stats: {
    unchangedOrgUnits: number;
    unchangedPeople: number;
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

export function snapshotFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function ensureUnique<T extends { externalId: string }>(items: T[], label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.externalId) throw new Error(`${label}_external_id_required`);
    if (seen.has(item.externalId)) throw new Error(`${label}_duplicate_external_id:${item.externalId}`);
    seen.add(item.externalId);
  }
}

function sortOrgUnits(
  incoming: FeishuOrgUnitSnapshot[],
  currentExternalIds: Set<string>
): FeishuOrgUnitSnapshot[] {
  const byId = new Map(incoming.map((item) => [item.externalId, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const sorted: FeishuOrgUnitSnapshot[] = [];

  const visit = (externalId: string): void => {
    if (visited.has(externalId)) return;
    if (visiting.has(externalId)) throw new Error(`org_unit_cycle:${externalId}`);
    const unit = byId.get(externalId);
    if (!unit) return;

    visiting.add(externalId);
    if (unit.parentExternalId) {
      if (byId.has(unit.parentExternalId)) {
        visit(unit.parentExternalId);
      } else if (!currentExternalIds.has(unit.parentExternalId)) {
        throw new Error(`org_unit_parent_missing:${unit.externalId}->${unit.parentExternalId}`);
      }
    }
    visiting.delete(externalId);
    visited.add(externalId);
    sorted.push(unit);
  };

  [...byId.keys()].sort().forEach(visit);
  return sorted;
}

function normalizeOrgUnit(unit: FeishuOrgUnitSnapshot): FeishuOrgUnitSnapshot {
  return {
    ...unit,
    externalId: unit.externalId.trim(),
    parentExternalId: unit.parentExternalId?.trim() || undefined,
    leaderExternalId: unit.leaderExternalId?.trim() || undefined,
    name: unit.name.trim()
  };
}

function normalizePerson(person: FeishuPersonSnapshot): FeishuPersonSnapshot {
  const departments = [...new Set(person.departmentExternalIds.map((id) => id.trim()).filter(Boolean))].sort();
  return {
    ...person,
    externalId: person.externalId.trim(),
    unionId: person.unionId?.trim() || undefined,
    name: person.name.trim(),
    primaryEmail: person.primaryEmail?.trim().toLowerCase() || undefined,
    departmentExternalIds: departments,
    primaryDepartmentExternalId: person.primaryDepartmentExternalId?.trim() || undefined
  };
}

export function planFeishuOrganizationSync(
  current: CurrentOrganizationProjection,
  snapshot: FeishuOrganizationSnapshot
): OrganizationSyncPlan {
  if (!snapshot.providerTenantId.trim()) throw new Error("provider_tenant_id_required");
  if (!snapshot.capturedAt) throw new Error("captured_at_required");

  const orgUnits = snapshot.orgUnits.map(normalizeOrgUnit);
  const people = snapshot.people.map(normalizePerson);
  ensureUnique(orgUnits, "org_unit");
  ensureUnique(people, "person");

  const currentOrgById = new Map(current.orgUnits.map((item) => [item.externalId, item]));
  const currentPersonById = new Map(current.people.map((item) => [item.externalId, item]));
  const sortedOrgUnits = sortOrgUnits(orgUnits, new Set(currentOrgById.keys()));
  const incomingOrgIds = new Set(orgUnits.map((item) => item.externalId));
  const incomingPersonIds = new Set(people.map((item) => item.externalId));

  const orgUnitUpserts: OrganizationSyncPlan["orgUnitUpserts"] = [];
  const personUpserts: OrganizationSyncPlan["personUpserts"] = [];
  let unchangedOrgUnits = 0;
  let unchangedPeople = 0;

  for (const unit of sortedOrgUnits) {
    const fingerprint = snapshotFingerprint(unit);
    if (currentOrgById.get(unit.externalId)?.fingerprint === fingerprint) {
      unchangedOrgUnits += 1;
    } else {
      orgUnitUpserts.push({ ...unit, fingerprint });
    }
  }

  for (const person of people.sort((left, right) => left.externalId.localeCompare(right.externalId))) {
    for (const departmentId of person.departmentExternalIds) {
      if (!incomingOrgIds.has(departmentId) && !currentOrgById.has(departmentId)) {
        throw new Error(`person_department_missing:${person.externalId}->${departmentId}`);
      }
    }
    if (person.primaryDepartmentExternalId && !person.departmentExternalIds.includes(person.primaryDepartmentExternalId)) {
      throw new Error(`primary_department_not_in_memberships:${person.externalId}`);
    }

    const fingerprint = snapshotFingerprint(person);
    if (currentPersonById.get(person.externalId)?.fingerprint === fingerprint) {
      unchangedPeople += 1;
    } else {
      personUpserts.push({ ...person, fingerprint });
    }
  }

  return {
    providerTenantId: snapshot.providerTenantId,
    mode: snapshot.mode,
    cursor: snapshot.cursor,
    orgUnitUpserts,
    personUpserts,
    membershipReplacements: personUpserts.map((person) => ({
      personExternalId: person.externalId,
      departmentExternalIds: person.departmentExternalIds,
      primaryDepartmentExternalId: person.primaryDepartmentExternalId
    })),
    orgUnitDisables: snapshot.mode === "full"
      ? current.orgUnits.filter((item) => item.active && !incomingOrgIds.has(item.externalId)).map((item) => item.externalId).sort()
      : [],
    personDisables: snapshot.mode === "full"
      ? current.people.filter((item) => item.active && !incomingPersonIds.has(item.externalId)).map((item) => item.externalId).sort()
      : [],
    stats: { unchangedOrgUnits, unchangedPeople }
  };
}

