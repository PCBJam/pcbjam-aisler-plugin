import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
// @ts-expect-error plain ESM helper without types
import { startAislerMock } from '../mock/aisler-mock.mjs';

describe('mock AISLER', () => {
  let mock: { origin: string; projects: Map<string, unknown>; close(): Promise<void> };
  const PUBLIC = 'https://aisler-mock.example';
  beforeAll(async () => { mock = await startAislerMock({ port: 0, publicOrigin: PUBLIC, processingPolls: 1 }); });
  afterAll(() => mock.close());
  const local = (url: string) => mock.origin + url.slice(PUBLIC.length);
  const zip = (names: string[]) => new Blob([zipSync(Object.fromEntries(names.map(name => [name, strToU8('x')])))], { type: 'application/zip' });
  const form = (names = ['board-F_Cu.gbr', 'board-Edge_Cuts.gbr', 'components.json']) => {
    const data = new FormData();
    data.set('upload[title]', 'board');
    data.set('upload[file]', zip(names), 'aisler_export_board.zip');
    return data;
  };
  const start = async () => {
    const response = await fetch(mock.origin + '/p/new.json');
    expect(response.status).toBe(201);
    return (await response.json()) as { project_id: string; upload_url: string; project_url: string };
  };

  it('starts a project with a signed upload address, takes one upload and reports the import', async () => {
    const project = await start();
    expect(project.project_id).toMatch(/^[A-Z]{8}$/);
    expect(project.upload_url).toMatch(/^https:\/\/aisler-mock\.example\/api\/import\?p=[A-Za-z0-9_-]{164}&s=[0-9a-f]{64}$/);
    const upload = await fetch(local(project.upload_url), { method: 'POST', body: form() });
    expect(upload.status).toBe(201);
    const { callback, redirect } = (await upload.json()) as { callback: string; redirect: string };
    expect(callback).toMatch(/^https:\/\/aisler-mock\.example\/api\/import\/[0-9a-f]{24}$/);
    expect(redirect).toBe(`${PUBLIC}/p/${project.project_id}`);
    expect(await (await fetch(local(callback))).json()).toEqual({ progress: 50, message: 'Processing your design' });
    expect(await (await fetch(local(callback))).json()).toEqual({ progress: 100, message: 'Your production data is ready' });
    const page = await (await fetch(local(redirect))).text();
    expect(page).toContain('aisler_export_board.zip');
    expect(page).toContain('board-Edge_Cuts.gbr');
    // The signed address worked once.
    expect((await fetch(local(project.upload_url), { method: 'POST', body: form() })).status).toBe(403);
  });

  it('refuses an address it did not sign, a missing file, a non-ZIP and a missing title', async () => {
    const project = await start();
    const url = local(project.upload_url);
    expect((await fetch(url.replace(/s=[0-9a-f]{4}/, 's=0000'), { method: 'POST', body: form() })).status).toBe(403);
    expect((await fetch(mock.origin + '/api/import', { method: 'POST', body: form() })).status).toBe(403);
    const noFile = new FormData(); noFile.set('upload[title]', 'board');
    expect((await fetch(url, { method: 'POST', body: noFile })).status).toBe(400);
    const notZip = new FormData(); notZip.set('upload[title]', 'board'); notZip.set('upload[file]', new Blob(['<html>']), 'x.zip');
    expect((await fetch(url, { method: 'POST', body: notZip })).status).toBe(400);
    const noTitle = form(); noTitle.delete('upload[title]');
    expect((await fetch(url, { method: 'POST', body: noTitle })).status).toBe(400);
    // None of those used the address up.
    expect((await fetch(url, { method: 'POST', body: form() })).status).toBe(201);
  });

  it('fails the import of a ZIP without a board outline, as AISLER does', async () => {
    const project = await start();
    const upload = await fetch(local(project.upload_url), { method: 'POST', body: form(['board-F_Cu.gtl', 'board-Edge_Cuts.gm1']) });
    const { callback } = (await upload.json()) as { callback: string };
    await fetch(local(callback));
    expect(await (await fetch(local(callback))).json()).toEqual({ progress: -1, message: 'Board outline is missing' });
  });
});
