/**
 * memware kernel — service and extractor versions.
 *
 * `kernelVersion` is the deployed service version the backend records; it MUST
 * equal package.json "version" (a JSON import cannot be used here: tsconfig's
 * rootDir is src/, so importing ../../package.json would fail typecheck).
 * tests/kernel/server.test.ts asserts the two stay in sync.
 *
 * `extractorVersion` identifies the extraction contract — prompt wording,
 * output schema, gating rules. The backend stores it with every fact and
 * re-extracts when it changes, so ANY change to extractPrompt.ts or
 * extractSchema.ts semantics must bump it.
 */

export const kernelVersion = "0.2.0";
export const extractorVersion = "kernel-extract-v1";
