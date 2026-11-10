import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const modulesPath = new URL("modules/", root);
const eventsPath = new URL("packages/contracts/events/", root);

const moduleEntries = (await readdir(modulesPath, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory());

const modules = [];
for (const entry of moduleEntries) {
  const file = new URL(`${entry.name}/module.json`, modulesPath);
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const field of ["name", "schema", "description", "ownedEntities", "publishes", "consumes"]) {
    if (!(field in manifest)) throw new Error(`${entry.name}/module.json missing ${field}`);
  }
  if (manifest.name !== entry.name) throw new Error(`${entry.name} manifest name mismatch`);
  modules.push(manifest);
}

const ownership = new Map();
for (const module of modules) {
  for (const entity of module.ownedEntities) {
    const key = `${module.schema}.${entity}`;
    if (ownership.has(key)) throw new Error(`${key} owned by both ${ownership.get(key)} and ${module.name}`);
    ownership.set(key, module.name);
  }
}

const eventFiles = (await readdir(eventsPath)).filter((name) => name.endsWith(".json"));
for (const name of eventFiles) {
  JSON.parse(await readFile(new URL(name, eventsPath), "utf8"));
}

const knownEvents = new Set(modules.flatMap((module) => module.publishes));
const unresolvedConsumers = modules.flatMap((module) =>
  module.consumes
    .filter((event) => !knownEvents.has(event))
    .map((event) => `${module.name}:${event}`)
);

if (unresolvedConsumers.length > 0) {
  console.warn(`External or future events: ${unresolvedConsumers.join(", ")}`);
}

console.log(JSON.stringify({
  status: "ok",
  modules: modules.length,
  ownedEntities: ownership.size,
  eventSchemas: eventFiles.length,
  publishedEvents: knownEvents.size
}, null, 2));

