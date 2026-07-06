import { Injectable } from '@nestjs/common';
import { Tool } from '../tool.interface';
import { ProjectsService } from '../../projects/projects.service';
import { AtlasObject } from '../../protocol/messages';

/**
 * Mutating tool: patch an object's mutable fields (name, summary, content).
 * Objects themselves are created out-of-band by editing JSON files on disk —
 * this tool only edits existing entries. Field omitted → not changed.
 */
@Injectable()
export class UpdateObjectTool implements Tool {
  readonly name = 'update_object';
  readonly description =
    'Update mutable fields of an object in the active project. Call when the user wants to change or add information about a specific object, e.g. "Please note that this is a wooden chair" or "Change the description of that to …". Always resolve the referenced object via resolve_deixis first when the user points at it. Only include the fields that should change — omitted fields stay untouched.';
  readonly parameters = {
    type: 'object',
    properties: {
      focusId: {
        type: 'string',
        description: 'The object id, typically obtained from a resolve_deixis result.',
      },
      name: {
        type: 'string',
        description: 'New short human-readable label. Omit to leave unchanged.',
      },
      summary: {
        type: 'string',
        description: 'New short summary that will be injected into the system prompt on the next session start. Keep it under ~15 words. Omit to leave unchanged.',
      },
      content: {
        type: 'string',
        description: 'New full description body. Omit to leave unchanged.',
      },
    },
    required: ['focusId'],
  };

  constructor(private readonly projects: ProjectsService) {}

  async execute(args: unknown): Promise<unknown> {
    const patch = extractPatch(args);
    const active = this.projects.getActive();
    if (!active) return { error: 'No project active' };
    const exists = active.objects.some((o) => o.id === patch.focusId);
    if (!exists) return { error: `Object "${patch.focusId}" not found in active project` };
    const updated: AtlasObject = this.projects.updateObject(active.project.id, patch.focusId, {
      name: patch.name,
      summary: patch.summary,
      content: patch.content,
    });
    return { object: updated };
  }
}

interface UpdatePatch {
  focusId: string;
  name?: string;
  summary?: string;
  content?: string;
}

function extractPatch(args: unknown): UpdatePatch {
  if (!args || typeof args !== 'object') {
    throw new Error('update_object: expected object argument');
  }
  const raw = args as Record<string, unknown>;
  if (typeof raw['focusId'] !== 'string' || raw['focusId'].length === 0) {
    throw new Error('update_object: `focusId` must be a non-empty string');
  }
  const patch: UpdatePatch = { focusId: raw['focusId'] };
  for (const key of ['name', 'summary', 'content'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string') {
        throw new Error(`update_object: \`${key}\` must be a string when provided`);
      }
      patch[key] = raw[key] as string;
    }
  }
  return patch;
}
