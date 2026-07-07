import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import type { ProjectFileContents } from './projects.service';
import type { AtlasGeometry, AtlasObject, AtlasProject } from '../protocol/messages';

interface CreateObjectDto {
  geometry?: AtlasGeometry;
}

interface UpdateObjectDto {
  name?: string;
  summary?: string;
  content?: string;
  geometry?: AtlasGeometry;
}

/**
 * REST surface for project/object management. Kept intentionally small — v1
 * exposes list/get/activate for projects and object patching only. Object
 * creation and deletion happen out-of-band by editing files on disk.
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(): AtlasProject[] {
    return this.projects.list();
  }

  @Get(':id')
  get(@Param('id') id: string): ProjectFileContents {
    return this.projects.get(id);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string): ProjectFileContents {
    return this.projects.activate(id);
  }

  @Post('deactivate')
  deactivate(): { active: null } {
    this.projects.deactivate();
    return { active: null };
  }

  @Post(':id/objects')
  createObject(
    @Param('id') id: string,
    @Body() dto: CreateObjectDto,
  ): AtlasObject {
    return this.projects.createObject(id, dto.geometry ?? null);
  }

  @Delete(':id/objects/:objectId')
  deleteObject(
    @Param('id') id: string,
    @Param('objectId') objectId: string,
  ): void {
    this.projects.deleteObject(id, objectId);
  }

  @Patch(':id/objects/:objectId')
  updateObject(
    @Param('id') id: string,
    @Param('objectId') objectId: string,
    @Body() patch: UpdateObjectDto,
  ): AtlasObject {
    return this.projects.updateObject(id, objectId, patch);
  }
}
