import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { Server } from 'ws';
import WebSocket from 'ws';
import { Subject } from 'rxjs';
import { ClientMessage, ServerMessage } from '../protocol';

const WS_PORT = parseInt(process.env['WS_PORT'] ?? '8080', 10);

/**
 * Two WS routes with clearly separated semantics:
 *  - /hololens : Input channel for the HoloLens or the debug client (as
 *                emulator). Single-client slot, first wins. Binary PCM in,
 *                assistant audio + lifecycle events out.
 *  - /monitor  : Read-only debug view. Any number of clients. Receives
 *                server-pushed debug streams only (user_speech blob, deltas,
 *                transcripts, mode_changed).
 */
@WebSocketGateway(WS_PORT)
export class TransportGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TransportGateway.name);

  /** Emits every incoming binary audio frame from the /hololens slot. */
  readonly audioIn$ = new Subject<Buffer>();

  /** Emits whenever the /hololens slot or /monitor client set changes. */
  readonly topologyChange$ = new Subject<Topology>();

  /** Emits text-frame messages arriving on /hololens (e.g. hello, focus data). */
  readonly hololensMessage$ = new Subject<ClientMessage>();

  /**
   * Fires when the /hololens slot is vacated by a disconnect (hard app close,
   * crash, network drop). The reliable "HoloLens is gone" signal — unlike the
   * REST deactivate call, it also covers non-clean exits, so downstream can
   * tear the active project (and its OpenAI session) down.
   */
  readonly hololensDisconnected$ = new Subject<void>();

  /**
   * Fires with the socket of each newly connected /monitor client, right after
   * its initial mode snapshot, so late joiners can be handed current domain
   * state (e.g. which project is active) instead of waiting for the next change.
   */
  readonly monitorConnected$ = new Subject<WebSocket>();

  private hololensClient: WebSocket | null = null;
  private hololensRole: 'hololens' | 'debug' | null = null;
  private monitors = new Set<WebSocket>();

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const path = req.url?.split('?')[0] ?? '/';
    const address = req.socket?.remoteAddress ?? 'unknown';

    if (path === '/hololens') {
      this.handleHololensConnection(client, address);
      return;
    }
    if (path === '/monitor') {
      this.handleMonitorConnection(client, address);
      return;
    }
    this.logger.warn(`Rejected unknown path "${req.url}" from ${address}`);
    client.close(1008, 'Unknown path — use /hololens or /monitor');
  }

  handleDisconnect(client: WebSocket): void {
    if (this.hololensClient === client) {
      this.logger.log(`HoloLens client disconnected (${this.hololensRole})`);
      this.hololensClient = null;
      this.hololensRole = null;
      this.hololensDisconnected$.next();
      this.emitTopology();
      return;
    }
    if (this.monitors.delete(client)) {
      this.logger.log('Monitor disconnected');
      this.emitTopology();
    }
  }

  /** Send a JSON event to whoever is on /hololens (usually the assistant response lifecycle). */
  sendToHololens(event: ServerMessage): void {
    if (this.hololensClient?.readyState === WebSocket.OPEN) {
      this.hololensClient.send(JSON.stringify(event));
    }
  }

  /** Send binary audio to whoever is on /hololens (assistant TTS output). */
  sendAudioToHololens(pcm16: Buffer): void {
    if (this.hololensClient?.readyState === WebSocket.OPEN) {
      this.hololensClient.send(pcm16);
    }
  }

  /** Broadcast a JSON event to all /monitor clients. */
  sendToMonitors(event: ServerMessage): void {
    const payload = JSON.stringify(event);
    for (const ws of this.monitors) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Send a JSON event to a single /monitor client (used for join snapshots). */
  sendToMonitor(client: WebSocket, event: ServerMessage): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  }

  /** Current topology snapshot (used by BrokerService for mode_changed events). */
  get topology(): Topology {
    return { hololensClient: this.hololensRole, monitorClients: this.monitors.size };
  }

  private handleHololensConnection(client: WebSocket, address: string): void {
    if (this.hololensClient) {
      this.logger.warn(`Rejected second /hololens connection from ${address} — slot already held by "${this.hololensRole}"`);
      client.close(1008, '/hololens slot occupied');
      return;
    }

    this.validateAuth(client, address);
    this.hololensClient = client;
    // Default role until a `hello` frame overrides it. For a real HoloLens
    // we'll likely derive this from the auth header instead.
    this.hololensRole = 'debug';
    this.logger.log(`HoloLens client connected from ${address} (role pending — default: debug)`);

    client.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        this.audioIn$.next(buf);
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        if (msg.type === 'hello' && (msg.role === 'hololens' || msg.role === 'debug')) {
          this.hololensRole = msg.role;
          this.logger.log(`HoloLens role updated: ${msg.role}`);
          this.emitTopology();
        }
        this.hololensMessage$.next(msg);
      } catch {
        this.logger.warn('Received malformed text frame on /hololens');
      }
    });

    this.emitTopology();
  }

  private handleMonitorConnection(client: WebSocket, address: string): void {
    this.validateAuth(client, address);
    this.monitors.add(client);
    this.logger.log(`Monitor connected from ${address} (${this.monitors.size} active)`);
    // Send a topology snapshot immediately so the UI reflects the current
    // state without waiting for the next change event.
    client.send(JSON.stringify(this.buildModeChanged()));
    this.monitorConnected$.next(client);
    this.emitTopology();
  }

  private emitTopology(): void {
    this.topologyChange$.next(this.topology);
  }

  private buildModeChanged(): ServerMessage {
    return {
      type: 'mode_changed',
      hololensClient: this.hololensRole,
      monitorClients: this.monitors.size,
    };
  }

  private validateAuth(_client: WebSocket, _address: string): void {
    // Auth stub — validate against Microsoft Identity / OAuth later.
    // Currently accepts everything so local development stays frictionless.
  }
}

export interface Topology {
  hololensClient: 'hololens' | 'debug' | null;
  monitorClients: number;
}
