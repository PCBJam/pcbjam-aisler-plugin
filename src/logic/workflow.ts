import type { BoardSummary, BundleSummary, ImportStatus } from '../contracts';
import { aislerComponents, buildComponentsJson, parseFabDoc, type FabComponentsDoc } from './components';

/** The slice of the PCBJam host API this plugin uses; tests pass a fake. */
type ExportKind = 'gerbers' | 'drill' | 'ipc356' | 'fab-components';
type ExportRun = { exportId: string; files: { name: string; size: number }[] };
export interface GerberOptions {
  layers?: string[];
  canonicalNames?: boolean;
  protelExtensions?: boolean;
  jobFile?: boolean;
  zeroMaskExpansion?: boolean;
  zeroMaskMinWidth?: boolean;
  precision?: 5 | 6;
}
export interface DrillOptions {
  separatePlated?: boolean;
  minimalHeader?: boolean;
  routeOvalHoles?: boolean;
}
type HttpAnswer = { status: number; body: unknown };

export interface HostApi {
  /** Several exports in one KiCad run, in the order asked, with the options of each kind. */
  runMany(kinds: ExportKind[], options: { gerbers?: GerberOptions; drill?: DrillOptions }): Promise<ExportRun[]>;
  readJson(exportId: string, name: string): Promise<unknown>;
  bundle(proposal: { parts: { exportId: string; rename?: Record<string, string> }[]; extraFiles?: { name: string; text: string }[]; zipName: string }): Promise<{ bundleId: string } & BundleSummary>;
  saveBundle(proposal: { bundleId: string }): Promise<{ status: 'download-requested' | 'cancelled' }>;
  request(endpointId: string, request: { method: 'GET'; path: string }): Promise<HttpAnswer>;
  upload(endpointId: string, request: { path: string; bundleId: string; fields: Record<string, string>; query: Record<string, string> }): Promise<HttpAnswer>;
  openExternal(url: string): Promise<{ status: 'opened' | 'cancelled' }>;
}

/** The endpoint id in manifest.json. */
export const ENDPOINT = 'aisler';
/** AISLER's API, as its own KiCad plugin uses it (PushForKiCad, src/push_thread.py). */
export const NEW_PROJECT_PATH = '/p/new.json';
export const IMPORT_PATH = '/api/import';

/**
 * The layers AISLER's plugin plots, in its order (src/config.py `plotPlan`),
 * by KiCad's own layer names. A board plots the ones it has. With
 * `canonicalNames` the files get the suffixes AISLER's plugin gives them:
 * `F.SilkS` is `<board>-F_SilkS.gbr`.
 */
export const AISLER_LAYERS = [
  'F.Cu', 'B.Cu',
  'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu', 'In7.Cu', 'In8.Cu', 'In9.Cu', 'In10.Cu',
  'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'F.Paste', 'B.Paste',
  'Edge.Cuts',
] as const;
const SUFFIXES = AISLER_LAYERS.map(layer => layer.replace('.', '_'));

/**
 * How AISLER's plugin sets up KiCad before it plots: its layers only, every
 * file `.gbr` under KiCad's layer name, no job file, the solder mask minimum
 * width counted as 0, coordinates in 4.6 format.
 *
 * The mask expansion stays the board's. AISLER's plugin has a line meant to
 * zero it too (`settings.m_SolderMaskMargin = 0`), but KiCad renamed that
 * setting to `m_SolderMaskExpansion` in 2021, before its version 6, so in the
 * KiCad 10 that PCBJam runs the line changes nothing, and this plugin sends
 * what AISLER's sends. If AISLER fixes it: add `zeroMaskExpansion: true` here.
 */
export const GERBER_OPTIONS: GerberOptions = {
  layers: [...AISLER_LAYERS],
  canonicalNames: true,
  protelExtensions: false,
  jobFile: false,
  zeroMaskMinWidth: true,
  precision: 6,
};
/** And its drill files: plated and non-plated holes apart, minimal header, oval holes routed. */
export const DRILL_OPTIONS: DrillOptions = { separatePlated: true, minimalHeader: true, routeOvalHoles: true };

export const FILES = { netlist: 'netlist.ipc', components: 'components.json' } as const;

/** The Gerber layer of a file from the export, by AISLER's suffix, or undefined for any other file. */
export function gerberSuffix(name: string): string | undefined {
  const match = /-([A-Za-z0-9]+_[A-Za-z0-9]+)\.gbr$/.exec(name);
  return match && SUFFIXES.includes(match[1]!) ? match[1] : undefined;
}

const NO_OUTLINE = 'The board has no outline. Draw it on the Edge.Cuts layer first.';

/**
 * An older PCBJam ignores export options and answers with its usual files
 * (Protel extensions, every layer, a job file, one drill file). AISLER reads
 * none of that as a board, so check what came back before packing it.
 */
export function checkExports(gerbers: ExportRun, drill: ExportRun): string[] {
  const layers = gerbers.files.map(file => gerberSuffix(file.name));
  const drills = drill.files.every(file => /-(PTH|NPTH)\.drl$/.test(file.name));
  if (!gerbers.files.length || layers.includes(undefined) || !drill.files.length || !drills)
    throw new Error('This PCBJam cannot make the files AISLER needs yet. Try again after its next update.');
  if (!layers.includes('Edge_Cuts')) throw new Error(NO_OUTLINE);
  // In AISLER's order, whatever order the files came in.
  return SUFFIXES.filter(suffix => layers.includes(suffix));
}

/** `aisler_export_<board>.zip`, the name of the ZIP AISLER's plugin saves, in the characters PCBJam accepts. */
export function boardName(fileName: string) {
  const base = (fileName.split('/').pop() || 'board').replace(/\.kicad_pcb$/i, '');
  return base.replace(/[^a-zA-Z0-9 _.-]/g, '_').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 70) || 'board';
}
export const zipNameFor = (fileName: string) => `aisler_export_${boardName(fileName)}.zip`;

// Plugin logic runs in QuickJS, which has no URL parser. These patterns take
// an address apart by hand; the host part may hold neither '@' nor ':', so no
// credentials and no port get through.
const hostOf = (origin: string) => /^https:\/\/([a-z0-9.-]+)$/.exec(origin)?.[1];

/**
 * The query of the upload address AISLER issued for a new project. It must be
 * `<origin>/api/import?p=...&s=...`: this plugin's endpoint, that one path,
 * exactly those two parameters once each, in plain characters. Anything else
 * and nothing is uploaded.
 */
export function uploadQueryFrom(body: unknown, origin: string): { p: string; s: string } {
  const url = (body as { upload_url?: unknown } | null)?.upload_url;
  const unknown = () => new Error('AISLER answered with an upload address this plugin does not know.');
  if (typeof url !== 'string' || !hostOf(origin) || !url.startsWith(origin + IMPORT_PATH + '?')) throw unknown();
  const query: Record<string, string> = {};
  for (const pair of url.slice(origin.length + IMPORT_PATH.length + 1).split('&')) {
    const match = /^([ps])=([A-Za-z0-9_-]{1,512})$/.exec(pair);
    if (!match || Object.hasOwn(query, match[1]!)) throw unknown();
    query[match[1]!] = match[2]!;
  }
  if (typeof query.p !== 'string' || typeof query.s !== 'string') throw unknown();
  return { p: query.p, s: query.s };
}

/** The id of a new AISLER project: eight capital letters. */
export function projectIdFrom(body: unknown): string {
  const id = (body as { project_id?: unknown } | null)?.project_id;
  if (typeof id !== 'string' || !/^[A-Z]{8}$/.test(id)) throw new Error('AISLER answered without a project.');
  return id;
}

/**
 * Where to ask about the import (`callback`) and the project page to open
 * (`redirect`), from AISLER's answer to the upload. The first must be
 * `<origin>/api/import/<job>`; the second a page on AISLER's own site.
 */
export function importFrom(body: unknown, origin: string): { statusPath: string; projectUrl: string } {
  const { callback, redirect } = (body ?? {}) as { callback?: unknown; redirect?: unknown };
  const prefix = origin + IMPORT_PATH + '/';
  if (typeof callback !== 'string' || !callback.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,64}$/.test(callback.slice(prefix.length)))
    throw new Error('AISLER answered without a way to follow the import.');
  if (typeof redirect !== 'string') throw new Error('AISLER answered without a project page.');
  const host = /^https:\/\/([A-Za-z0-9.-]+)(?:[/?#][^\s]*)?$/.exec(redirect)?.[1]?.toLowerCase();
  const site = (hostOf(origin) ?? '').replace(/^www\./, '');
  if (!host || !site || !(host === site || host.endsWith('.' + site)))
    throw new Error('AISLER answered with a link outside AISLER.');
  return { statusPath: callback.slice(origin.length), projectUrl: redirect };
}

/** AISLER's words about an import, cut to a line or two; never markup (the panel shows it as text). */
const messageFrom = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '');

/**
 * When to ask AISLER about the import, in milliseconds after the upload or the
 * look before: quickly at first (a small board is ready in a few seconds),
 * then slowly. PCBJam allows a plugin 20 requests a minute, so not every half
 * second like AISLER's plugin. After the last one the panel stops asking.
 */
export const POLL_WAITS_MS = [1000, 2000, 3000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];

/** Waits before asking a busy export service again (`EXPORT_UNAVAILABLE`: its pool is full). */
export const BUSY_RETRY_MS = [1000, 2000, 4000];

/**
 * One run of the AISLER workflow. Each step is a separate UI command so the
 * panel can show progress.
 */
export class AislerSession {
  private doc?: FabComponentsDoc;
  private parts?: { gerbers: string; drill: string; ipc356: string };
  private bundleId?: string;
  private pushed?: { statusPath: string; projectUrl: string; polls: number; done: boolean };
  private fileName = 'board.kicad_pcb';

  /**
   * `origin`: the AISLER endpoint origin in the manifest (a mock's in test builds).
   * `wait`: the pause before a retry or a look at the import (logic timers in QuickJS; tests pass their own).
   */
  constructor(private readonly api: HostApi, private readonly origin = 'https://aisler.net',
    private readonly wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); })) {}

  /** Runs the four exports in one KiCad run, set up like AISLER's plugin, and reads the component list. */
  async inspect(fileName: string): Promise<BoardSummary> {
    this.doc = undefined;
    this.parts = undefined;
    this.bundleId = undefined;
    this.pushed = undefined;
    this.fileName = fileName;
    const [fab, gerbers, drill, ipc356] = await this.busy(() =>
      this.api.runMany(['fab-components', 'gerbers', 'drill', 'ipc356'], { gerbers: GERBER_OPTIONS, drill: DRILL_OPTIONS }));
    if (!fab || !gerbers || !drill || !ipc356) throw new Error('The export produced no files.');
    const layers = checkExports(gerbers, drill);
    if (!ipc356.files.some(file => file.name === FILES.netlist)) throw new Error('The netlist export produced no file.');
    const json = fab.files.find(file => file.name.endsWith('.json'));
    if (!json) throw new Error('The component export produced no data.');
    const doc = parseFabDoc(await this.api.readJson(fab.exportId, json.name));
    // KiCad plots an Edge.Cuts file for an empty layer too, so the file being there says nothing:
    // the size of the board's outline does. AISLER fails such an upload ("Board outline is missing").
    if (!(doc.board.widthMm > 0 && doc.board.heightMm > 0)) throw new Error(NO_OUTLINE);
    this.doc = doc;
    this.parts = { gerbers: gerbers.exportId, drill: drill.exportId, ipc356: ipc356.exportId };
    const components = aislerComponents(doc);
    return {
      fileName,
      widthMm: doc.board.widthMm,
      heightMm: doc.board.heightMm,
      copperLayers: doc.board.copperLayers,
      parts: components.length,
      smt: components.filter(c => c.mount_type === 'smt').length,
      tht: components.filter(c => c.mount_type === 'tht').length,
      withMpn: components.filter(c => c.mpn).length,
      notPlaced: components.filter(c => !c.place).length,
      layers,
    };
  }

  /** A busy export service is asked again a few times before giving up. */
  private async busy<T>(call: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'EXPORT_UNAVAILABLE' || attempt >= BUSY_RETRY_MS.length) throw error;
        await this.wait(BUSY_RETRY_MS[attempt]!);
      }
    }
  }

  /** The ZIP AISLER's plugin builds: the Gerber and drill files, `netlist.ipc` and `components.json`. */
  async pack(): Promise<BundleSummary> {
    if (!this.doc || !this.parts) throw new Error('Read the board first.');
    const bundle = await this.api.bundle({
      parts: [{ exportId: this.parts.gerbers }, { exportId: this.parts.drill }, { exportId: this.parts.ipc356 }],
      extraFiles: [{ name: FILES.components, text: buildComponentsJson(this.doc) }],
      zipName: zipNameFor(this.fileName),
    });
    this.bundleId = bundle.bundleId;
    this.pushed = undefined;
    return { name: bundle.name, size: bundle.size, files: bundle.files };
  }

  async download() {
    if (!this.bundleId) throw new Error('Build the ZIP first.');
    return this.api.saveBundle({ bundleId: this.bundleId });
  }

  /**
   * Asks AISLER for a new project and uploads the ZIP to the address it
   * issued, with the board's name as the title. Every push is a new project.
   */
  async push() {
    if (!this.bundleId) throw new Error('Build the ZIP first.');
    this.pushed = undefined;
    const created = await this.api.request(ENDPOINT, { method: 'GET', path: NEW_PROJECT_PATH });
    if (created.status !== 200 && created.status !== 201) throw new Error(`AISLER did not start a project (HTTP ${created.status}).`);
    const projectId = projectIdFrom(created.body);
    const query = uploadQueryFrom(created.body, this.origin);
    const answer = await this.api.upload(ENDPOINT, {
      path: IMPORT_PATH,
      query,
      bundleId: this.bundleId,
      fields: { 'upload[title]': boardName(this.fileName) },
    });
    if (answer.status !== 200 && answer.status !== 201) throw new Error(`AISLER did not accept the upload (HTTP ${answer.status}).`);
    this.pushed = { ...importFrom(answer.body, this.origin), polls: 0, done: false };
    return { projectId };
  }

  /**
   * Waits its turn (POLL_WAITS_MS), then asks AISLER once how the import is
   * going. `timeout` after the last turn: AISLER is still working and its
   * project page will show how it ended.
   */
  async progress(): Promise<ImportStatus> {
    const pushed = this.pushed;
    if (!pushed) throw new Error('Push the ZIP to AISLER first.');
    if (pushed.done) return { state: 'ready', progress: 100, message: '' };
    if (pushed.polls >= POLL_WAITS_MS.length) return { state: 'timeout', progress: 0, message: '' };
    await this.wait(POLL_WAITS_MS[pushed.polls]!);
    pushed.polls++;
    const answer = await this.api.request(ENDPOINT, { method: 'GET', path: pushed.statusPath });
    const body = (answer.body ?? {}) as { progress?: unknown; message?: unknown };
    if (answer.status !== 200 || typeof body.progress !== 'number')
      throw new Error(`AISLER did not say how the import is going (HTTP ${answer.status}).`);
    const message = messageFrom(body.message);
    if (body.progress === -1) return { state: 'failed', progress: 0, message };
    if (body.progress >= 100) {
      pushed.done = true;
      return { state: 'ready', progress: 100, message };
    }
    const progress = Math.max(0, Math.min(99, Math.round(body.progress)));
    return { state: pushed.polls >= POLL_WAITS_MS.length ? 'timeout' : 'processing', progress, message };
  }

  /** PCBJam asks the user, then opens the AISLER project page in a new tab. */
  async open() {
    if (!this.pushed) throw new Error('Push the ZIP to AISLER first.');
    return this.api.openExternal(this.pushed.projectUrl);
  }
}
