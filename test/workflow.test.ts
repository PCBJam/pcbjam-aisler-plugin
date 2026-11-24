import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
// @ts-expect-error plain ESM helper without types
import { startAislerMock } from '../mock/aisler-mock.mjs';
import {
  AISLER_LAYERS, AislerSession, BUSY_RETRY_MS, DRILL_OPTIONS, GERBER_OPTIONS, POLL_WAITS_MS,
  boardName, checkExports, gerberSuffix, importFrom, projectIdFrom, uploadQueryFrom, zipNameFor, type HostApi,
} from '../src/logic/workflow';

const ORIGIN = 'https://aisler.net';
const fabDoc = JSON.parse(readFileSync(new URL('./fixtures/fab-components.json', import.meta.url), 'utf8'));
const file = (name: string) => ({ name, size: name.length });
/** What PCBJam answers for the four exports of a 2-layer board, set up like AISLER's plugin. */
const RUNS = {
  fab: { exportId: 'fab', files: [file('fab-components.json')] },
  gerbers: { exportId: 'gerbers', files: ['main-F_Cu.gbr', 'main-B_Cu.gbr', 'main-F_SilkS.gbr', 'main-Edge_Cuts.gbr'].map(file) },
  drill: { exportId: 'drill', files: ['main-PTH.drl', 'main-NPTH.drl'].map(file) },
  ipc356: { exportId: 'ipc356', files: [file('netlist.ipc')] },
};
const TOKEN = 'A'.repeat(164), SIGNATURE = '0f'.repeat(32);
const created = (overrides: Record<string, unknown> = {}) => ({
  status: 201,
  body: { project_url: ORIGIN + '/p/BIPWINXN', project_id: 'BIPWINXN', import_url: ORIGIN + '/p/BIPWINXN/import', upload_url: `${ORIGIN}/api/import?p=${TOKEN}&s=${SIGNATURE}`, started: false, ...overrides },
});
const JOB = '5f1c0a2b9d3e4f5a6b7c8d9e';
const uploaded = { status: 201, body: { callback: `${ORIGIN}/api/import/${JOB}`, redirect: ORIGIN + '/p/BIPWINXN' } };

function fakeHost(overrides: Partial<HostApi> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = <T,>(method: string, result: (...args: any[]) => T) => (...args: any[]) => { calls.push({ method, args }); return Promise.resolve(result(...args)); };
  const api: HostApi = {
    runMany: record('runMany', () => [RUNS.fab, RUNS.gerbers, RUNS.drill, RUNS.ipc356]),
    readJson: record('readJson', () => fabDoc),
    bundle: record('bundle', (proposal: { zipName: string }) => ({ bundleId: 'bundle-1', name: proposal.zipName, size: 1234, files: [file('main-F_Cu.gbr'), file('components.json')] })),
    saveBundle: record('saveBundle', () => ({ status: 'download-requested' as const })),
    request: record('request', (_endpoint: string, request: { path: string }) => request.path === '/p/new.json' ? created() : { status: 200, body: { progress: 100, message: 'Your production data is ready' } }),
    upload: record('upload', () => uploaded),
    openExternal: record('openExternal', () => ({ status: 'opened' as const })),
    ...overrides,
  };
  const waits: number[] = [];
  const session = new AislerSession(api, ORIGIN, async ms => { waits.push(ms); });
  return { api, calls, waits, session, of: (method: string) => calls.filter(c => c.method === method).map(c => c.args) };
}

describe('the exports', () => {
  it('asks for AISLER\'s recipe in one KiCad run and summarizes the board', async () => {
    const host = fakeHost();
    const summary = await host.session.inspect('hw/main.kicad_pcb');
    expect(host.of('runMany')).toEqual([[['fab-components', 'gerbers', 'drill', 'ipc356'], { gerbers: GERBER_OPTIONS, drill: DRILL_OPTIONS }]]);
    // The recipe of AISLER's plugin: its 19 layers, every file .gbr under KiCad's layer name, no job
    // file, mask minimum width 0, 4.6 coordinates; PTH and NPTH apart, minimal header. The mask
    // expansion stays the board's: on KiCad 10 the plugin's line that would zero it changes nothing.
    expect(GERBER_OPTIONS).toEqual({ layers: [...AISLER_LAYERS], canonicalNames: true, protelExtensions: false, jobFile: false, zeroMaskMinWidth: true, precision: 6 });
    expect(AISLER_LAYERS).toHaveLength(19);
    expect(DRILL_OPTIONS).toEqual({ separatePlated: true, minimalHeader: true, routeOvalHoles: true });
    expect(summary).toEqual({
      fileName: 'hw/main.kicad_pcb', widthMm: 55, heightMm: 42, copperLayers: 2,
      parts: 5, smt: 4, tht: 1, withMpn: 4, notPlaced: 1,
      layers: ['F_Cu', 'B_Cu', 'F_SilkS', 'Edge_Cuts'],
    });
  });

  it('refuses the files of a PCBJam that ignored the options', async () => {
    // Protel extensions, every layer, a job file and one drill file: the export as it was.
    const old = { exportId: 'g', files: ['main-F_Cu.gtl', 'main-B_Cu.gbl', 'main-Edge_Cuts.gm1', 'main-F_Courtyard.gbr', 'main-job.gbrjob'].map(file) };
    await expect(fakeHost({ runMany: async () => [RUNS.fab, old, RUNS.drill, RUNS.ipc356] }).session.inspect('main.kicad_pcb')).rejects.toThrow(/cannot make the files AISLER needs yet/);
    await expect(fakeHost({ runMany: async () => [RUNS.fab, RUNS.gerbers, { exportId: 'd', files: [file('main.drl')] }, RUNS.ipc356] }).session.inspect('main.kicad_pcb')).rejects.toThrow(/cannot make the files/);
    for (const files of [[], ['main-job.gbrjob'], ['main-F_Cu.gbr', 'main-User_1.gbr'], ['main-F_Courtyard.gbr']])
      expect(() => checkExports({ exportId: 'g', files: files.map(file) }, RUNS.drill), files.join()).toThrow(/cannot make the files/);
    // A board without an outline is the user's to fix, and AISLER would reject it.
    expect(() => checkExports({ exportId: 'g', files: ['main-F_Cu.gbr', 'main-B_Cu.gbr'].map(file) }, RUNS.drill)).toThrow(/no outline/);
    // KiCad writes an Edge.Cuts file for an empty layer too: an outline without a size is no outline.
    for (const size of [{ widthMm: 0, heightMm: 0 }, { widthMm: 55, heightMm: 0 }]) {
      const host = fakeHost({ readJson: async () => ({ ...fabDoc, board: { ...fabDoc.board, ...size } }) });
      await expect(host.session.inspect('main.kicad_pcb'), JSON.stringify(size)).rejects.toThrow(/no outline/);
      // Nothing is kept from that run: there is nothing to pack or push.
      await expect(host.session.pack()).rejects.toThrow();
      expect(host.of('bundle')).toEqual([]);
    }
    expect(gerberSuffix('my-board-In10_Cu.gbr')).toBe('In10_Cu');
    expect(gerberSuffix('my-board-In11_Cu.gbr')).toBeUndefined();
    expect(gerberSuffix('main-F_Cu.gtl')).toBeUndefined();
    // Plotted layers come back in AISLER's order.
    expect(checkExports({ exportId: 'g', files: ['b-Edge_Cuts.gbr', 'b-F_Paste.gbr', 'b-In1_Cu.gbr', 'b-F_Cu.gbr'].map(file) }, RUNS.drill)).toEqual(['F_Cu', 'In1_Cu', 'F_Paste', 'Edge_Cuts']);
  });

  it('asks a busy export service again, then gives up', async () => {
    let failures = 2;
    const busy = Object.assign(new Error('busy'), { code: 'EXPORT_UNAVAILABLE' });
    const host = fakeHost({ runMany: async () => { if (failures-- > 0) throw busy; return [RUNS.fab, RUNS.gerbers, RUNS.drill, RUNS.ipc356]; } });
    await host.session.inspect('main.kicad_pcb');
    expect(host.waits).toEqual(BUSY_RETRY_MS.slice(0, 2));
    await expect(fakeHost({ runMany: async () => { throw busy; } }).session.inspect('main.kicad_pcb')).rejects.toBe(busy);
    const other = new Error('Export failed (gerbers)');
    await expect(fakeHost({ runMany: async () => { throw other; } }).session.inspect('main.kicad_pcb')).rejects.toBe(other);
  });
});

describe('the ZIP', () => {
  it('holds the exports under their own names and components.json, named like AISLER\'s local export', async () => {
    const host = fakeHost();
    await expect(host.session.pack()).rejects.toThrow(/Read the board first/);
    await host.session.inspect('hw/main.kicad_pcb');
    const bundle = await host.session.pack();
    const [[proposal]] = host.of('bundle') as [[{ parts: unknown[]; extraFiles: { name: string; text: string }[]; zipName: string }]];
    // No renames: with canonicalNames the files already carry AISLER's names.
    expect(proposal.parts).toEqual([{ exportId: 'gerbers' }, { exportId: 'drill' }, { exportId: 'ipc356' }]);
    expect(proposal.zipName).toBe('aisler_export_main.zip');
    expect(proposal.extraFiles.map(f => f.name)).toEqual(['components.json']);
    expect(proposal.extraFiles[0]!.text).toBe(readFileSync(new URL('./fixtures/components.expected.json', import.meta.url), 'utf8'));
    expect(bundle).toEqual({ name: 'aisler_export_main.zip', size: 1234, files: [file('main-F_Cu.gbr'), file('components.json')] });
    expect(await host.session.download()).toEqual({ status: 'download-requested' });
    expect(host.of('saveBundle')).toEqual([[{ bundleId: 'bundle-1' }]]);
  });

  it('names the ZIP in the characters PCBJam accepts', () => {
    expect(zipNameFor('main.kicad_pcb')).toBe('aisler_export_main.zip');
    expect(zipNameFor('hw/rev 2/Blinky-328.KICAD_PCB')).toBe('aisler_export_Blinky-328.zip');
    expect(zipNameFor('платa (v2).kicad_pcb')).toBe('aisler_export_a _v2_.zip');
    expect(zipNameFor('###.kicad_pcb')).toBe('aisler_export_board.zip');
    expect(boardName('x'.repeat(200) + '.kicad_pcb')).toHaveLength(70);
    expect(zipNameFor('x'.repeat(200) + '.kicad_pcb')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,90}\.zip$/);
  });
});

describe('the push', () => {
  const ready = async (overrides: Partial<HostApi> = {}) => {
    const host = fakeHost(overrides);
    await host.session.inspect('hw/main.kicad_pcb');
    await host.session.pack();
    return host;
  };

  it('starts a project, uploads to the address AISLER issued and follows the import', async () => {
    const statuses = [{ progress: 0, message: 'Processing your design' }, { progress: 60.4, message: ' Checking\n drills ' }, { progress: 100, message: 'Your production data is ready' }];
    const host = await ready({ request: async (_e, request) => request.path === '/p/new.json' ? created() : { status: 200, body: statuses.shift() } });
    await expect(host.session.progress()).rejects.toThrow(/Push the ZIP to AISLER first/);
    await expect(host.session.open()).rejects.toThrow(/Push the ZIP to AISLER first/);
    expect(await host.session.push()).toEqual({ projectId: 'BIPWINXN' });
    // The query goes as names and values; PCBJam builds the address. The title is the board's name.
    expect(host.of('upload')).toEqual([['aisler', { path: '/api/import', query: { p: TOKEN, s: SIGNATURE }, bundleId: 'bundle-1', fields: { 'upload[title]': 'main' } }]]);
    expect(await host.session.progress()).toEqual({ state: 'processing', progress: 0, message: 'Processing your design' });
    expect(await host.session.progress()).toEqual({ state: 'processing', progress: 60, message: 'Checking drills' });
    expect(await host.session.progress()).toEqual({ state: 'ready', progress: 100, message: 'Your production data is ready' });
    expect(host.waits).toEqual([1000, 2000, 3000]);
    // Ready stays ready without another request.
    expect(await host.session.progress()).toEqual({ state: 'ready', progress: 100, message: '' });
    expect(host.waits).toHaveLength(3);
    expect(await host.session.open()).toEqual({ status: 'opened' });
    expect(host.of('openExternal')).toEqual([[ORIGIN + '/p/BIPWINXN']]);
  });

  it('asks about the import on PCBJam\'s request budget, then leaves it to the project page', async () => {
    const paths: string[] = [];
    const host = await ready({ request: async (_e, request) => { paths.push(request.path); return request.path === '/p/new.json' ? created() : { status: 200, body: { progress: 10, message: null } }; } });
    await host.session.push();
    const states: string[] = [];
    for (let i = 0; i < POLL_WAITS_MS.length; i++) states.push((await host.session.progress()).state);
    expect(states).toEqual([...Array(POLL_WAITS_MS.length - 1).fill('processing'), 'timeout']);
    expect(host.waits).toEqual(POLL_WAITS_MS);
    expect(paths).toEqual(['/p/new.json', ...Array(POLL_WAITS_MS.length).fill('/api/import/' + JOB)]);
    // One push stays well inside 20 requests a minute: the project, the upload and the looks.
    expect(2 + POLL_WAITS_MS.length).toBeLessThanOrEqual(14);
    expect(POLL_WAITS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
    // Nothing more is asked after the last turn.
    expect(await host.session.progress()).toEqual({ state: 'timeout', progress: 0, message: '' });
    expect(paths).toHaveLength(1 + POLL_WAITS_MS.length);
    // The page can still be opened.
    await host.session.open();
  });

  it('reports a failed import in AISLER\'s words, as text', async () => {
    const host = await ready({ request: async (_e, request) => request.path === '/p/new.json' ? created() : { status: 200, body: { progress: -1, message: '<b>Board outline is missing</b>' + ' x'.repeat(400) } } });
    await host.session.push();
    const status = await host.session.progress();
    expect(status.state).toBe('failed');
    expect(status.message.startsWith('<b>Board outline is missing</b>')).toBe(true);
    expect(status.message.length).toBeLessThanOrEqual(300);
    const odd = await ready({ request: async (_e, request) => request.path === '/p/new.json' ? created() : { status: 200, body: { message: 'no progress' } } });
    await odd.session.push();
    await expect(odd.session.progress()).rejects.toThrow(/did not say how the import is going/);
  });

  it('uploads nothing unless the address is AISLER\'s import with exactly p and s', async () => {
    const good = `${ORIGIN}/api/import?p=${TOKEN}&s=${SIGNATURE}`;
    expect(uploadQueryFrom({ upload_url: good }, ORIGIN)).toEqual({ p: TOKEN, s: SIGNATURE });
    expect(uploadQueryFrom({ upload_url: `${ORIGIN}/api/import?s=b_-&p=a` }, ORIGIN)).toEqual({ p: 'a', s: 'b_-' });
    // About one token in three ends in base64 padding, which AISLER writes as %3D; PCBJam takes it as "=".
    const padded = TOKEN.slice(0, 163);
    expect(uploadQueryFrom({ upload_url: `${ORIGIN}/api/import?p=${padded}%3D&s=${SIGNATURE}` }, ORIGIN)).toEqual({ p: padded + '=', s: SIGNATURE });
    expect(uploadQueryFrom({ upload_url: `${ORIGIN}/api/import?p=ab%3D%3D&s=b` }, ORIGIN)).toEqual({ p: 'ab==', s: 'b' });
    expect(uploadQueryFrom({ upload_url: `${ORIGIN}/api/import?p=ab%3d=&s=b` }, ORIGIN)).toEqual({ p: 'ab==', s: 'b' });
    for (const upload_url of [
      undefined, null, 42, '',
      `https://evil.example/api/import?p=a&s=b`,
      `https://aisler.net.evil.example/api/import?p=a&s=b`,
      `https://aisler.net@evil.example/api/import?p=a&s=b`,
      `http://aisler.net/api/import?p=a&s=b`,
      `${ORIGIN}:8443/api/import?p=a&s=b`,
      `${ORIGIN}/api/import/x?p=a&s=b`,
      `${ORIGIN}/api/imports?p=a&s=b`,
      `${ORIGIN}/p/ABCDEFGH/uploads.json`,
      `${ORIGIN}/api/import`,
      `${ORIGIN}/api/import?p=a`,
      `${ORIGIN}/api/import?s=b`,
      `${ORIGIN}/api/import?p=a&s=b&redirect=x`,
      `${ORIGIN}/api/import?p=a&p=c&s=b`,
      `${ORIGIN}/api/import?p=a&s=b&`,
      `${ORIGIN}/api/import?p=a%26&s=b`,
      `${ORIGIN}/api/import?p=%3D&s=b`,
      `${ORIGIN}/api/import?p=a%3D%3D%3D&s=b`,
      `${ORIGIN}/api/import?p=a%3Db&s=b`,
      `${ORIGIN}/api/import?p=a=b&s=b`,
      `${ORIGIN}/api/import?p=a%3&s=b`,
      `${ORIGIN}/api/import?p=a b&s=b`,
      `${ORIGIN}/api/import?p=&s=b`,
      `${ORIGIN}/api/import?p=${'a'.repeat(513)}&s=b`,
      `${ORIGIN}/api/import?p=a&s=b#frag`,
    ]) {
      expect(() => uploadQueryFrom({ upload_url }, ORIGIN), String(upload_url)).toThrow(/upload address this plugin does not know/);
      const host = await ready({ request: async () => created({ upload_url }) });
      await expect(host.session.push(), String(upload_url)).rejects.toThrow(/upload address/);
      expect(host.of('upload')).toEqual([]);
    }
    for (const project_id of [undefined, 'abcdefgh', 'ABCDEFG', 'ABCDEFGHI', 'ABCD/FGH', 12345678])
      expect(() => projectIdFrom({ project_id }), String(project_id)).toThrow(/without a project/);
    const refused = await ready({ request: async () => ({ status: 503, body: {} }) });
    await expect(refused.session.push()).rejects.toThrow(/did not start a project \(HTTP 503\)/);
    expect(refused.of('upload')).toEqual([]);
  });

  it('follows and opens only what AISLER\'s answer names on AISLER', async () => {
    const callback = `${ORIGIN}/api/import/${JOB}`, redirect = `${ORIGIN}/p/BIPWINXN`;
    expect(importFrom({ callback, redirect }, ORIGIN)).toEqual({ statusPath: '/api/import/' + JOB, projectUrl: redirect });
    expect(importFrom({ callback, redirect: 'https://www.aisler.net/p/BIPWINXN?x=1#y' }, ORIGIN).projectUrl).toBe('https://www.aisler.net/p/BIPWINXN?x=1#y');
    for (const bad of [
      { redirect },
      { callback: `https://evil.example/api/import/${JOB}`, redirect },
      { callback: `${ORIGIN}/api/import/`, redirect },
      { callback: `${ORIGIN}/api/import/a/b`, redirect },
      { callback: `${ORIGIN}/api/import/${JOB}?x=1`, redirect },
      { callback: `${ORIGIN}/api/import/../admin`, redirect },
      { callback: `${ORIGIN}/api/import/${'a'.repeat(65)}`, redirect },
      { callback: `${ORIGIN}/other/${JOB}`, redirect },
    ])
      expect(() => importFrom(bad, ORIGIN), JSON.stringify(bad)).toThrow(/without a way to follow the import/);
    for (const bad of ['https://evil.example/p/X', 'https://aisler.net.evil.example/p/X', 'https://aisler.net@evil.example/', 'http://aisler.net/p/X', 'https://aisler.net:8443/p/X', 'javascript:alert(1)', 'https://notaisler.net/p/X'])
      expect(() => importFrom({ callback, redirect: bad }, ORIGIN), bad).toThrow(/link outside AISLER/);
    expect(() => importFrom({ callback }, ORIGIN)).toThrow(/without a project page/);
    const host = await ready({ upload: async () => ({ status: 201, body: { callback, redirect: 'https://evil.example/p/X' } }) });
    await expect(host.session.push()).rejects.toThrow(/link outside AISLER/);
    await expect(host.session.open()).rejects.toThrow(/Push the ZIP to AISLER first/);
    const rejected = await ready({ upload: async () => ({ status: 403, body: { error: 'Forbidden' } }) });
    await expect(rejected.session.push()).rejects.toThrow(/did not accept the upload \(HTTP 403\)/);
  });

  it('every push is a new project; a new ZIP forgets the push before', async () => {
    const ids = ['AAAAAAAA', 'BBBBBBBB'];
    const host = await ready({ request: async (_e, request) => request.path === '/p/new.json' ? created({ project_id: ids.shift() }) : { status: 200, body: { progress: 100, message: '' } } });
    expect(await host.session.push()).toEqual({ projectId: 'AAAAAAAA' });
    expect(await host.session.push()).toEqual({ projectId: 'BBBBBBBB' });
    await host.session.pack();
    await expect(host.session.open()).rejects.toThrow(/Push the ZIP to AISLER first/);
    await host.session.inspect('main.kicad_pcb');
    await expect(host.session.push()).rejects.toThrow(/Build the ZIP first/);
  });
});

describe('against the mock AISLER, through a host that sends like PCBJam', () => {
  const PUBLIC = 'https://aisler-mock.example';
  let mock: { origin: string; projects: Map<string, { upload?: { filename: string; title: string; files: { name: string }[] } }>; close(): Promise<void> };
  beforeAll(async () => { mock = await startAislerMock({ port: 0, publicOrigin: PUBLIC, processingPolls: 2 }); });
  afterAll(() => mock.close());

  /** PCBJam's side of http.request and http.upload: approved paths only, the query built from names and values. */
  const viaPcbjam = (zipFiles: string[]): Partial<HostApi> => ({
    request: async (endpoint, request) => {
      expect(endpoint).toBe('aisler');
      expect(request.path === '/p/new.json' || /^\/api\/import\/[A-Za-z0-9_-]{1,64}$/.test(request.path), request.path).toBe(true);
      const response = await fetch(mock.origin + request.path, { headers: { accept: 'application/json' } });
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      return { status: response.status, body: await response.json() };
    },
    upload: async (endpoint, request) => {
      expect(endpoint).toBe('aisler');
      expect(request.path).toBe('/api/import');
      expect(Object.keys(request.query).sort()).toEqual(['p', 's']);
      for (const value of Object.values(request.query)) expect(value).toMatch(/^[A-Za-z0-9_-]{1,512}={0,2}$/);
      const form = new FormData();
      for (const [name, value] of Object.entries(request.fields)) form.set(name, value);
      form.set('upload[file]', new Blob([zipSync(Object.fromEntries(zipFiles.map(name => [name, strToU8('x')])))], { type: 'application/zip' }), 'aisler_export_main.zip');
      const query = Object.keys(request.query).sort().map(key => `${key}=${request.query[key]!.replaceAll('=', '%3D')}`).join('&');
      const response = await fetch(`${mock.origin}${request.path}?${query}`, { method: 'POST', body: form });
      return { status: response.status, body: await response.json() };
    },
  });
  const FILES = [...RUNS.gerbers.files, ...RUNS.drill.files, ...RUNS.ipc356.files].map(f => f.name).concat('components.json');

  it('pushes, follows the import to ready and opens the project page', async () => {
    const host = fakeHost(viaPcbjam(FILES));
    const session = new AislerSession(host.api, PUBLIC, async () => {});
    await session.inspect('hw/main.kicad_pcb');
    await session.pack();
    const { projectId } = await session.push();
    expect(projectId).toMatch(/^[A-Z]{8}$/);
    const states: string[] = [];
    let status = await session.progress();
    for (states.push(status.state); status.state === 'processing'; states.push(status.state)) status = await session.progress();
    expect(states).toEqual(['processing', 'processing', 'ready']);
    expect(status.message).toBe('Your production data is ready');
    await session.open();
    expect(host.of('openExternal')).toEqual([[`${PUBLIC}/p/${projectId}`]]);
    const arrived = mock.projects.get(projectId)!.upload!;
    expect(arrived).toMatchObject({ filename: 'aisler_export_main.zip', title: 'main' });
    expect(arrived.files.map(f => f.name).sort()).toEqual([...FILES].sort());
    // The next push is another project, and one of the two had a token that ends in padding.
    const next = await session.push();
    expect(next.projectId).not.toBe(projectId);
    expect(mock.projects.get(next.projectId)!.upload).toMatchObject({ filename: 'aisler_export_main.zip' });
    const tokens = [projectId, next.projectId].map(id => (mock.projects.get(id) as unknown as { token: string }).token);
    expect(tokens.filter(token => token.endsWith('=')).length).toBe(1);
    // The mock takes an upload only at the address it signed, so both tokens arrived whole.
    expect(mock.projects.get(projectId)!.upload).toBeTruthy();
  });

  it('shows why AISLER could not read a ZIP', async () => {
    const host = fakeHost(viaPcbjam(['main-F_Cu.gbr', 'components.json']));
    const session = new AislerSession(host.api, PUBLIC, async () => {});
    await session.inspect('main.kicad_pcb');
    await session.pack();
    await session.push();
    let status = await session.progress();
    while (status.state === 'processing') status = await session.progress();
    expect(status).toEqual({ state: 'failed', progress: 0, message: 'Board outline is missing' });
  });
});
