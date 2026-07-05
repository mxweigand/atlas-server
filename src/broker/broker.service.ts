import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TransportGateway, Topology } from '../transport/transport.gateway';
import { RealtimeService } from '../openai/realtime.service';
import { ToolsService } from '../tools/tools.service';
import { ServerMessage } from '../protocol';

/**
 * Wires OpenAI Realtime, tools, and transport together. HoloLens and debug
 * client hit the same handlers on /lens; the extra debug streams (user_speech
 * blob with deltas, transcripts) go to /monitor clients only.
 */
@Injectable()
export class BrokerService implements OnModuleInit {
  private readonly logger = new Logger(BrokerService.name);

  private userAudioChunks: Buffer[] = [];
  private recordingUserAudio = false;
  private userAudioStartWallclockMs = 0;
  private assistantAudioChunks: Buffer[] = [];
  private recordingAssistantAudio = false;

  constructor(
    private readonly transport: TransportGateway,
    private readonly realtime: RealtimeService,
    private readonly tools: ToolsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.realtime.setToolSchemas(this.tools.getActiveSchemas());
    this.wireEvents();
    await this.realtime.connect();
    this.logger.log('Broker ready');
  }

  private wireEvents(): void {
    // Lens audio -> OpenAI (+ buffer during speech)
    this.transport.audioIn$.subscribe((pcm16) => {
      this.realtime.sendAudio(pcm16);
      if (this.recordingUserAudio) this.userAudioChunks.push(pcm16);
    });

    // OpenAI audio -> lens client (+ buffer during response for monitor playback)
    this.realtime.audio$.subscribe((chunk) => {
      this.transport.sendAudioToLens(chunk);
      if (this.recordingAssistantAudio) this.assistantAudioChunks.push(chunk);
    });

    // Tool calls -> announce on lens, execute, send result back
    this.realtime.toolCall$.subscribe((call) => {
      const event: ServerMessage = {
        type: 'tool_call',
        callId: call.callId,
        name: call.name,
        args: call.arguments,
      };
      this.transport.sendToLens(event);
      this.transport.sendToMonitors(event);
      void this.executeToolCall(call.callId, call.name, call.arguments);
    });

    // Speech lifecycle with audio clip
    this.realtime.speechStarted$.subscribe(() => {
      this.userAudioChunks = [];
      this.recordingUserAudio = true;
      // Audio anchor: t=0 of the PCM blob attached to the next user_speech
      // event. The debug client uses this to align transcription deltas.
      this.userAudioStartWallclockMs = Date.now();
      this.transport.sendToLens({ type: 'speech_started' });
      this.transport.sendToMonitors({ type: 'speech_started' });
    });
    this.realtime.speechEnded$.subscribe(() => {
      this.recordingUserAudio = false;
      const audio = Buffer.concat(this.userAudioChunks).toString('base64');
      this.userAudioChunks = [];
      this.transport.sendToMonitors({
        type: 'user_speech',
        audio,
        audioStartWallclockMs: this.userAudioStartWallclockMs,
      });
      this.transport.sendToLens({ type: 'speech_ended' });
      this.transport.sendToMonitors({ type: 'speech_ended' });
    });

    // Response lifecycle with audio clip
    this.realtime.responseStarted$.subscribe(() => {
      this.assistantAudioChunks = [];
      this.recordingAssistantAudio = true;
      this.transport.sendToLens({ type: 'response_started' });
      this.transport.sendToMonitors({ type: 'response_started' });
    });
    this.realtime.responseDone$.subscribe(() => {
      this.recordingAssistantAudio = false;
      if (this.assistantAudioChunks.length > 0) {
        const audio = Buffer.concat(this.assistantAudioChunks).toString('base64');
        this.transport.sendToMonitors({ type: 'assistant_speech', audio });
      }
      this.assistantAudioChunks = [];
      this.transport.sendToLens({ type: 'response_done' });
      this.transport.sendToMonitors({ type: 'response_done' });
    });

    // Transcripts -> monitor only
    this.realtime.userTranscript$.subscribe((transcript) =>
      this.transport.sendToMonitors({ type: 'user_transcript', transcript }),
    );
    this.realtime.userTranscriptDelta$.subscribe(({ itemId, delta, wallclockMs }) => {
      const audioOffsetMs = this.userAudioStartWallclockMs
        ? wallclockMs - this.userAudioStartWallclockMs
        : 0;
      this.transport.sendToMonitors({
        type: 'user_transcript_delta',
        itemId,
        delta,
        wallclockMs,
        audioOffsetMs,
      });
    });
    this.realtime.assistantTranscript$.subscribe((transcript) =>
      this.transport.sendToMonitors({ type: 'assistant_transcript', transcript }),
    );

    // Topology changes -> notify monitors so their UI stays in sync
    this.transport.topologyChange$.subscribe((topology) => this.sendModeChanged(topology));
  }

  private sendModeChanged(topology: Topology): void {
    this.transport.sendToMonitors({
      type: 'mode_changed',
      lensClient: topology.lensClient,
      monitorClients: topology.monitorClients,
    });
  }

  private async executeToolCall(callId: string, name: string, args: unknown): Promise<void> {
    try {
      const result = await this.tools.execute({ callId, name, arguments: args });
      this.realtime.sendToolResult(callId, result);
      const event: ServerMessage = { type: 'tool_result', callId, name, result };
      this.transport.sendToLens(event);
      this.transport.sendToMonitors(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool "${name}" failed: ${message}`);
      this.realtime.sendToolResult(callId, { error: message });
      const event: ServerMessage = {
        type: 'error',
        message: `Tool "${name}" failed: ${message}`,
      };
      this.transport.sendToLens(event);
      this.transport.sendToMonitors(event);
    }
  }
}
