import { Injectable, Logger } from '@nestjs/common';
import { Tool } from './tool.interface';
import { OpenAIToolSchema, ToolCall } from '../openai/realtime.service';

/**
 * Registry for tools the voice agent can invoke. The BrokerService queries
 * `getActiveSchemas()` once at boot and again on every project activation.
 */
@Injectable()
export class ToolsService {
  private readonly logger = new Logger(ToolsService.name);
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    this.logger.log(`Registered tool: ${tool.name}`);
  }

  getActiveSchemas(mode: 'view' | 'edit' | null = null): OpenAIToolSchema[] {
    return [...this.tools.values()]
      // update_object edits object descriptions — not allowed in view mode.
      .filter((t) => !(mode === 'view' && t.name === 'update_object'))
      .map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
  }

  async execute(call: ToolCall): Promise<unknown> {
    const tool = this.tools.get(call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    return tool.execute(call.arguments);
  }
}
