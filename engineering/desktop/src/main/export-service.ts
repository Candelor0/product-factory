import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import type { ExportRequest, ExportResult } from '../shared/export-contracts';
import { ProjectStore } from './project-store';
import { SourceStore } from './source-store';
import { SourceToolExecutor } from './source-tools';
import { sourceHash, parseSourceRevision } from './source-protocol';
import { createExportZip, writeExportArchive } from './export-archive';
import type { ExportFile } from './export-kit';
import {
  AppError,
  assertFields,
  assertRecord,
  parseProjectId,
  parseRevisionId,
} from './validation';

export function parseExportRequest(value: unknown): ExportRequest {
  assertRecord(value);
  assertFields(value, ['schemaVersion', 'projectId', 'planRunId', 'sourceRevision']);
  if (value.schemaVersion !== 1) throw new AppError('INVALID_INPUT', '导出请求版本不正确。');
  return {
    schemaVersion: 1,
    projectId: parseProjectId(value.projectId),
    planRunId: parseRevisionId(value.planRunId),
    sourceRevision: parseSourceRevision(value.sourceRevision),
  };
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export class ExportService {
  private active = false;
  private epoch = 0;
  constructor(
    private readonly projects: ProjectStore,
    private readonly sources: SourceStore,
    private readonly tools: SourceToolExecutor,
    private readonly options: {
      version: string;
      kit: () => ExportFile[];
      assertSafe: (contents: readonly string[]) => void;
      chooseDestination: (suggestedName: string) => Promise<string | null>;
      protectedDirectories: string[];
    },
  ) {}
  cancel(): void {
    this.epoch++;
  }
  private capture(input: ExportRequest) {
    const project = this.projects.get(input.projectId);
    const prepared = this.tools.prepare({ projectId: input.projectId, planRunId: input.planRunId });
    const source = this.sources.get(input.projectId);
    const sourceBinding = this.sources.history(input.projectId).at(-1)?.binding ?? null;
    if (source.revision !== input.sourceRevision)
      throw new AppError('STALE_SOURCE', '源码已变化，请刷新后导出当前版本。');
    if (!source.files.length) throw new AppError('EXPORT_EMPTY', '当前没有可导出的源码。');
    return {
      project: { id: project.id, name: project.name },
      requirements: prepared.requirements,
      design: prepared.design,
      plan: prepared.plan,
      binding: prepared.binding,
      sourceBinding,
      source,
    };
  }
  async export(value: unknown): Promise<ExportResult> {
    if (this.active) throw new AppError('BUSY', '正在导出源码，请等待完成或取消。');
    const input = parseExportRequest(value);
    this.active = true;
    const epoch = this.epoch;
    try {
      const captured = this.capture(input);
      const fingerprint = sourceHash(JSON.stringify(captured));
      const files: ExportFile[] = [
        ...this.options.kit(),
        ...captured.source.files.map(({ path, content }) => ({ path, content })),
        { path: 'documents/requirements.json', content: json(captured.requirements) },
        { path: 'documents/design.json', content: json(captured.design) },
        { path: 'documents/development-plan.json', content: json(captured.plan) },
      ];
      const manifest = {
        schemaVersion: 1,
        format: 'product-factory-source-v1',
        exportedAt: new Date().toISOString(),
        productFactoryVersion: this.options.version,
        project: captured.project,
        binding: captured.binding,
        source: {
          revision: captured.source.revision,
          sha256: sourceHash(JSON.stringify(captured.source)),
          binding: captured.sourceBinding,
          alignedWithCurrentPlan:
            JSON.stringify(captured.sourceBinding) === JSON.stringify(captured.binding),
        },
        verification: {
          business: 'not_run',
          build: 'not_run_by_export',
          instructions: 'README.md',
        },
        runtime: {
          templateVersion: 'react-preview-v1',
          dataProtocol: 'factory-preview/app-data-v1',
          aiProtocol: 'factory-preview/app-ai-v1',
          aiAuthorizationIncluded: false,
          hostRequired: true,
          standalone: false,
        },
        excluded: [
          'credentials',
          'business-data',
          'logs',
          'cache',
          'source-history',
          'build-artifacts',
        ],
        files: files
          .map(({ path, content }) => ({
            path,
            bytes: Buffer.byteLength(content),
            sha256: digest(content),
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
      files.push({ path: 'manifest.json', content: json(manifest) });
      const texts = files.map((file) => file.content.toString());
      this.options.assertSafe(texts);
      const bytes = createExportZip(files);
      const suggestedName = `product-factory-${input.projectId.slice(0, 8)}-source-v${input.sourceRevision}-${Date.now()}.zip`;
      const destination = await this.options.chooseDestination(suggestedName);
      if (!destination || epoch !== this.epoch) return { status: 'cancelled' };
      if (sourceHash(JSON.stringify(this.capture(input))) !== fingerprint)
        throw new AppError('EXPORT_STALE', '项目或确认版本已变化，请重新导出。');
      this.options.assertSafe(texts);
      if (!isAbsolute(destination))
        throw new AppError('EXPORT_UNSAFE_PATH', '请选择有效的导出位置。');
      // A native dialog chooses the path. Protect the active workbench even from accidental selection.
      let target: string;
      try {
        target = join(realpathSync(dirname(destination)), basename(destination));
      } catch {
        throw new AppError('EXPORT_UNSAFE_PATH', '导出目录不可用，请重新选择位置。');
      }
      for (const root of this.options.protectedDirectories) {
        const canonical = existsSync(root) ? realpathSync(root) : resolve(root);
        const path = relative(canonical, target);
        if (!path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)))
          throw new AppError('EXPORT_PROTECTED_PATH', '请将导出包保存到工作台程序和数据目录以外。');
      }
      const saved = writeExportArchive(destination, bytes);
      return {
        status: 'exported',
        fileName: basename(destination),
        filePath: destination,
        sha256: saved.sha256,
        bytes: saved.bytes,
        fileCount: files.length,
        sourceRevision: input.sourceRevision,
      };
    } finally {
      this.active = false;
    }
  }
}
