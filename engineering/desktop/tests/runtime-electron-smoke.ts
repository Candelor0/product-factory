import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startDesktop } from '../src/main/app';
import type { ApiResult, BlogRuntimeStatus } from '../src/shared/contracts';
import { BlogStore } from '../src/main/blog-store';

const output = process.env.FACTORY_TEST_OUTPUT!;
const phase = process.env.FACTORY_TEST_PHASE!;
const checks: string[] = [];
const check = (label: string, value: unknown) => {
  assert.ok(value, label);
  checks.push(label);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  let allowDiscard = false;
  const { window, store, runtimes, dataPath } = await startDesktop({
    dataPath: process.env.FACTORY_TEST_DATA,
    rendererPath: resolve('dist/renderer/index.html'),
    preloadPath: resolve('dist/main/preload.cjs'),
    blogPath: resolve('dist/blog'),
    show: false,
    confirmBlogClose: () => allowDiscard,
  });
  const invoke = async <T>(method: string, input: unknown): Promise<T> => {
    const result = (await window.webContents.executeJavaScript(
      `window.factory[${JSON.stringify(method)}](${JSON.stringify(input)})`,
    )) as ApiResult<T>;
    if (!result.ok) throw new Error(`${method}: ${result.error.code}`);
    return result.value;
  };
  const a =
    phase === 'create'
      ? store.create({ name: '运行验证 · 个人博客', idea: '独立本地博客运行样例，不调用模型。' })
      : store.list().find((p) => p.name === '运行验证 · 个人博客')!;
  const b =
    phase === 'create'
      ? store.create({ name: '隔离验证 · 另一博客', idea: '跨项目隔离测试。' })
      : store.list().find((p) => p.name === '隔离验证 · 另一博客')!;
  const aData = new BlogStore(join(dataPath, 'projects', a.id));
  const bData = new BlogStore(join(dataPath, 'projects', b.id));
  check(
    'runtime initially stopped, no stale PID or port revived',
    (await invoke<BlogRuntimeStatus>('blogStatus', { projectId: a.id })).status === 'stopped',
  );
  // Start from the real workbench tab and button, not from an artificial preview page.
  await window.webContents.executeJavaScript(
    `document.querySelector('.sidebar-projects button')?.click(); true`,
  );
  // The snapshot loaded before direct fixture creation; reload obtains the persisted fixtures.
  await window.reload();
  const waitMain = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await pause(30);
    }
    throw new Error(`Workbench condition timed out: ${expression}`);
  };
  await waitMain(
    `!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('运行验证 · 个人博客'))`,
  );
  await window.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('运行验证 · 个人博客')).click(); true`,
  );
  await waitMain(
    `!![...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes('运行样例'))`,
  );
  await window.webContents.executeJavaScript(
    `[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.includes('运行样例')).click(); true`,
  );
  await waitMain(`!!document.querySelector('[data-testid=start-blog]')`);
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-testid=start-blog]').click(); true`,
  );
  for (let i = 0; i < 100 && !runtimes.previewWindow(a.id); i++) await pause(30);
  let preview = runtimes.previewWindow(a.id)!;
  assert.ok(preview);
  preview.webContents.setBackgroundThrottling(false);
  const exec = <T = unknown>(code: string) =>
    preview.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 150; i++) {
      if (await exec(code)) return;
      await pause(30);
    }
    throw new Error(`Preview condition timed out: ${code}`);
  };
  await wait(
    `!!document.querySelector('[data-testid=new-article]') && !document.querySelector('[data-testid=new-article]').disabled`,
  );
  const origin = new URL(preview.webContents.getURL()).origin;
  check(
    'real workbench button starts bundled template on loopback',
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin),
  );
  check('runtime does not change requirement confirmation stage', store.get(a.id).stage === 'idea');
  check(
    'preview receives no workbench bridge or Node globals',
    await exec(
      `typeof window.factory === 'undefined' && typeof require === 'undefined' && typeof process === 'undefined'`,
    ),
  );
  const metric = app
    .getAppMetrics()
    .find((item) => item.pid === preview.webContents.getOSProcessId());
  check('preview renderer OS sandbox is enabled', metric?.sandboxed === true);
  check(
    'local callers without capability cannot read template or data',
    (await fetch(origin)).status === 403 && (await fetch(`${origin}/api/articles`)).status === 403,
  );
  const initialWindows = BrowserWindow.getAllWindows().length;
  await invoke('startBlog', { projectId: a.id });
  check(
    'repeated start focuses same runtime',
    runtimes.previewWindow(a.id) === preview &&
      BrowserWindow.getAllWindows().length === initialWindows,
  );
  const fill = async (id: string, value: string) => {
    await exec(
      `(() => { const el=document.getElementById(${JSON.stringify(id)}); const proto=el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input',{bubbles:true}));return true; })()`,
    );
    await pause(30);
  };
  if (phase === 'create') {
    await exec(`document.querySelector('[data-testid=new-article]').click(); true`);
    await wait(`!!document.getElementById('article-title')`);
    await fill('article-title', '午后的第一篇记录');
    await fill(
      'article-body',
      '从一杯茶开始，记录今天的阅读与想法。\n这段文字应该在重新打开后仍然存在。',
    );
    await fill('article-tags', '生活，阅读，全部');
    await exec(`document.querySelector('[data-testid=article-form]').requestSubmit(); true`);
    await wait(
      `document.querySelector('[data-testid=editor-state]')?.textContent.includes('已保存')`,
    );
    check(
      'real React form saves draft through authenticated local API',
      aData.list().length === 1 && aData.list()[0].status === 'draft',
    );
    await exec(
      `[...document.querySelectorAll('nav button')].find(b=>b.textContent==='首页').click();true`,
    );
    await wait(`!!document.querySelector('.hero')`);
    check(
      'draft is hidden from the public home page',
      await exec(`!document.body.innerText.includes('午后的第一篇记录')`),
    );
    await exec(
      `[...document.querySelectorAll('nav button')].find(b=>b.textContent==='文章管理').click();true`,
    );
    await wait(`!!document.querySelector('[data-testid=management-list]')`);
    await exec(`document.querySelector('[aria-label="编辑：午后的第一篇记录"]').click();true`);
    await wait(`!!document.getElementById('article-title')`);
    await fill(
      'article-body',
      '从一杯茶开始，记录今天的阅读与想法。\n编辑后的文字，会在重开后留下。',
    );
    await fill('article-status', 'published');
    await exec(`document.querySelector('[data-testid=article-form]').requestSubmit(); true`);
    await wait(
      `document.querySelector('[data-testid=editor-state]')?.textContent.includes('已保存')`,
    );
    check(
      'editing and local publication persist as a new revision',
      aData.list()[0].revision === 2 && aData.list()[0].status === 'published',
    );
    // Store adversarial content using the same API and confirm it is rendered as text.
    const injected = await exec<{ ok: boolean }>(
      `fetch('/api/articles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'安全文本样例',body:'<img src=x onerror="window.__injected=1"><script>window.__injected=1</script>',tags:['安全'],status:'published'})}).then(r=>r.json())`,
    );
    check('structured API accepts plain text, not executable HTML', injected.ok);
    await preview.reload();
    await wait(
      `!![...document.querySelectorAll('button')].find(b=>b.textContent==='安全文本样例')`,
    );
    await exec(
      `[...document.querySelectorAll('nav button')].find(b=>b.textContent==='全部文章').click();true`,
    );
    await wait(`!!document.querySelector('[aria-label="按标签筛选：全部"]')`);
    await exec(`document.querySelector('[aria-label="按标签筛选：全部"]').click();true`);
    await wait(`document.querySelectorAll('.article-card').length===1`);
    check(
      'a literal tag named All is distinct from the all-articles filter',
      await exec(
        `document.querySelector('.article-card').textContent.includes('午后的第一篇记录')`,
      ),
    );
    await exec(`document.querySelector('[aria-label="显示全部已发布文章"]').click();true`);
    await wait(`document.querySelectorAll('.article-card').length===2`);
    await exec(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='安全文本样例').click(); true`,
    );
    await wait(`!!document.querySelector('[data-testid=article-body]')`);
    check(
      'article HTML is displayed literally with no script execution',
      await exec(
        `document.querySelector('[data-testid=article-body]').textContent.includes('<script>') && !document.querySelector('[data-testid=article-body] img') && !window.__injected`,
      ),
    );
    check(
      'HTTP and HTTPS outside this runtime blocked',
      await exec(
        `Promise.all([fetch('http://127.0.0.1:1/').then(()=>false,()=>true),fetch('https://example.com').then(()=>false,()=>true)]).then(x=>x.every(Boolean))`,
      ),
    );
    check(
      'file access blocked from preview',
      await exec(`fetch('file:///etc/hosts').then(()=>false,()=>true)`),
    );
    check(
      'websocket connection outside runtime blocked',
      await exec(
        `new Promise(resolve=>{try{const s=new WebSocket('ws://127.0.0.1:1');s.onerror=()=>{s.close();resolve(true)};s.onopen=()=>{s.close();resolve(false)};setTimeout(()=>{s.close();resolve(true)},300)}catch{resolve(true)}})`,
      ),
    );
    await invoke('startBlog', { projectId: b.id });
    const other = runtimes.previewWindow(b.id)!;
    await pause(100);
    const otherOrigin = new URL(other.webContents.getURL()).origin;
    check(
      'A preview cannot access B service',
      await exec(
        `fetch(${JSON.stringify(otherOrigin + '/api/articles')}).then(()=>false,()=>true)`,
      ),
    );
    check('B project data remains empty', bData.list().length === 0);
    const count = BrowserWindow.getAllWindows().length;
    await exec(`window.open('https://example.com'); true`);
    check('preview cannot open another window', BrowserWindow.getAllWindows().length === count);
    await exec(
      `const a=document.createElement('a');a.href='https://example.com';document.body.append(a);a.click();a.remove();true`,
    );
    await pause(70);
    check('external navigation denied', preview.webContents.getURL().startsWith(origin));
    const frameBlocked = new Promise<boolean>((resolveBlocked) => {
      const timeout = setTimeout(() => resolveBlocked(false), 1500);
      preview.webContents.once('did-fail-load', (_event, code, description, _url, mainFrame) => {
        clearTimeout(timeout);
        resolveBlocked(!mainFrame && code === -30 && description === 'ERR_BLOCKED_BY_CSP');
      });
    });
    await exec(`const f=document.createElement('iframe');f.src='/';document.body.append(f);true`);
    check('frame load fails with ERR_BLOCKED_BY_CSP', await frameBlocked);
    await invoke('archiveProject', { projectId: b.id, archived: true });
    check(
      'archiving stops project runtime',
      !runtimes.previewWindow(b.id) &&
        (await fetch(otherOrigin).then(
          () => false,
          () => true,
        )),
    );
    const denied = (await window.webContents.executeJavaScript(
      `window.factory.startBlog(${JSON.stringify({ projectId: b.id })})`,
    )) as ApiResult<unknown>;
    check('archived project cannot start', !denied.ok && denied.error.code === 'ARCHIVED');
    await invoke('archiveProject', { projectId: b.id, archived: false });
  } else {
    check(
      'article content and revision survive full process restart',
      aData.list().length === 2 &&
        aData.list().some((item) => item.revision === 2 && item.body.includes('重开后留下')),
    );
    check('other project still has separate empty storage', bData.list().length === 0);
  }
  await preview.reload();
  await wait(
    `!![...document.querySelectorAll('button')].find(b=>b.textContent==='午后的第一篇记录')`,
  );
  await exec(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='午后的第一篇记录').click();true`,
  );
  await wait(`!!document.querySelector('[data-testid=article-detail]')`);
  await exec(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await pause(120);
  writeFileSync(
    join(output, `blog-${phase}.png`),
    (await preview.webContents.capturePage()).toPNG(),
  );
  writeFileSync(
    join(output, `workbench-${phase}.png`),
    (await window.webContents.capturePage()).toPNG(),
  );
  const bytes = readFileSync(join(dataPath, 'projects', a.id, 'data/blog/articles.json'));
  await exec(`document.querySelector('[data-testid=new-article]').click();true`);
  await wait(`!!document.getElementById('article-title')`);
  await fill('article-title', '尚未保存的文字');
  check(
    'cancel stopping preserves unsaved editor and running service',
    (await invoke<BlogRuntimeStatus>('stopBlog', { projectId: a.id })).status === 'running' &&
      (await exec(`document.getElementById('article-title').value==='尚未保存的文字'`)),
  );
  const cancelledArchive = (await window.webContents.executeJavaScript(
    `window.factory.archiveProject(${JSON.stringify({ projectId: a.id, archived: true })})`,
  )) as ApiResult<unknown>;
  check(
    'cancel closing prevents archival and preserves editor',
    !cancelledArchive.ok &&
      cancelledArchive.error.code === 'CANCELLED' &&
      !store.get(a.id).archived,
  );
  window.close();
  await pause(100);
  check(
    'cancel closing prevents workbench exit with unsaved content',
    !window.isDestroyed() && runtimes.previewWindow(a.id) === preview,
  );
  allowDiscard = true;
  await invoke('stopBlog', { projectId: a.id });
  check(
    'stop closes preview and TCP listener',
    !runtimes.previewWindow(a.id) &&
      (await fetch(origin).then(
        () => false,
        () => true,
      )),
  );
  await invoke('startBlog', { projectId: a.id });
  preview = runtimes.previewWindow(a.id)!;
  await wait(
    `!!document.querySelector('[data-testid=new-article]') && !document.querySelector('[data-testid=new-article]').disabled`,
  );
  check(
    'stop/start preserves exact article document',
    bytes.equals(readFileSync(join(dataPath, 'projects', a.id, 'data/blog/articles.json'))),
  );
  const reopenedOrigin = new URL(preview.webContents.getURL()).origin;
  preview.close();
  for (let i = 0; i < 100 && runtimes.previewWindow(a.id); i++) await pause(20);
  check(
    'closing preview stops its runtime',
    !runtimes.previewWindow(a.id) &&
      (await fetch(reopenedOrigin).then(
        () => false,
        () => true,
      )),
  );
  await invoke('startBlog', { projectId: a.id });
  await invoke('startBlog', { projectId: b.id });
  const closingOrigins = [a.id, b.id].map(
    (id) => new URL(runtimes.previewWindow(id)!.webContents.getURL()).origin,
  );
  app.once('will-quit', () => {
    check(
      'closing workbench stops all previews before process exit',
      !runtimes.previewWindow(a.id) && !runtimes.previewWindow(b.id),
    );
    writeFileSync(
      join(output, `runtime-${phase}.json`),
      JSON.stringify(
        {
          phase,
          checks,
          callsToModel: 0,
          closingOrigins,
          limitations: [
            'Fixed bundled template, not AI-generated code',
            'No Windows or clean OS acceptance',
            'HTTP/WS/file cases do not establish an arbitrary-code OS sandbox',
          ],
        },
        null,
        2,
      ),
    );
    console.log(`Runtime ${phase}: ${checks.length} checks passed`);
  });
  window.close();
}
mkdirSync(output, { recursive: true });
run().catch((error) => {
  console.error(String(error));
  writeFileSync(
    join(output, `runtime-${phase}-failure.txt`),
    `${String(error)}\nCompleted: ${checks.join('; ')}`,
  );
  app.exit(1);
});
