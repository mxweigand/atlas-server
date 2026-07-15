import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

/** One entry in the focus ring buffer. */
export interface FocusSample {
  wallclockMs: number;
  focusId: string | null;
}

/**
 * One entry in the transcript-delta ring buffer. `deltaIndex` is the running
 * position of this delta within its `itemId` (0-based) so the debug client
 * can address the correct delta box in its UI when we return a resolution.
 */
export interface DeltaSample {
  itemId: string;
  deltaIndex: number;
  wallclockMs: number;
  text: string;
}

/** Input to the resolver — one deictic reference the assistant wants located. */
export interface DeixisReference {
  phrase: string;
  context: string;
}

/** Output of the resolver — one resolution per input reference, in order. */
export interface DeixisResolution {
  phrase: string;
  focusId: string | null;
  itemId: string | null;
  deltaIndex: number | null;
  spokenAtMs: number | null;
  focusEventTimeMs: number | null;
  confidence: 'high' | 'medium' | 'low';
  error?: string;
}

/**
 * Two rolling buffers (focus + transcription deltas) plus a resolver that
 * substring-matches a reference's `context` in the recent transcript, subtracts
 * the pipeline latency, and looks up the focus that was active at that moment.
 *
 * The buffers are global (not per turn) — pruning is purely time-based. That
 * way a late-arriving delta or focus sample from the tail of a previous turn
 * is still queryable if the assistant asks about it.
 */
@Injectable()
export class DeixisService {
  private readonly logger = new Logger(DeixisService.name);

  private focusBuffer: FocusSample[] = [];
  private deltaBuffer: DeltaSample[] = [];

  private readonly pipelineLatencyMs: number;
  private readonly focusBufferMs: number;
  private readonly deltaBufferMs: number;
  private readonly ambiguityWindowMs: number;
  private readonly staleThresholdMs: number;

  constructor(config: ConfigService<AppConfig, true>) {
    const cfg = config.get('deixis', { infer: true }) as AppConfig['deixis'];
    this.pipelineLatencyMs = cfg.pipelineLatencyMs;
    this.focusBufferMs = cfg.focusBufferMs;
    this.deltaBufferMs = cfg.deltaBufferMs;
    this.ambiguityWindowMs = cfg.ambiguityWindowMs;
    this.staleThresholdMs = cfg.staleThresholdMs;
  }

  recordFocus(sample: FocusSample): void {
    this.focusBuffer.push(sample);
    this.pruneByAge(this.focusBuffer, this.focusBufferMs, sample.wallclockMs);
  }

  recordDelta(sample: DeltaSample): void {
    this.deltaBuffer.push(sample);
    this.pruneByAge(this.deltaBuffer, this.deltaBufferMs, sample.wallclockMs);
  }

  resolve(references: DeixisReference[]): DeixisResolution[] {
    return references.map(ref => this.resolveOne(ref));
  }

  private resolveOne(ref: DeixisReference): DeixisResolution {
    // Group deltas by itemId and concatenate in receive order. We search each
    // item's concatenated text for the reference context, preferring the most
    // recent match.
    const byItem = groupByItem(this.deltaBuffer);
    const contextNeedle = ref.context.trim().toLowerCase();
    const phraseNeedle = ref.phrase.trim().toLowerCase();

    let match: { itemId: string; startChar: number; endChar: number; contextExact: boolean } | null = null;
    // Iterate items newest-first (by first delta wallclock desc).
    const itemsNewestFirst = [...byItem.entries()].sort(
      (a, b) => b[1][0].wallclockMs - a[1][0].wallclockMs,
    );
    for (const [itemId, deltas] of itemsNewestFirst) {
      const concatenated = deltas.map(d => d.text).join('').toLowerCase();
      let idx = contextNeedle.length > 0 ? concatenated.lastIndexOf(contextNeedle) : -1;
      let contextExact = idx >= 0;
      if (!contextExact) {
        idx = concatenated.lastIndexOf(phraseNeedle);
        if (idx < 0) continue;
      }
      // Locate the phrase inside the matched range (or fall back to idx if we
      // already matched on phrase directly).
      const phraseStart = contextExact
        ? concatenated.indexOf(phraseNeedle, idx)
        : idx;
      if (phraseStart < 0) continue;
      match = {
        itemId,
        startChar: phraseStart,
        endChar: phraseStart + phraseNeedle.length,
        contextExact,
      };
      break;
    }

    if (!match) {
      return {
        phrase: ref.phrase,
        focusId: null,
        itemId: null,
        deltaIndex: null,
        spokenAtMs: null,
        focusEventTimeMs: null,
        confidence: 'low',
        error: 'phrase not found in recent transcript',
      };
    }

    // Find the delta that contains the phrase's start position.
    const deltas = byItem.get(match.itemId)!;
    let cursor = 0;
    let hitDelta: DeltaSample | null = null;
    for (const d of deltas) {
      const end = cursor + d.text.length;
      if (match.startChar >= cursor && match.startChar < end) {
        hitDelta = d;
        break;
      }
      cursor = end;
    }
    if (!hitDelta) {
      return {
        phrase: ref.phrase,
        focusId: null,
        itemId: match.itemId,
        deltaIndex: null,
        spokenAtMs: null,
        focusEventTimeMs: null,
        confidence: 'low',
        error: 'internal: phrase position outside deltas',
      };
    }

    const spokenAtMs = hitDelta.wallclockMs - this.pipelineLatencyMs;
    const focusSample = this.focusAt(spokenAtMs);

    // Two independent quality checks scored alongside the contextExact gate:
    // does the focus id churn right around the estimated speak time (ambiguous),
    // and is there a fresh focus sample at/before it (gap)?
    const ambiguous = this.focusChangesNear(spokenAtMs);
    const gap = !this.hasRecentFocus(spokenAtMs);
    const confidence = deriveConfidence(match.contextExact, focusSample !== null, ambiguous, gap);

    return {
      phrase: ref.phrase,
      focusId: focusSample?.focusId ?? null,
      itemId: hitDelta.itemId,
      deltaIndex: hitDelta.deltaIndex,
      spokenAtMs,
      focusEventTimeMs: focusSample?.wallclockMs ?? null,
      confidence,
      error: focusSample ? undefined : 'no focus events in relevant time window',
    };
  }

  /**
   * Newest focus sample with wallclockMs <= t, or (if none is that old) the
   * nearest sample in a small forward tolerance window.
   */
  private focusAt(t: number): FocusSample | null {
    const backward = this.newestFocusAtOrBefore(t);
    if (backward) return backward;
    // Fallback: nearest sample within 500ms forward window.
    const tolerance = 500;
    let nearest: { s: FocusSample; d: number } | null = null;
    for (const s of this.focusBuffer) {
      const d = Math.abs(s.wallclockMs - t);
      if (d <= tolerance && (!nearest || d < nearest.d)) nearest = { s, d };
    }
    return nearest?.s ?? null;
  }

  /** Newest focus sample at or before t, ignoring the forward fallback. */
  private newestFocusAtOrBefore(t: number): FocusSample | null {
    let best: FocusSample | null = null;
    for (const s of this.focusBuffer) {
      if (s.wallclockMs <= t && (!best || s.wallclockMs > best.wallclockMs)) best = s;
    }
    return best;
  }

  /**
   * Ambiguity check: true if the active focus id changes anywhere within
   * `spokenAtMs ± ambiguityWindowMs`. Changes are detected between neighbouring
   * samples (transitions to/from `null` included) and count when either sample
   * of the transition falls inside the window, so a switch on either side of
   * the estimated speak time is caught — that is exactly the case where a small
   * latency error would flip the result to the other object.
   */
  private focusChangesNear(spokenAtMs: number): boolean {
    const lo = spokenAtMs - this.ambiguityWindowMs;
    const hi = spokenAtMs + this.ambiguityWindowMs;
    const sorted = [...this.focusBuffer].sort((a, b) => a.wallclockMs - b.wallclockMs);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.focusId === cur.focusId) continue;
      const prevIn = prev.wallclockMs >= lo && prev.wallclockMs <= hi;
      const curIn = cur.wallclockMs >= lo && cur.wallclockMs <= hi;
      if (prevIn || curIn) return true;
    }
    return false;
  }

  /**
   * Gap check: true if there is a focus sample at or before spokenAtMs whose age
   * is within `staleThresholdMs`. False when the newest prior sample is stale or
   * when the only usable sample came from the forward-tolerance fallback (i.e.
   * lies after spokenAtMs) — both mean the pointing stream had a reporting gap.
   */
  private hasRecentFocus(spokenAtMs: number): boolean {
    const backward = this.newestFocusAtOrBefore(spokenAtMs);
    if (!backward) return false;
    return spokenAtMs - backward.wallclockMs <= this.staleThresholdMs;
  }

  private pruneByAge<T extends { wallclockMs: number }>(
    buf: T[],
    windowMs: number,
    nowMs: number,
  ): void {
    const cutoff = nowMs - windowMs;
    let drop = 0;
    for (const item of buf) {
      if (item.wallclockMs < cutoff) drop++;
      else break;
    }
    if (drop > 0) buf.splice(0, drop);
  }
}

function groupByItem(deltas: DeltaSample[]): Map<string, DeltaSample[]> {
  const byItem = new Map<string, DeltaSample[]>();
  for (const d of deltas) {
    const list = byItem.get(d.itemId) ?? [];
    list.push(d);
    byItem.set(d.itemId, list);
  }
  return byItem;
}

/**
 * contextExact and available focus data are hard gates. Above them the score is
 * driven by two independent checks — `ambiguous` (a focus change near the speak
 * time) and `gap` (no fresh focus sample at/before it): neither failing → high,
 * exactly one failing → medium, otherwise (no context match, no focus data, or
 * both checks failing) → low.
 */
function deriveConfidence(
  contextExact: boolean,
  hasFocus: boolean,
  ambiguous: boolean,
  gap: boolean,
): 'high' | 'medium' | 'low' {
  if (!contextExact || !hasFocus) return 'low';
  const failures = (ambiguous ? 1 : 0) + (gap ? 1 : 0);
  if (failures === 0) return 'high';
  if (failures === 1) return 'medium';
  return 'low';
}
