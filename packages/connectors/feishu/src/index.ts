export * from "./organization-sync.ts";

export interface FeishuOrganizationSource {
  fetchFullSnapshot(): Promise<import("./organization-sync.ts").FeishuOrganizationSnapshot>;
  fetchDeltaSnapshot(cursor: string): Promise<import("./organization-sync.ts").FeishuOrganizationSnapshot>;
}

