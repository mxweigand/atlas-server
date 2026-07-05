import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  // HTTP server kept minimal — WebSocket gateway runs on its own port (WS_PORT, default 8080)
  await app.listen(process.env['PORT'] ?? 3000);
}

void bootstrap();
