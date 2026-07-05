import { Injectable } from '@nestjs/common';
import { Tool } from '../tool.interface';
import { DeixisService, DeixisReference } from '../../deixis/deixis.service';

/**
 * Tool the assistant calls when the user references an object by pointing.
 * The assistant provides the deictic phrase plus a surrounding transcript
 * snippet; the server locates that snippet in its rolling transcript buffer
 * and reads back the focus that was active at the estimated speak time.
 */
@Injectable()
export class ResolveDeixisTool implements Tool {
  readonly name = 'resolve_deixis';
  readonly description =
    'Resolve deictic references ("this", "that", "here", "over there", "dieses", "das", "hier"…) to concrete object ids by aligning the transcript timing against the pointing stream. Call with every pointing reference from the current user turn in one call. Do NOT call for filler uses of these words.';
  readonly parameters = {
    type: 'object',
    properties: {
      references: {
        type: 'array',
        description: 'One entry per deictic reference the user made in this turn, in order of occurrence.',
        items: {
          type: 'object',
          properties: {
            phrase: {
              type: 'string',
              description: 'The deictic word or short phrase, exactly as it appears in the transcript (e.g. "das", "this one").',
            },
            context: {
              type: 'string',
              description: 'A 5–10 word snippet from the transcript surrounding the phrase, used to disambiguate multiple occurrences.',
            },
          },
          required: ['phrase', 'context'],
        },
      },
    },
    required: ['references'],
  };

  constructor(private readonly deixis: DeixisService) {}

  async execute(args: unknown): Promise<unknown> {
    const references = extractReferences(args);
    const resolutions = this.deixis.resolve(references);
    return { resolutions };
  }
}

function extractReferences(args: unknown): DeixisReference[] {
  if (!args || typeof args !== 'object') {
    throw new Error('resolve_deixis: expected object with `references` array');
  }
  const raw = (args as { references?: unknown }).references;
  if (!Array.isArray(raw)) {
    throw new Error('resolve_deixis: `references` must be an array');
  }
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') {
      throw new Error(`resolve_deixis: reference[${i}] must be an object`);
    }
    const { phrase, context } = r as { phrase?: unknown; context?: unknown };
    if (typeof phrase !== 'string' || phrase.length === 0) {
      throw new Error(`resolve_deixis: reference[${i}].phrase must be a non-empty string`);
    }
    if (typeof context !== 'string') {
      throw new Error(`resolve_deixis: reference[${i}].context must be a string`);
    }
    return { phrase, context };
  });
}
