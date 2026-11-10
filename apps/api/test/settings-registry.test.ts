import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTING_DEFINITIONS,
  getSettingDefinition,
  listSettingDefinitions,
  validateSettingValue,
  normalizeSettingValue,
  resolveSettingValue,
  getSettingsSchema,
} from "../src/settings-registry.ts";

test("registry contains finance approval_threshold_cents with correct metadata", () => {
  const def = getSettingDefinition("finance", "approval_threshold_cents");
  assert.ok(def);
  assert.equal(def.type, "integer");
  assert.equal(def.defaultValue, 500000);
  assert.equal(def.min, 0);
  assert.equal(def.consumer, "finance.expense.approval");
});

test("listSettingDefinitions returns only finance namespace", () => {
  const list = listSettingDefinitions("finance");
  assert.equal(list.length, 3);
  assert.ok(list.every(d => d.namespace === "finance"));
});

test("validateSettingValue rejects non-integer for integer field", () => {
  const def = getSettingDefinition("finance", "approval_threshold_cents")!;
  assert.equal(validateSettingValue(def, 123.45), "must_be_integer");
  assert.equal(validateSettingValue(def, "100"), "must_be_integer");
  assert.equal(validateSettingValue(def, 100), null);
});

test("validateSettingValue enforces min/max", () => {
  const def = getSettingDefinition("finance", "expense_deadline_day")!;
  assert.equal(validateSettingValue(def, 0), "below_min_1");
  assert.equal(validateSettingValue(def, 29), "above_max_28");
  assert.equal(validateSettingValue(def, 15), null);
});

test("normalizeSettingValue throws on invalid", () => {
  const def = getSettingDefinition("finance", "approval_threshold_cents")!;
  assert.throws(() => normalizeSettingValue(def, -1), /invalid_setting_value/);
  assert.doesNotThrow(() => normalizeSettingValue(def, 250000));
});

test("resolveSettingValue falls back to default on invalid stored value", () => {
  const def = getSettingDefinition("finance", "approval_threshold_cents")!;
  assert.equal(resolveSettingValue(def, undefined), 500000);
  assert.equal(resolveSettingValue(def, null), 500000);
  assert.equal(resolveSettingValue(def, "oops"), 500000);
  assert.equal(resolveSettingValue(def, 300000), 300000);
});

test("getSettingsSchema returns schema without namespace", () => {
  const schema = getSettingsSchema("finance");
  assert.ok(schema.approval_threshold_cents);
  assert.ok(!("namespace" in schema.approval_threshold_cents));
  assert.equal(schema.approval_threshold_cents.type, "integer");
});