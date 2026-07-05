/**
 * A callable tool the assistant can invoke. Tools implement `execute` to
 * return a value that is sent back to the OpenAI Realtime API as
 * `function_call_output`.
 *
 * The atlas-server currently ships no tools — this interface exists so future
 * tools (deixis resolver, object manipulation, ...) can be registered without
 * touching the broker plumbing.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema object
  execute(args: unknown): Promise<unknown>;
}

export const TOOL = 'TOOL';
