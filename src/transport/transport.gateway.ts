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
 *  - /lens    : Input channel for the HoloLens or the debug client (as
 *               emulator). Single-client slot, first wins. Binary PCM in,
 *               assistant audio + lifecycle events out.
 *  - /monitor : Read-only debug view. Any number of clients. Receives
 *               server-pushed debug streams only (user_speech blob, deltas,
 *               transcripts, mode_changed).
 */
@WebSocketGateway(WS_PORT)
export class TransportGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TransportGateway.name);

  /** Emits every incoming binary audio frame from the /lens slot. */
  readonly audioIn$ = new Subject<Buffer>();

  /** Emits whenever the /lens slot or /monitor client set changes. */
  readonly topologyChange$ = new Subject<Topology>();

  /** Emits text-frame messages arriving on /lens (e.g. hello, later focus data). */
  readonly lensMessage$ = new Subject<ClientMessage>();

  private lensClient: WebSocket | null = null;
  private lensRole: 'hololens' | 'debug' | null = null;
  private monitors = new Set<WebSocket>();

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const path = req.url?.split('?')[0] ?? '/';
    const address = req.socket?.remoteAddress ?? 'unknown';

    if (path === '/lens') {
      this.handleLensConnection(client, address);
      return;
    }
    if (path === '/monitor') {
      this.handleMonitorConnection(client, address);
      return;
    }
    this.logger.warn(`Rejected unknown path "${req.url}" from ${address}`);
    client.close(1008, 'Unknown path — use /lens or /monitor');
  }

  handleDisconnect(client: WebSocket): void {
    if (this.lensClient === client) {
      this.logger.log(`Lens client disconnected (${this.lensRole})`);
      this.lensClient = null;
      this.lensRole = null;
      this.emitTopology();
      return;
    }
    if (this.monitors.delete(client)) {
      this.logger.log('Monitor disconnected');
      this.emitTopology();
    }
  }

  /** Send a JSON event to whoever is on /lens (usually the assistant response lifecycle). */
  sendToLens(event: ServerMessage): void {
    if (this.lensClient?.readyState === WebSocket.OPEN) {
      this.lensClient.send(JSON.stringify(event));
    }
  }

  /** Send binary audio to whoever is on /lens (assistant TTS output). */
  sendAudioToLens(pcm16: Buffer): void {
    if (this.lensClient?.readyState === WebSocket.OPEN) {
      this.lensClient.send(pcm16);
    }
  }

  /** Broadcast a JSON event to all /monitor clients. */
  sendToMonitors(event: ServerMessage): void {
    const payload = JSON.stringify(event);
    for (const ws of this.monitors) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Current topology snapshot (used by BrokerService for mode_changed events). */
  get topology(): Topology {
    return { lensClient: this.lensRole, monitorClients: this.monitors.size };
  }

  private handleLensConnection(client: WebSocket, address: string): void {
    if (this.lensClient) {
      this.logger.warn(`Rejected second /lens connection from ${address} — slot already held by "${this.lensRole}"`);
      client.close(1008, '/lens slot occupied');
      return;
    }

    this.validateAuth(client, address);
    this.lensClient = client;
    // Default role until a `hello` frame overrides it. For a real HoloLens
    // we'll likely derive this from the auth header instead.
    this.lensRole = 'debug';
    this.logger.log(`Lens client connected from ${address} (role pending — default: debug)`);

    client.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        this.audioIn$.next(buf);
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        if (msg.type === 'hello' && (msg.role === 'hololens' || msg.role === 'debug')) {
          this.lensRole = msg.role;
          this.logger.log(`Lens role updated: ${msg.role}`);
          this.emitTopology();
        }
        this.lensMessage$.next(msg);
      } catch {
        this.logger.warn('Received malformed text frame on /lens');
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
    this.emitTopology();
  }

  private emitTopology(): void {
    this.topologyChange$.next(this.topology);
  }

  private buildModeChanged(): ServerMessage {
    return {
      type: 'mode_changed',
      lensClient: this.lensRole,
      monitorClients: this.monitors.size,
    };
  }

  private validateAuth(_client: WebSocket, _address: string): void {
    // Auth stub — validate against Microsoft Identity / OAuth later.
    // Currently accepts everything so local development stays frictionless.
  }
}

export interface Topology {
  lensClient: 'hololens' | 'debug' | null;
  monitorClients: number;
}
