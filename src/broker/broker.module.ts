import { Module } from '@nestjs/common';
import { BrokerService } from './broker.service';
import { TransportModule } from '../transport/transport.module';
import { OpenAIModule } from '../openai/openai.module';
import { ToolsModule } from '../tools/tools.module';
import { DeixisModule } from '../deixis/deixis.module';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [TransportModule, OpenAIModule, ToolsModule, DeixisModule, ProjectsModule],
  providers: [BrokerService],
})
export class BrokerModule {}
