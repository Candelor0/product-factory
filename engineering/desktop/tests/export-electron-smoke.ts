import { app } from 'electron';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDesktop } from '../src/main/app';
import type { ApiResult, Project, Usage } from '../src/shared/contracts';
import type { BuildResult } from '../src/shared/build-contracts';
import type { ExportRequest, ExportResult } from '../src/shared/export-contracts';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const destinations = process.env.FACTORY_TEST_EXPORTS!;
const node = process.env.FACTORY_TEST_NODE!;
const checks: string[] = [];
const check = (name: string, value: unknown) => {
  assert.ok(value, name);
  checks.push(name);
};
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const key = 'export-synthetic-key-no-account-2026';
const businessSentinel = '业务内容仅留本机-导出不得包含-Ω';
const logSentinel = '日志缓存排除哨兵-2026-EXPORT';
const source = `import {useEffect,useState} from 'react';
import {appData} from '@factory/data';
export default function App(){
 const [count,setCount]=useState(null);
 useEffect(()=>{appData.read().then(value=>setCount(Object.keys(value.values).length));},[]);
 return <main style={{maxWidth:640,margin:'64px auto',fontFamily:'system-ui'}}><h1>源码导出验证</h1><p>读取数据键数：{count===null?'正在读取':count}</p></main>;
}`;
const requirement = {
  summary: '一个可以读取项目数据的本地页面',
  audience: '自己',
  features: ['读取数据键数量'],
  pages: ['首页'],
  data: ['项目业务JSON'],
  outOfScope: ['公网发布', '独立安装包'],
  questions: [],
  acceptance: ['导出源码和确认文档，保留本机内容'],
};
const design = {
  direction: '浅色单页',
  palette: ['#ffffff', '#24272b'],
  pages: [{ name: '首页', sections: ['标题', '读取状态'] }],
  notes: [],
};
const fileNames = (directory: string, prefix = ''): string[] =>
  readdirSync(join(directory, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? fileNames(directory, path) : [path];
    })
    .sort();
const filesHash = (directory: string) =>
  Object.fromEntries(
    fileNames(directory).map((path) => [path, hash(readFileSync(join(directory, path)))]),
  );
type Saved = {
  projectId: string;
  source: string;
  revision: number;
  hashes: Record<string, string>;
  credentialHashes: Record<string, string>;
  usage: Usage;
  exports: string[];
};

async function run() {
  let calls = 0;
  const choices: string[] = [];
  let choose: () => Promise<string | null> = async () => null;
  const desktop = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    toolchainPath: resolve('dist/toolchain'),
    exportKitPath: resolve('dist/export-kit'),
    show: false,
    chooseExportDestination: async (suggestedName) => {
      choices.push(suggestedName);
      return choose();
    },
    modelRequest: async () => {
      calls++;
      throw new Error('No model request is permitted in export smoke');
    },
  });
  const { window, store, plans, sources, sourceTools, models, previews, appData } = desktop;
  window.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(script: string) =>
    window.webContents.executeJavaScript(script) as Promise<T>;
  const raw = <T = unknown>(method: string, input?: unknown) =>
    exec<ApiResult<T>>(`window.factory[${JSON.stringify(method)}](${JSON.stringify(input)})`);
  const invoke = async <T>(method: string, input?: unknown): Promise<T> => {
    const result = await raw<T>(method, input);
    if (!result.ok) throw new Error(`${method}: ${result.error.code}`);
    return result.value;
  };
  const waitFor = async (name: string, predicate: () => Promise<boolean>) => {
    const end = Date.now() + 20_000;
    do {
      if (await predicate()) return;
      await delay(40);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${name}`);
  };
  const create = () => {
    let project = store.create({ name: '源码导出验证', idea: requirement.summary });
    project = store.saveRequirements(project.id, requirement);
    project = store.approveRequirements(project.id, project.requirements.at(-1)!.id);
    project = store.saveDesign(project.id, design);
    project = store.approveDesign(project.id, project.designs.at(-1)!.id);
    plans.create({
      schemaVersion: 1,
      requestId: randomUUID(),
      projectId: project.id,
      requirementId: project.requirements.at(-1)!.id,
      designId: project.designs.at(-1)!.id,
      profile: 'web',
    });
    return project;
  };
  const write = (id: string, content: string) => {
    const snapshot = sources.get(id);
    const result = sourceTools.execute(
      { projectId: id, planRunId: plans.get(id).run!.id },
      {
        schemaVersion: 1,
        requestId: randomUUID(),
        tool: 'apply_changes',
        arguments: {
          expectedRevision: snapshot.revision,
          changes: [
            {
              operation: 'write',
              path: 'src/app.tsx',
              expectedHash: snapshot.files[0]?.sha256 ?? null,
              content,
            },
          ],
        },
      },
    );
    assert.ok(result.ok);
  };
  const request = (id: string): ExportRequest => ({
    schemaVersion: 1,
    projectId: id,
    planRunId: plans.get(id).run!.id,
    sourceRevision: sources.get(id).revision,
  });
  const openPlan = async (project: Project) => {
    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('project sidebar', () =>
      exec(
        `Array.from(document.querySelectorAll('.project-item')).some(e=>e.textContent.includes(${JSON.stringify(project.name)}))`,
      ),
    );
    await exec(
      `Array.from(document.querySelectorAll('.project-item')).find(e=>e.textContent.includes(${JSON.stringify(project.name)})).click();true`,
    );
    await waitFor('plan tab', () =>
      exec(
        'Array.from(document.querySelectorAll("[role=tab]")).some(e=>e.textContent.includes("开发计划"))',
      ),
    );
    await exec(
      'Array.from(document.querySelectorAll("[role=tab]")).find(e=>e.textContent.includes("开发计划")).click();true',
    );
    await waitFor('export button enabled', () =>
      exec(
        '!!document.querySelector("[data-testid=export-source]") && !document.querySelector("[data-testid=export-source]").disabled',
      ),
    );
  };
  const clickExport = () =>
    exec('document.querySelector("[data-testid=export-source]").click();true');
  const exportStatus = (status: string) =>
    waitFor(`export ${status}`, () =>
      exec(
        `document.querySelector('[data-testid=export-state]')?.dataset.status===${JSON.stringify(status)}`,
      ),
    );
  const singlePanels = () =>
    exec(
      "['recovery-state','export-state'].every(id=>document.querySelectorAll('[data-testid='+id+']').length===1)",
    );
  const verifyZip = (path: string, id: string, expectedSource: string, revision: number) => {
    const extracted = join(destinations, `unpacked-${phase}-${revision}`);
    mkdirSync(extracted, { recursive: true });
    const unzip = spawnSync('/usr/bin/unzip', ['-q', path, '-d', extracted], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    check('system unzip reads the real UTF-8 ZIP', unzip.status === 0);
    const manifest = JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'));
    check(
      'manifest binds current project source version and honest verification',
      manifest.format === 'product-factory-source-v1' &&
        manifest.project.id === id &&
        manifest.source.revision === revision &&
        manifest.runtime.standalone === false &&
        manifest.verification.business === 'not_run' &&
        manifest.verification.build === 'not_run_by_export',
    );
    const entries = manifest.files as { path: string; bytes: number; sha256: string }[];
    check(
      'ZIP file list exactly matches the manifest',
      JSON.stringify(fileNames(extracted)) ===
        JSON.stringify([...entries.map((entry) => entry.path), 'manifest.json'].sort()),
    );
    check(
      'every exported entry matches its declared byte count and SHA-256',
      entries.every((entry) => {
        const bytes = readFileSync(join(extracted, entry.path));
        return bytes.length === entry.bytes && hash(bytes) === entry.sha256;
      }),
    );
    check(
      'exact source retains its constrained data SDK import',
      readFileSync(join(extracted, 'src/app.tsx'), 'utf8') === expectedSource &&
        expectedSource.includes('@factory/data'),
    );
    const prepared = sourceTools.prepare({ projectId: id, planRunId: plans.get(id).run!.id });
    for (const [name, expected] of Object.entries({
      requirements: prepared.requirements,
      design: prepared.design,
      'development-plan': prepared.plan,
    })) {
      check(
        `confirmed ${name} document is exported exactly`,
        JSON.stringify(
          JSON.parse(readFileSync(join(extracted, `documents/${name}.json`), 'utf8')),
        ) === JSON.stringify(expected),
      );
    }
    const kitManifest = JSON.parse(readFileSync(resolve('dist/export-kit.manifest.json'), 'utf8'));
    check(
      'all fixed kit resources match the packaged kit',
      kitManifest.files.every(
        (entry: { path: string; sha256: string }) =>
          hash(readFileSync(join(extracted, entry.path))) === entry.sha256,
      ),
    );
    const contents = fileNames(extracted).map((name) => readFileSync(join(extracted, name)));
    check(
      'credentials business content logs and cache sentinels are absent',
      contents.every((bytes) =>
        [
          key,
          encodeURIComponent(key),
          Buffer.from(key).toString('base64'),
          businessSentinel,
          logSentinel,
        ].every((sentinel) => !bytes.includes(Buffer.from(sentinel))),
      ),
    );
    check(
      'private directories and source history are excluded',
      !fileNames(extracted).some(
        (name) =>
          /^(?:credentials|data|logs|cache|runs|builds)\//u.test(name) ||
          name.endsWith('workspace.json'),
      ),
    );
    const verify = spawnSync(node, ['scripts/verify.mjs'], {
      cwd: extracted,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
    writeFileSync(
      join(output, `verify-${phase}-v${revision}.log`),
      `${verify.stdout ?? ''}${verify.stderr ?? ''}`,
    );
    check(
      'a fresh Node process verifies the exported package without installing dependencies',
      verify.status === 0,
    );
  };

  let saved: Saved;
  if (phase === 'create') {
    const project = create();
    const id = project.id;
    write(id, source);
    models.save({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: key,
      maxCalls: 10,
    });
    appData.apply(id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      changes: [{ operation: 'put', key: 'posts', value: [{ title: businessSentinel }] }],
    });
    const projectRoot = join(store.rootPath, 'projects', id);
    for (const name of ['logs/export-test.log', 'cache/export-test.txt']) {
      mkdirSync(join(projectRoot, name.split('/')[0]), { recursive: true });
      writeFileSync(join(projectRoot, name), logSentinel);
    }
    const built = await invoke<BuildResult>('buildSource', {
      ...request(id),
      requestId: randomUUID(),
    });
    check('source with data SDK really compiles', built.status === 'succeeded');
    await invoke('openPreview', { projectId: id, buildId: built.state.artifact!.id });
    const preview = previews.previewWindow(id)!;
    check(
      'generated preview has no export IPC or Node API',
      await preview.webContents.executeJavaScript(
        "typeof window.factory==='undefined' && typeof require==='undefined' && typeof process==='undefined'",
      ),
    );
    await previews.stop(id);
    await openPlan(project);
    const baseline = filesHash(projectRoot);
    const credentials = filesHash(join(store.rootPath, 'credentials'));
    const usage = models.usage();
    const target = join(destinations, '中文 空格.zip');
    choose = async () => target;
    await clickExport();
    await exportStatus('exported');
    check(
      'export state updates retain exactly one recovery and export panel',
      await singlePanels(),
    );
    check(
      'UI click writes the trusted chooser destination',
      existsSync(target) && choices.length === 1,
    );
    check(
      'UI displays the exported name and exact version',
      await exec(
        "document.querySelector('[data-testid=export-result]').textContent.includes('中文 空格.zip') && document.querySelector('[data-testid=export-result]').textContent.includes('源码版本 1')",
      ),
    );
    verifyZip(target, id, source, 1);
    check(
      'all project files are byte-identical after export',
      JSON.stringify(filesHash(projectRoot)) === JSON.stringify(baseline),
    );
    check(
      'credentials are byte-identical after export',
      JSON.stringify(filesHash(join(store.rootPath, 'credentials'))) ===
        JSON.stringify(credentials),
    );
    check('export does not change usage', JSON.stringify(models.usage()) === JSON.stringify(usage));

    for (const [width, height] of [
      [1440, 920],
      [1024, 720],
    ]) {
      window.setSize(width, height);
      await delay(200);
      await exec(
        'document.querySelector("[data-testid=export-state]").scrollIntoView({block:"center"});true',
      );
      await delay(200);
      check(
        `${width} export layout has no horizontal overflow`,
        await exec('document.documentElement.scrollWidth <= innerWidth'),
      );
      writeFileSync(
        join(output, `export-${width}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    const filesBeforeCancel = fileNames(destinations);
    choose = async () => null;
    await clickExport();
    await exportStatus('cancelled');
    check('cancelled export retains exactly one recovery and export panel', await singlePanels());
    check(
      'chooser cancellation creates no new files',
      JSON.stringify(fileNames(destinations)) === JSON.stringify(filesBeforeCancel),
    );
    check(
      'cancelled export does not display an error',
      await exec("!document.querySelector('[data-testid=export-state] [role=alert]')"),
    );

    let release!: (value: string | null) => void;
    choose = () =>
      new Promise((resolveChoice) => {
        release = resolveChoice;
      });
    const beforePending = choices.length;
    await clickExport();
    await waitFor('pending chooser', async () => choices.length === beforePending + 1 && !!release);
    await exportStatus('exporting');
    check(
      'pending export disables source generation export and build UI',
      await exec(
        "['export-source','generate-source','build-source'].every(id=>document.querySelector('[data-testid='+id+']')?.disabled)",
      ),
    );
    const concurrent = await Promise.all([
      raw('generateSource', {
        schemaVersion: 1,
        requestId: randomUUID(),
        projectId: id,
        planRunId: plans.get(id).run!.id,
      }),
      raw('archiveProject', { projectId: id, archived: true }),
      raw('exportSource', request(id)),
    ]);
    check(
      'global IPC mutex rejects generation archive and duplicate export while chooser waits',
      concurrent.every((result) => !result.ok && result.error.code === 'BUSY'),
    );
    check(
      'duplicate export does not open another chooser or archive the project',
      choices.length === beforePending + 1 && !store.get(id).archived,
    );
    release(null);
    await exportStatus('cancelled');

    choose = () =>
      new Promise((resolveChoice) => {
        release = resolveChoice;
      });
    const beforeStale = choices.length;
    await exec(
      `window.__exportOutcome=null;window.factory.exportSource(${JSON.stringify(request(id))}).then(result=>{window.__exportOutcome=result});true`,
    );
    await waitFor('stale-source chooser', async () => choices.length === beforeStale + 1);
    const nextSource = `${source}\n// Updated after the save dialog opened.\n`;
    write(id, nextSource);
    const stalePath = join(destinations, 'stale.zip');
    release(stalePath);
    await waitFor('stale source response', () => exec('window.__exportOutcome!==null'));
    const stale = await exec<ApiResult<ExportResult>>('window.__exportOutcome');
    check(
      'source change while choosing is rejected without writing a ZIP',
      !stale.ok && stale.error.code === 'STALE_SOURCE' && !existsSync(stalePath),
    );
    const beforeInjection = choices.length;
    const injection = await raw('exportSource', {
      ...request(id),
      filePath: join(destinations, 'injected.zip'),
    });
    check(
      'renderer cannot inject a destination path',
      !injection.ok &&
        injection.error.code === 'INVALID_INPUT' &&
        choices.length === beforeInjection &&
        !existsSync(join(destinations, 'injected.zip')),
    );

    const updatedPath = join(destinations, '当前源码 再导出.zip');
    choose = async () => updatedPath;
    await openPlan(project);
    await clickExport();
    await exportStatus('exported');
    check(
      'current source exports after a version change without requiring another build',
      existsSync(updatedPath),
    );
    verifyZip(updatedPath, id, nextSource, sources.get(id).revision);

    await window.loadFile(resolve('dist/renderer/index.html'));
    await waitFor('central home', () =>
      exec('!!document.querySelector("[data-testid=idea-home]")'),
    );
    check(
      'light central input homepage and project sidebar remain intact',
      await exec(
        '!!document.querySelector("#idea-input") && document.querySelectorAll(".project-item").length===1 && !document.querySelector("[data-testid=export-state]")',
      ),
    );
    for (const [width, height] of [
      [1440, 920],
      [1024, 720],
    ]) {
      window.setSize(width, height);
      await delay(200);
      writeFileSync(
        join(output, `home-${width}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    saved = {
      projectId: id,
      source: nextSource,
      revision: sources.get(id).revision,
      hashes: filesHash(projectRoot),
      credentialHashes: filesHash(join(store.rootPath, 'credentials')),
      usage: models.usage(),
      exports: fileNames(destinations),
    };
    writeFileSync(join(output, 'fixtures.json'), JSON.stringify(saved, null, 2));
  } else {
    saved = JSON.parse(readFileSync(join(output, 'fixtures.json'), 'utf8'));
    check(
      'restart neither invokes chooser nor automatically writes exports',
      choices.length === 0 &&
        JSON.stringify(fileNames(destinations)) === JSON.stringify(saved.exports),
    );
    const projectRoot = join(store.rootPath, 'projects', saved.projectId);
    check(
      'restart retains exact project files',
      JSON.stringify(filesHash(projectRoot)) === JSON.stringify(saved.hashes),
    );
    check(
      'restart retains exact credentials and usage',
      JSON.stringify(filesHash(join(store.rootPath, 'credentials'))) ===
        JSON.stringify(saved.credentialHashes) &&
        JSON.stringify(models.usage()) === JSON.stringify(saved.usage),
    );
    await openPlan(store.get(saved.projectId));
    const path = join(destinations, '重开 再导出.zip');
    choose = async () => path;
    await clickExport();
    await exportStatus('exported');
    check(
      'new workbench process exports again on explicit UI action',
      choices.length === 1 && existsSync(path),
    );
    check('reopened export retains exactly one recovery and export panel', await singlePanels());
    verifyZip(path, saved.projectId, saved.source, saved.revision);
    check(
      're-export preserves exact project and credential files',
      JSON.stringify(filesHash(projectRoot)) === JSON.stringify(saved.hashes) &&
        JSON.stringify(filesHash(join(store.rootPath, 'credentials'))) ===
          JSON.stringify(saved.credentialHashes),
    );
  }
  check(
    'no model request or charge is initiated by export or restart',
    calls === 0 && models.usage().calls === 0,
  );
  check(
    'suggested export names are ZIP filenames without directory selection',
    choices.every((name) => !name.includes('/') && name.endsWith('.zip')),
  );
  await previews.stopAll();
  writeFileSync(
    join(output, `export-${phase}.json`),
    JSON.stringify(
      {
        phase,
        passed: checks.length,
        checks,
        realProviderRequests: 0,
        chooserCalls: choices.length,
        versions: process.versions,
        limitations: [
          'Trusted chooser injection replaces manually operating the system save dialog; real UI, IPC, ZIP writing, unzip and Node verification are exercised.',
          'No dependency installation or exported-project build in this suite; the export-kit suite verifies that separately.',
          'Isolated synthetic project and credentials; macOS arm64 only, no clean environment or complete business acceptance.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Export ${phase}: ${checks.length} checks passed`);
  app.exit(0);
}
mkdirSync(output, { recursive: true });
mkdirSync(destinations, { recursive: true });
run().catch((error) => {
  console.error(String(error));
  writeFileSync(
    join(output, `failure-${phase}.json`),
    JSON.stringify({ error: String(error), checks }, null, 2),
  );
  app.exit(1);
});
