import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { parseAskArgs } from "../src/ask/ask.ts";

const USAGE = "Usage: huntaway ask [--engine pipe|anthropic] [--family claude|codex] [--model NAME] ...\n";

// Save and restore HUNTAWAY_ENGINE to guarantee zero environment leakage across the suite.
const originalHuntawayEngine = process.env.HUNTAWAY_ENGINE;

function restoreEngine() {
  if (originalHuntawayEngine === undefined) {
    delete process.env.HUNTAWAY_ENGINE;
  } else {
    process.env.HUNTAWAY_ENGINE = originalHuntawayEngine;
  }
}

beforeEach(restoreEngine);
afterEach(restoreEngine);
after(restoreEngine);

test("Codex pipe default model is gpt-6.1-sol with explicit --engine pipe", () => {
  delete process.env.HUNTAWAY_ENGINE;
  const options = parseAskArgs(["--engine", "pipe", "--family", "codex", "test question"], USAGE);
  assert.equal(options.engine, "pipe");
  assert.equal(options.family, "codex");
  assert.equal(options.model, "gpt-6.1-sol");
});

test("Codex pipe default model is gpt-6.1-sol when pipe engine is selected via HUNTAWAY_ENGINE", () => {
  process.env.HUNTAWAY_ENGINE = "pipe";
  const options = parseAskArgs(["--family", "codex", "test question"], USAGE);
  assert.equal(options.engine, "pipe");
  assert.equal(options.family, "codex");
  assert.equal(options.model, "gpt-6.1-sol");
});

test("explicit --model override (gpt-6-astra) is preserved with explicit --engine pipe", () => {
  delete process.env.HUNTAWAY_ENGINE;
  const options = parseAskArgs(["--engine", "pipe", "--family", "codex", "--model", "gpt-6-astra", "test question"], USAGE);
  assert.equal(options.engine, "pipe");
  assert.equal(options.family, "codex");
  assert.equal(options.model, "gpt-6-astra");
});

test("explicit --model override (gpt-6-astra) is preserved when pipe engine is selected via HUNTAWAY_ENGINE", () => {
  process.env.HUNTAWAY_ENGINE = "pipe";
  const options = parseAskArgs(["--family", "codex", "--model", "gpt-6-astra", "test question"], USAGE);
  assert.equal(options.engine, "pipe");
  assert.equal(options.family, "codex");
  assert.equal(options.model, "gpt-6-astra");
});

test("pipe Claude default model stays opus with explicit --engine pipe", () => {
  delete process.env.HUNTAWAY_ENGINE;
  const explicitFamily = parseAskArgs(["--engine", "pipe", "--family", "claude", "test question"], USAGE);
  assert.equal(explicitFamily.engine, "pipe");
  assert.equal(explicitFamily.family, "claude");
  assert.equal(explicitFamily.model, "opus");

  const defaultFamily = parseAskArgs(["--engine", "pipe", "test question"], USAGE);
  assert.equal(defaultFamily.engine, "pipe");
  assert.equal(defaultFamily.family, "claude");
  assert.equal(defaultFamily.model, "opus");
});

test("pipe Claude default model stays opus when pipe engine is selected via HUNTAWAY_ENGINE", () => {
  process.env.HUNTAWAY_ENGINE = "pipe";
  const explicitFamily = parseAskArgs(["--family", "claude", "test question"], USAGE);
  assert.equal(explicitFamily.engine, "pipe");
  assert.equal(explicitFamily.family, "claude");
  assert.equal(explicitFamily.model, "opus");

  const defaultFamily = parseAskArgs(["test question"], USAGE);
  assert.equal(defaultFamily.engine, "pipe");
  assert.equal(defaultFamily.family, "claude");
  assert.equal(defaultFamily.model, "opus");
});

test("standalone anthropic engine default model is claude-sonnet-5-5", () => {
  delete process.env.HUNTAWAY_ENGINE;
  const defaultEngine = parseAskArgs(["test question"], USAGE);
  assert.equal(defaultEngine.engine, "anthropic");
  assert.equal(defaultEngine.family, "claude");
  assert.equal(defaultEngine.model, "claude-sonnet-5-5");

  const explicitEngine = parseAskArgs(["--engine", "anthropic", "test question"], USAGE);
  assert.equal(explicitEngine.engine, "anthropic");
  assert.equal(explicitEngine.family, "claude");
  assert.equal(explicitEngine.model, "claude-sonnet-5-5");
});
