/**
 * Provenance metadata for durable memory writes.
 *
 * This module intentionally lives at the memory root instead of under
 * `unified/`: persisted memory records and cleanup code depend on provenance,
 * while unified extraction is only one writer that produces it.
 */

export interface ProvenanceMeta {
  source: 'unified-extraction-v1';
  session_id: string;
  turn_index: number;
  confidence: number;
  /** UTC ISO 8601 timestamp produced at extraction time. */
  extracted_at: string;
}

export interface ProvenanceDeleteFilter {
  sessionId?: string;
  turnIndex?: number;
  minConfidence?: number;
  source?: string;
}

export function makeProvenance(opts: {
  sessionId: string;
  turnIndex: number;
  confidence: number;
}): ProvenanceMeta {
  return {
    source: 'unified-extraction-v1',
    session_id: opts.sessionId,
    turn_index: opts.turnIndex,
    confidence: opts.confidence,
    extracted_at: new Date().toISOString(),
  };
}

export function provenanceMatches(
  prov: { source?: string; session_id?: string; turn_index?: number; confidence?: number } | undefined,
  filter: ProvenanceDeleteFilter,
): boolean {
  // Rows without provenance never match a filter — only attributable writes are
  // eligible for rollback.
  if (!prov) return false;
  if (filter.source !== undefined && prov.source !== filter.source) return false;
  if (filter.sessionId !== undefined && prov.session_id !== filter.sessionId) return false;
  if (filter.turnIndex !== undefined && prov.turn_index !== filter.turnIndex) return false;
  if (
    filter.minConfidence !== undefined &&
    typeof prov.confidence === "number" &&
    prov.confidence >= filter.minConfidence
  ) {
    return false;
  }
  return true;
}

/**
 * Build the narrowest vector metadata substring that is safe for a provenance
 * cleanup fallback.
 *
 * Vector rows currently carry source/session/turn in `metadata_source`, but not
 * confidence. Therefore confidence-filtered deletes must use exact vector ids
 * derived from deleted JSON clusters and must not do broad metadata deletion.
 */
export function vectorMetadataSubstringForProvenanceFilter(
  filter: ProvenanceDeleteFilter,
): string | null {
  if (filter.minConfidence !== undefined) return null;
  if (filter.source !== undefined && filter.sessionId !== undefined && filter.turnIndex !== undefined) {
    return `${filter.source}:session_id=${filter.sessionId}:turn=${filter.turnIndex}`;
  }
  if (filter.sessionId !== undefined && filter.turnIndex !== undefined) {
    return `session_id=${filter.sessionId}:turn=${filter.turnIndex}`;
  }
  if (filter.sessionId !== undefined) return `session_id=${filter.sessionId}`;
  if (filter.source !== undefined) return filter.source;
  return null;
}
