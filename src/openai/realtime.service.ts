import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { Subject } from 'rxjs';
import { createWriteStream, mkdirSync, WriteStream } from 'fs';
import { resolve, isAbsolute } from 'path';
import { AppConfig } from '../config/configuration';
import { buildSystemPrompt } from './systemPrompt';

// Server event types whose raw payloads are logged to feed the future
// deixis/pointing pipeline. One JSON line per event (NDJSON).
const TRANSCRIPTION_LOG_EVENT_TYPES = new Set<string>([
  'conversation.item.input_audio_transcription.delta',
  'conversation.item.input_audio_transcription.completed',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'error',
]);

export interface ToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface OpenAIToolSchema {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Minimal typing for the OpenAI Realtime server events we handle
interface SessionCreatedEvent { type: 'session.created'; session: { id: string } }
interface AudioDeltaEvent { type: 'response.audio.delta'; delta: string }
interface OutputItemDoneEvent {
  type: 'response.output_item.done';
  item: { type: string; call_id: string; name: string; arguments: string };
}
interface ErrorEvent { type: 'error'; error: { type: string; message: string } }
interface InputAudioTranscriptionCompletedEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  item_id: string;
  transcript: string;
}
interface InputAudioTranscriptionDeltaEvent {
  type: 'conversation.item.input_audio_transcription.delta';
  item_id: string;
  delta: string;
}
interface ConversationItemAddedEvent {
  type: 'conversation.item.added';
  item: { id: string; type: string; role?: 'user' | 'assistant' | 'system' };
}
interface AudioTranscriptDoneEvent {
  type: 'response.audio_transcript.done';
  transcript: string;
}
type OpenAIEvent =
  | SessionCreatedEvent
  | AudioDeltaEvent
  | OutputItemDoneEvent
  | ErrorEvent
  | InputAudioTranscriptionCompletedEvent
  | InputAudioTranscriptionDeltaEvent
  | ConversationItemAddedEvent
  | AudioTranscriptDoneEvent
  | { type: string };

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Connects the broker to the OpenAI Realtime API (GA, gpt-realtime-2). Also
 * runs the parallel input transcription (gpt-realtime-whisper) whose raw
 * events are written to a JSONL file for later deixis analysis.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);

  readonly audio$ = new Subject<Buffer>();
  readonly toolCall$ = new Subject<ToolCall>();
  readonly speechStarted$ = new Subject<void>();
  readonly speechEnded$ = new Subject<void>();
  readonly responseStarted$ = new Subject<void>();
  readonly responseDone$ = new Subject<void>();
  /** Fires when the OpenAI server materialises the conversation item for the just-ended user turn. */
  readonly userItemAdded$ = new Subject<{ itemId: string }>();
  readonly userTranscript$ = new Subject<{ itemId: string; transcript: string }>();
  readonly userTranscriptDelta$ = new Subject<{ itemId: string; delta: string; wallclockMs: number }>();
  readonly assistantTranscript$ = new Subject<string>();

  private ws: WebSocket | null = null;
  private toolSchemas: OpenAIToolSchema[] = [];
  private stopping = false;
  private reconnectAttempts = 0;
  private transcriptionLogStream: WriteStream | null = null;
  private transcriptionLogPath: string | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.initTranscriptionLogStream();
  }

  setToolSchemas(schemas: OpenAIToolSchema[]): void {
    this.toolSchemas = schemas;
  }

  updateToolSchemas(schemas: OpenAIToolSchema[]): void {
    this.toolSchemas = schemas;
    this.send({ type: 'session.update', session: { tools: schemas, tool_choice: 'auto' } });
    this.logger.log(`Tool schemas updated (${schemas.length} active)`);
  }

  async connect(): Promise<void> {
    this.stopping = false;
    this.reconnectAttempts = 0;
    await this.openConnection();
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.ws?.close();
    this.ws = null;
    this.closeTranscriptionLogStream();
  }

  onModuleDestroy(): void {
    void this.disconnect();
  }

  sendAudio(pcm16: Buffer): void {
    this.send({ type: 'input_audio_buffer.append', audio: pcm16.toString('base64') });
  }

  sendToolResult(callId: string, output: unknown): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    this.send({ type: 'response.create' });
  }

  private openConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const model = this.config.get('openai.model', { infer: true }) as string;
      const apiKey = this.config.get('openai.apiKey', { infer: true }) as string;

      if (!apiKey) {
        reject(new Error('OPENAI_API_KEY is not set'));
        return;
      }

      // The GA schema (session.type='realtime', nested audio.input.*) requires
      // omitting the OpenAI-Beta header — its presence forces the flat schema
      // and rejects our session.update.
      const ws = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      this.ws = ws;

      let sessionReady = false;

      ws.on('open', () => this.logger.log(`Connected to OpenAI (model: ${model})`));

      ws.on('message', (raw: WebSocket.RawData) => {
        const str = Buffer.isBuffer(raw) ? raw.toString() : Buffer.from(raw as ArrayBuffer).toString();
        let event: OpenAIEvent;
        try { event = JSON.parse(str) as OpenAIEvent; }
        catch { this.logger.error('Failed to parse OpenAI event'); return; }

        if (TRANSCRIPTION_LOG_EVENT_TYPES.has(event.type)) {
          this.logTranscriptionEvent(event);
        }

        if (event.type === 'session.created') {
          this.logger.log(`Session created: ${(event as SessionCreatedEvent).session.id}`);
          this.sendSessionUpdate();
          return;
        }
        if (event.type === 'session.updated' && !sessionReady) {
          sessionReady = true;
          this.logger.log('Session configured');
          resolve();
          return;
        }

        this.dispatch(event);
      });

      ws.on('error', (err: Error) => {
        this.logger.error(`WebSocket error: ${err.message}`);
        if (!sessionReady) reject(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        this.logger.log(`WebSocket closed (code=${code}, reason=${reason.toString() || 'none'})`);
        this.ws = null;
        if (!sessionReady) reject(new Error(`Closed before session setup (code=${code})`));
        else if (!this.stopping) void this.scheduleReconnect();
      });
    });
  }

  private dispatch(event: OpenAIEvent): void {
    switch (event.type) {
      case 'response.audio.delta': {
        const { delta } = event as AudioDeltaEvent;
        if (delta) this.audio$.next(Buffer.from(delta, 'base64'));
        break;
      }
      case 'response.output_item.done': {
        const { item } = event as OutputItemDoneEvent;
        if (item.type === 'function_call') {
          let args: unknown;
          try { args = JSON.parse(item.arguments || '{}'); } catch { args = {}; }
          const call: ToolCall = { callId: item.call_id, name: item.name, arguments: args };
          this.logger.log(`Tool call: ${call.name} (${call.callId})`);
          this.toolCall$.next(call);
        }
        break;
      }
      case 'input_audio_buffer.speech_started':
        this.logger.log('Speech detected (VAD)');
        this.speechStarted$.next();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.logger.log('Speech ended (VAD)');
        this.speechEnded$.next();
        break;
      case 'response.created':
        this.responseStarted$.next();
        break;
      case 'response.done':
        this.logger.log('Response complete');
        this.responseDone$.next();
        break;
      case 'conversation.item.added': {
        const { item } = event as ConversationItemAddedEvent;
        if (item?.type === 'message' && item.role === 'user' && item.id) {
          this.userItemAdded$.next({ itemId: item.id });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const e = event as InputAudioTranscriptionCompletedEvent;
        if (e.transcript) this.userTranscript$.next({ itemId: e.item_id, transcript: e.transcript });
        break;
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const e = event as InputAudioTranscriptionDeltaEvent;
        if (e.delta) {
          this.userTranscriptDelta$.next({
            itemId: e.item_id,
            delta: e.delta,
            wallclockMs: Date.now(),
          });
        }
        break;
      }
      case 'response.audio_transcript.done': {
        const { transcript } = event as AudioTranscriptDoneEvent;
        if (transcript) this.assistantTranscript$.next(transcript);
        break;
      }
      case 'error': {
        const { error } = event as ErrorEvent;
        this.logger.error(`OpenAI error [${error?.type}]: ${error?.message}`);
        break;
      }
    }
  }

  private async scheduleReconnect(): Promise<void> {
    const maxRetries = this.config.get('reconnect.maxRetries', { infer: true }) as number;
    if (this.reconnectAttempts >= maxRetries) {
      this.logger.error('Max reconnect attempts reached');
      return;
    }
    const initialDelay = this.config.get('reconnect.initialDelayMs', { infer: true }) as number;
    const multiplier = this.config.get('reconnect.backoffMultiplier', { infer: true }) as number;
    const delay = initialDelay * Math.pow(multiplier, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.logger.warn(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxRetries})`);
    await sleep(delay);
    try {
      await this.openConnection();
      this.reconnectAttempts = 0;
      this.logger.log('Reconnect successful');
    } catch (err) {
      this.logger.error(`Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.scheduleReconnect();
    }
  }

  private sendSessionUpdate(): void {
    const cfg = this.config.get('openai', { infer: true }) as AppConfig['openai'];
    const vad = this.config.get('vad', { infer: true }) as AppConfig['vad'];
    const transcriptionCfg = this.config.get('inputTranscriptionLogging', {
      infer: true,
    }) as AppConfig['inputTranscriptionLogging'];

    // Semantic VAD evaluates whether an utterance is *semantically* complete,
    // not just whether silence has elapsed. silence_duration_ms is unused when
    // semantic_vad is active. Server VAD is available via VAD_TYPE=server_vad.
    const turnDetection = vad.type === 'semantic_vad'
      ? {
          type: 'semantic_vad',
          eagerness: vad.eagerness,
          create_response: true,
          interrupt_response: true,
        }
      : {
          type: 'server_vad',
          silence_duration_ms: vad.silenceDurationMs,
          threshold: vad.threshold,
          prefix_padding_ms: vad.prefixPaddingMs,
          create_response: true,
          interrupt_response: true,
        };

    const inputAudio: Record<string, unknown> = {
      format: { type: 'audio/pcm', rate: 24000 },
      turn_detection: turnDetection,
    };
    if (transcriptionCfg.enabled) {
      inputAudio.transcription = {
        model: 'gpt-realtime-whisper',
        language: transcriptionCfg.language,
      };
    }

    const sessionPayload: Record<string, unknown> = {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: buildSystemPrompt(),
      audio: {
        input: inputAudio,
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: cfg.voice,
        },
      },
      reasoning: { effort: cfg.reasoningEffort },
      tools: this.toolSchemas,
      tool_choice: 'auto',
    };
    if (transcriptionCfg.enabled) {
      // Only include value the API accepts. logprobs do not yet appear in the
      // event payloads, but requesting it is validated and free.
      sessionPayload.include = ['item.input_audio_transcription.logprobs'];
    }

    this.send({ type: 'session.update', session: sessionPayload });
  }

  private initTranscriptionLogStream(): void {
    const cfg = this.config.get('inputTranscriptionLogging', {
      infer: true,
    }) as AppConfig['inputTranscriptionLogging'];
    if (!cfg.enabled) return;

    const dir = isAbsolute(cfg.logDir) ? cfg.logDir : resolve(process.cwd(), cfg.logDir);
    try {
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
      this.transcriptionLogPath = resolve(dir, `transcription-events-${ts}.jsonl`);
      this.transcriptionLogStream = createWriteStream(this.transcriptionLogPath, { flags: 'a' });
      this.transcriptionLogStream.on('error', (err: Error) => {
        this.logger.warn(`Transcription log stream error: ${err.message}`);
        this.transcriptionLogStream = null;
      });
      this.logger.log(`Input-transcription events -> ${this.transcriptionLogPath}`);
    } catch (err) {
      this.logger.warn(
        `Failed to open transcription log (${err instanceof Error ? err.message : String(err)}) — continuing without it`,
      );
      this.transcriptionLogStream = null;
    }
  }

  private logTranscriptionEvent(event: OpenAIEvent): void {
    const stream = this.transcriptionLogStream;
    if (!stream) return;
    try {
      const now = Date.now();
      const line =
        JSON.stringify({
          received_at_wallclock_ms: now,
          received_at_iso: new Date(now).toISOString(),
          event_type: event.type,
          event,
        }) + '\n';
      stream.write(line);
    } catch (err) {
      this.logger.warn(
        `Failed to write transcription log line (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  private closeTranscriptionLogStream(): void {
    const stream = this.transcriptionLogStream;
    if (!stream) return;
    this.transcriptionLogStream = null;
    stream.end();
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`Send skipped (not ready): ${payload['type'] as string}`);
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }
}
