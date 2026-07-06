import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TransportGateway, Topology } from '../transport/transport.gateway';
import { RealtimeService } from '../openai/realtime.service';
import { ToolsService } from '../tools/tools.service';
import { DeixisService } from '../deixis/deixis.service';
import { ResolveDeixisTool } from '../tools/deixis/resolve-deixis.tool';
import { GetObjectTool } from '../tools/objects/get-object.tool';
import { UpdateObjectTool } from '../tools/objects/update-object.tool';
import { ProjectsService } from '../projects/projects.service';
import { buildSystemPrompt } from '../openai/systemPrompt';
import { ServerMessage } from '../protocol';

/**
 * Wires OpenAI Realtime, tools, and transport together. HoloLens and debug
 * client hit the same handlers on /hololens; the extra debug streams
 * (user_speech blob with deltas, transcripts) go to /monitor clients only.
 */
@Injectable()
export class BrokerService implements OnModuleInit {
  private readonly logger = new Logger(BrokerService.name);

  private userAudioChunks: Buffer[] = [];
  private recordingUserAudio = false;
  private userAudioStartWallclockMs = 0;
  /**
   * Populated at speech_ended, drained at conversation.item.added. Holds the
   * completed turn while we wait for OpenAI to hand us the item.id that keys
   * every downstream event of this turn (transcript, deltas).
   */
  private pendingUserSpeech: { audio: string; audioStartWallclockMs: number } | null = null;
  private assistantAudioChunks: Buffer[] = [];
  private recordingAssistantAudio = false;

  /** Running index of deltas per itemId — used for LogService alignment on the client. */
  private deltaIndexByItemId = new Map<string, number>();

  constructor(
    private readonly transport: TransportGateway,
    private readonly realtime: RealtimeService,
    private readonly tools: ToolsService,
    private readonly deixis: DeixisService,
    private readonly projects: ProjectsService,
    private readonly resolveDeixisTool: ResolveDeixisTool,
    private readonly getObjectTool: GetObjectTool,
    private readonly updateObjectTool: UpdateObjectTool,
  ) {}

  onModuleInit(): void {
    this.tools.register(this.resolveDeixisTool);
    this.tools.register(this.getObjectTool);
    this.tools.register(this.updateObjectTool);
    this.realtime.setToolSchemas(this.tools.getActiveSchemas());
    this.realtime.setSystemPromptProvider(() => buildSystemPrompt(this.projects.getActive()));
    this.wireEvents();
    // Realtime session only comes up once a project is activated. Idle server
    // holds no OpenAI socket open.
    this.logger.log('Broker ready — awaiting project activation');
  }

  private wireEvents(): void {
    // HoloLens audio -> OpenAI (+ buffer during speech)
    this.transport.audioIn$.subscribe((pcm16) => {
      this.realtime.sendAudio(pcm16);
      if (this.recordingUserAudio) this.userAudioChunks.push(pcm16);
    });

    // OpenAI audio -> /hololens client (+ buffer during response for monitor playback)
    this.realtime.audio$.subscribe((chunk) => {
      this.transport.sendAudioToHololens(chunk);
      if (this.recordingAssistantAudio) this.assistantAudioChunks.push(chunk);
    });

    // Tool calls -> announce on /hololens, execute, send result back
    this.realtime.toolCall$.subscribe((call) => {
      const event: ServerMessage = {
        type: 'tool_call',
        callId: call.callId,
        name: call.name,
        args: call.arguments,
      };
      this.transport.sendToHololens(event);
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
      this.transport.sendToHololens({ type: 'speech_started' });
      this.transport.sendToMonitors({ type: 'speech_started' });
    });
    this.realtime.speechEnded$.subscribe(() => {
      this.recordingUserAudio = false;
      const audio = Buffer.concat(this.userAudioChunks).toString('base64');
      this.userAudioChunks = [];
      // Hold the clip until conversation.item.added arrives — we want to send
      // user_speech with the itemId that all downstream events share.
      this.pendingUserSpeech = { audio, audioStartWallclockMs: this.userAudioStartWallclockMs };
      this.transport.sendToHololens({ type: 'speech_ended' });
      this.transport.sendToMonitors({ type: 'speech_ended' });
    });

    // Item materialised on the OpenAI side — flush the pending user_speech.
    this.realtime.userItemAdded$.subscribe(({ itemId }) => {
      const pending = this.pendingUserSpeech;
      if (!pending) return;
      this.pendingUserSpeech = null;
      this.transport.sendToMonitors({
        type: 'user_speech',
        itemId,
        audio: pending.audio,
        audioStartWallclockMs: pending.audioStartWallclockMs,
      });
    });

    // Response lifecycle with audio clip
    this.realtime.responseStarted$.subscribe(() => {
      this.assistantAudioChunks = [];
      this.recordingAssistantAudio = true;
      this.transport.sendToHololens({ type: 'response_started' });
      this.transport.sendToMonitors({ type: 'response_started' });
    });
    this.realtime.responseDone$.subscribe(() => {
      this.recordingAssistantAudio = false;
      if (this.assistantAudioChunks.length > 0) {
        const audio = Buffer.concat(this.assistantAudioChunks).toString('base64');
        this.transport.sendToMonitors({ type: 'assistant_speech', audio });
      }
      this.assistantAudioChunks = [];
      this.transport.sendToHololens({ type: 'response_done' });
      this.transport.sendToMonitors({ type: 'response_done' });
    });

    // Transcripts -> monitor only
    this.realtime.userTranscript$.subscribe(({ itemId, transcript }) =>
      this.transport.sendToMonitors({ type: 'user_transcript', itemId, transcript }),
    );
    this.realtime.userTranscriptDelta$.subscribe(({ itemId, delta, wallclockMs }) => {
      const audioOffsetMs = this.userAudioStartWallclockMs
        ? wallclockMs - this.userAudioStartWallclockMs
        : 0;
      const deltaIndex = this.deltaIndexByItemId.get(itemId) ?? 0;
      this.deltaIndexByItemId.set(itemId, deltaIndex + 1);
      this.deixis.recordDelta({ itemId, deltaIndex, wallclockMs, text: delta });
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

    // /hololens text frames — currently only focus_update. Record into the
    // deixis service and rebroadcast to monitors for live visibility.
    this.transport.hololensMessage$.subscribe((msg) => {
      if (msg.type !== 'focus_update') return;
      const { wallclockMs, focusId } = msg;
      this.deixis.recordFocus({ wallclockMs, focusId });
      this.transport.sendToMonitors({ type: 'focus_update', wallclockMs, focusId });
    });

    // Project activation: broadcast to monitors + /hololens, then restart the
    // realtime session so the fresh system prompt (with project overview)
    // takes effect. Deactivation tears the session down entirely.
    this.projects.activated$.subscribe((context) => {
      const projectId = context?.project.id ?? null;
      const event: ServerMessage = { type: 'project_activated', projectId };
      this.transport.sendToHololens(event);
      this.transport.sendToMonitors(event);
      void this.applyActiveProject(context !== null);
    });

    // Object patched (via tool or REST): keep monitors in sync.
    this.projects.objectUpdated$.subscribe(({ projectId, object }) => {
      this.transport.sendToMonitors({ type: 'object_updated', projectId, object });
    });
  }

  private async applyActiveProject(active: boolean): Promise<void> {
    try {
      if (active) await this.realtime.restart();
      else await this.realtime.disconnect();
    } catch (err) {
      this.logger.error(
        `Failed to apply project change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private sendModeChanged(topology: Topology): void {
    this.transport.sendToMonitors({
      type: 'mode_changed',
      hololensClient: topology.hololensClient,
      monitorClients: topology.monitorClients,
    });
  }

  private async executeToolCall(callId: string, name: string, args: unknown): Promise<void> {
    try {
      const result = await this.tools.execute({ callId, name, arguments: args });
      this.realtime.sendToolResult(callId, result);
      const event: ServerMessage = { type: 'tool_result', callId, name, result };
      this.transport.sendToHololens(event);
      this.transport.sendToMonitors(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool "${name}" failed: ${message}`);
      this.realtime.sendToolResult(callId, { error: message });
      const event: ServerMessage = {
        type: 'error',
        message: `Tool "${name}" failed: ${message}`,
      };
      this.transport.sendToHololens(event);
      this.transport.sendToMonitors(event);
    }
  }
}
