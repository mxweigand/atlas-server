import { Module } from '@nestjs/common';
import { BrokerService } from './broker.service';
import { TransportModule } from '../transport/transport.module';
import { OpenAIModule } from '../openai/openai.module';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [TransportModule, OpenAIModule, ToolsModule],
  providers: [BrokerService],
})
export class BrokerModule {}
