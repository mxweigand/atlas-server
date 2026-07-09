import { Injectable } from '@nestjs/common';
import { Tool } from '../tool.interface';

/**
 * No-op tool per OpenAI's Realtime prompting guide: gives the model a valid
 * non-speaking action for audio that doesn't need a reply (silence,
 * background noise, hold music, side conversation, unaddressed speech) so it
 * doesn't fill the gap with filler like "I'm here" or "I didn't catch that".
 */
@Injectable()
export class WaitForUserTool implements Tool {
  readonly name = 'wait_for_user';
  readonly description =
    'Call this when the latest audio does not need a spoken response, such as silence, background noise, hold music, TV audio, side conversation, or speech not addressed to the assistant. This tool helps end the turn without a spoken reply.';
  readonly parameters = {
    type: 'object',
    properties: {},
    required: [],
  };

  async execute(): Promise<unknown> {
    return { ok: true };
  }
}
