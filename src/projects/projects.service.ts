import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { resolve, isAbsolute, join, basename } from 'path';
import { randomUUID } from 'crypto';
import { AtlasGeometry, AtlasObject, AtlasProject } from '../protocol/messages';
import { AppConfig } from '../config/configuration';

export interface ProjectFileContents {
  project: AtlasProject;
  objects: AtlasObject[];
}

/**
 * File-backed registry for projects and their objects.
 *
 * One JSON file per project under `projects.dataDir`. Files are read on the
 * fly for list/get; active project state is kept in memory. Writes are atomic
 * (temp file + rename) so a crash mid-write cannot corrupt a file.
 *
 * Emits `activated$` on every activation change (including deactivation) so
 * downstream services can react — most importantly the broker, which restarts
 * the OpenAI Realtime session with a fresh system prompt.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly dataDir: string;

  private active: ProjectFileContents | null = null;

  /** Fires on every activation change. Payload is null when deactivated. */
  readonly activated$ = new Subject<ProjectFileContents | null>();
  /** Fires when an object's mutable fields have been patched. */
  readonly objectUpdated$ = new Subject<{ projectId: string; object: AtlasObject }>();
  /** Fires when a new object is created. */
  readonly objectCreated$ = new Subject<{ projectId: string; object: AtlasObject }>();
  /** Fires when an object is deleted. */
  readonly objectDeleted$ = new Subject<{ projectId: string; objectId: string }>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const raw = this.config.get('projects.dataDir', { infer: true }) as string;
    this.dataDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    this.logger.log(`Projects data dir: ${this.dataDir}`);
  }

  list(): AtlasProject[] {
    if (!existsSync(this.dataDir)) return [];
    return readdirSync(this.dataDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return this.readFile(join(this.dataDir, f)).project;
        } catch (err) {
          this.logger.warn(`Skipping ${f}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      })
      .filter((p): p is AtlasProject => p !== null);
  }

  get(projectId: string): ProjectFileContents {
    return this.readFile(this.pathFor(projectId));
  }

  getActive(): ProjectFileContents | null {
    return this.active;
  }

  activate(projectId: string): ProjectFileContents {
    const contents = this.get(projectId);
    this.active = contents;
    this.logger.log(`Activated project "${projectId}"`);
    this.activated$.next(contents);
    return contents;
  }

  deactivate(): void {
    if (!this.active) return;
    this.logger.log(`Deactivated project "${this.active.project.id}"`);
    this.active = null;
    this.activated$.next(null);
  }

  createObject(projectId: string, geometry: AtlasGeometry | null): AtlasObject {
    const contents = this.get(projectId);
    const newObj: AtlasObject = {
      id: randomUUID(),
      name: '',
      summary: '',
      content: '',
      geometry: geometry ?? null,
    };
    contents.objects.push(newObj);
    this.writeFile(projectId, contents);
    if (this.active?.project.id === projectId) {
      this.active.objects.push(newObj);
    }
    this.objectCreated$.next({ projectId, object: newObj });
    return newObj;
  }

  deleteObject(projectId: string, objectId: string): void {
    const contents = this.get(projectId);
    const idx = contents.objects.findIndex((o) => o.id === objectId);
    if (idx < 0) {
      throw new NotFoundException(`Object "${objectId}" not found in project "${projectId}"`);
    }
    contents.objects.splice(idx, 1);
    this.writeFile(projectId, contents);
    if (this.active?.project.id === projectId) {
      const activeIdx = this.active.objects.findIndex((o) => o.id === objectId);
      if (activeIdx >= 0) this.active.objects.splice(activeIdx, 1);
    }
    this.objectDeleted$.next({ projectId, objectId });
  }

  updateObject(
    projectId: string,
    objectId: string,
    patch: Partial<Pick<AtlasObject, 'name' | 'summary' | 'content' | 'geometry'>>,
  ): AtlasObject {
    const contents = this.get(projectId);
    const idx = contents.objects.findIndex((o) => o.id === objectId);
    if (idx < 0) {
      throw new NotFoundException(`Object "${objectId}" not found in project "${projectId}"`);
    }
    const existing = contents.objects[idx];
    const next: AtlasObject = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.geometry !== undefined ? { geometry: patch.geometry } : {}),
    };
    contents.objects[idx] = next;
    this.writeFile(projectId, contents);

    if (this.active?.project.id === projectId) {
      this.active.objects[idx] = next;
    }
    this.objectUpdated$.next({ projectId, object: next });
    return next;
  }

  private pathFor(projectId: string): string {
    if (!/^[a-z0-9_-]+$/i.test(projectId)) {
      throw new BadRequestException(`Invalid projectId "${projectId}"`);
    }
    return join(this.dataDir, `${projectId}.json`);
  }

  private readFile(path: string): ProjectFileContents {
    if (!existsSync(path)) {
      throw new NotFoundException(`Project file not found: ${path}`);
    }
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as ProjectFileContents;
    if (!parsed.project || !Array.isArray(parsed.objects)) {
      throw new BadRequestException(`Malformed project file: ${path}`);
    }
    // The filename (without .json) is the single source of the project id.
    parsed.project.id = basename(path, '.json');
    return parsed;
  }

  private writeFile(projectId: string, contents: ProjectFileContents): void {
    const path = this.pathFor(projectId);
    const tmp = `${path}.tmp`;
    // Do not persist the id — it is derived from the filename.
    const onDisk = {
      project: { name: contents.project.name, summary: contents.project.summary },
      objects: contents.objects,
    };
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf-8');
    renameSync(tmp, path);
  }
}
