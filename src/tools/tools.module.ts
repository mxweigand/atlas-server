import { Module } from '@nestjs/common';
import { ToolsService } from './tools.service';
import { DeixisModule } from '../deixis/deixis.module';
import { ResolveDeixisTool } from './deixis/resolve-deixis.tool';

@Module({
  imports: [DeixisModule],
  providers: [ToolsService, ResolveDeixisTool],
  exports: [ToolsService, ResolveDeixisTool],
})
export class ToolsModule {}
