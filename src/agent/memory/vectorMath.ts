/**
 * avatanel Memory System — pure vector math.
 *
 * Extracted from vectorStore.ts so callers that must stay free of `bun:sqlite`
 * (the stateless kernel service in src/kernel/) can share the exact similarity
 * definition the local vector store uses. vectorStore.ts re-exports it, so the
 * function has one implementation and one behaviour.
 */

/**
 * Cosine similarity of two equal-length vectors.
 * Returns 0 for empty, mismatched, or zero-norm inputs (never NaN).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
