import { Module } from '@nestjs/common';
import { ToolsService } from './tools.service';
import { DeixisModule } from '../deixis/deixis.module';
import { ProjectsModule } from '../projects/projects.module';
import { ResolveDeixisTool } from './deixis/resolve-deixis.tool';
import { GetObjectTool } from './objects/get-object.tool';
import { UpdateObjectTool } from './objects/update-object.tool';
import { WaitForUserTool } from './silence/wait-for-user.tool';

@Module({
  imports: [DeixisModule, ProjectsModule],
  providers: [ToolsService, ResolveDeixisTool, GetObjectTool, UpdateObjectTool, WaitForUserTool],
  exports: [ToolsService, ResolveDeixisTool, GetObjectTool, UpdateObjectTool, WaitForUserTool],
})
export class ToolsModule {}
