import { Injectable } from '@nestjs/common';
import { Tool } from '../tool.interface';
import { ProjectsService } from '../../projects/projects.service';

/**
 * Read-only tool: fetch the stored data for a specific object. The assistant
 * turns the returned record into natural language on its own — this tool just
 * hands over the raw fields (name, summary, content).
 */
@Injectable()
export class GetObjectTool implements Tool {
  readonly name = 'get_object';
  readonly description =
    'Fetch the stored fields of an object in the active project (name, summary, content). Call after resolve_deixis has returned a focusId when you need details you don\'t already have from the project overview. The tool only returns the raw data — describing it to the user is your job.';
  readonly parameters = {
    type: 'object',
    properties: {
      focusId: {
        type: 'string',
        description: 'The object id, typically obtained from a resolve_deixis result.',
      },
    },
    required: ['focusId'],
  };

  constructor(private readonly projects: ProjectsService) {}

  async execute(args: unknown): Promise<unknown> {
    const focusId = extractFocusId(args);
    const active = this.projects.getActive();
    if (!active) return { error: 'No project active' };
    const obj = active.objects.find((o) => o.id === focusId);
    if (!obj) return { error: `Object "${focusId}" not found in active project` };
    return { id: obj.id, name: obj.name, summary: obj.summary, content: obj.content };
  }
}

function extractFocusId(args: unknown): string {
  if (!args || typeof args !== 'object') {
    throw new Error('get_object: expected object with `focusId`');
  }
  const { focusId } = args as { focusId?: unknown };
  if (typeof focusId !== 'string' || focusId.length === 0) {
    throw new Error('get_object: `focusId` must be a non-empty string');
  }
  return focusId;
}
