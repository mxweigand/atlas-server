import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  // Debug client runs on a different origin during development — REST endpoints
  // for project/object management need CORS.
  app.enableCors({ origin: true });
  // HTTP server carries REST for project/object management. The realtime voice
  // stream runs on the WebSocket gateway (WS_PORT, default 8080).
  await app.listen(process.env['PORT'] ?? 3000);
}

void bootstrap();
