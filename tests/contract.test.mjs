// The status contract: every fixture validates against the schema, and the schema itself refuses the things the
// contract promises never to carry. Zero dependencies: a small validator for exactly the keywords the schema uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { makeValidator } from "./lib/schema.mjs";

const root = new URL("../contract/", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("huntaway-status.schema.json", root), "utf8"));
const fixtureDir = new URL("fixtures/", root);
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));

const check = makeValidator(schema);
const validate = (s, v) => check(v, s);

const good = () => JSON.parse(readFileSync(new URL("all-states.json", fixtureDir), "utf8"));

test("every fixture validates and is marked as a fixture", () => {
  assert.ok(fixtures.length >= 4, "expected at least four fixtures");
  for (const f of fixtures) {
    const doc = JSON.parse(readFileSync(new URL(f, fixtureDir), "utf8"));
    assert.deepEqual(validate(schema, doc), [], f);
    assert.equal(doc.source, "fixture", `${f} must say source: fixture`);
  }
});

test("all-states covers every code, each with its status bucket", () => {
  const codes = new Set(good().runs.map((r) => r.code));
  assert.deepEqual([...codes].sort(), schema.$defs.run.properties.code.enum.slice().sort());
});

test("the schema refuses what the contract promises never to carry", () => {
  const cases = [
    ["a hostname instead of an alias", (d) => { d.machines[0].alias = "studio.example.net"; }],
    ["an alias with a quote", (d) => { d.machines[0].alias = "Sam's Mac"; }],
    ["an alias over 32 characters", (d) => { d.machines[0].alias = "A".repeat(33); }],
    ["an alias starting with a space", (d) => { d.machines[0].alias = " Studio"; }],
    ["a worker that is an address", (d) => { d.runs[0].worker = "192.0.2.5"; }],
    ["a code whose status bucket is wrong", (d) => { d.runs[2].status = "ended"; }],
    ["an unknown code", (d) => { d.runs[0].code = "thinking"; }],
    ["an extra field (e.g. prompt text)", (d) => { d.runs[0].prompt = "hello"; }],
    ["a local time instead of UTC", (d) => { d.asOf = "2026-09-30T02:45:00-04:00"; }],
    ["an http confirm link", (d) => { d.runs[0].confirmUrl = "http://example.slack.com/x"; }],
    ["a room reading in numbers", (d) => { d.machines[0].subscriptions[0].room = "70%"; }],
    ["schemaVersion 2", (d) => { d.schemaVersion = 2; }],
    ["a missing asOf", (d) => { delete d.asOf; }],
  ];
  for (const [label, mutate] of cases) {
    const d = good();
    mutate(d);
    assert.notDeepEqual(validate(schema, d), [], `should refuse ${label}`);
  }
});

test("no fixture or schema text carries a machine address or a home path", () => {
  const texts = [JSON.stringify(schema), ...fixtures.map((f) => readFileSync(new URL(f, fixtureDir), "utf8"))];
  for (const t of texts) {
    assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(t), "no IP addresses");
    assert.ok(!/\/Users\/|\/home\/[a-z]|\.local\b/i.test(t), "no home paths or local hostnames");
  }
});

test("an alias ending in a newline or a space is refused (the pattern is anchored to the whole string)", () => {
  for (const alias of ["Studio\n", "Studio ", "\nStudio"]) {
    const d = good();
    d.machines[0].alias = alias;
    assert.notDeepEqual(validate(schema, d), [], JSON.stringify(alias));
  }
});

test("any short owner-chosen alias is valid (not only Studio, Mini and Laptop)", () => {
  for (const alias of ["Studio", "Mini", "Laptop", "My Mac mini", "work_laptop-2", "x", "A-", "A".repeat(32)]) {
    const d = good();
    d.machines[0].alias = alias;
    d.runs[0].worker = alias;
    assert.deepEqual(validate(schema, d), [], alias);
  }
});
