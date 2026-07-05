import { Injectable, Logger } from '@nestjs/common';
import { Tool } from './tool.interface';
import { OpenAIToolSchema, ToolCall } from '../openai/realtime.service';

/**
 * Registry for tools the voice agent can invoke. Empty for now — later this is
 * where deixis resolution, object manipulation, etc. will be registered. The
 * BrokerService queries `getActiveSchemas()` on every session init.
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

  getActiveSchemas(): OpenAIToolSchema[] {
    return [...this.tools.values()].map((t) => ({
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
