export type UUID = string;

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export interface TenantScopedEntity {
  id: UUID;
  tenantId: UUID;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceRef {
  id: UUID;
  tenantId: UUID;
  domain: string;
  type: string;
  classification: DataClassification;
  ownerPersonId?: UUID;
  ownerOrgUnitId?: UUID;
  legalEntityId?: UUID;
}

export interface DomainEvent<TPayload = Record<string, unknown>> {
  eventId: UUID;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  tenantId: UUID;
  actorId: UUID;
  resource: ResourceRef;
  traceId: string;
  idempotencyKey: string;
  payload: TPayload;
}

