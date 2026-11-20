import type { PluginCommands } from './contracts';
import { AislerSession } from './logic/workflow';

// The AISLER endpoint origin in manifest.json; build.mjs sets it (a mock's in test builds).
declare const AISLER_ORIGIN: string;

// These handlers run in QuickJS. React and browser APIs belong in src/ui/.
const session = new AislerSession({
  runMany: (kinds, options) => pcbjam.exports.runMany(kinds, options),
  readJson: (exportId, name) => pcbjam.exports.readJson(exportId, name),
  bundle: proposal => pcbjam.exports.bundle(proposal),
  saveBundle: proposal => pcbjam.files.saveBundle(proposal),
  request: (endpointId, request) => pcbjam.http.request(endpointId, request),
  upload: (endpointId, request) => pcbjam.http.upload(endpointId, request),
  openExternal: url => pcbjam.ui.openExternal(url),
}, AISLER_ORIGIN);

pcbjam.handle('inspect', async (): Promise<PluginCommands['inspect']['result']> => {
  const context = await pcbjam.context.get();
  if (context.tool !== 'pcbnew') throw new Error('Open a board in the PCB editor.');
  if (!context.methods.includes('exports.runMany')) throw new Error('This PCBJam does not offer exports here. Open a saved project.');
  return session.inspect(context.fileName);
});

pcbjam.handle('pack', (): Promise<PluginCommands['pack']['result']> => session.pack());
pcbjam.handle('download', (): Promise<PluginCommands['download']['result']> => session.download());
pcbjam.handle('push', (): Promise<PluginCommands['push']['result']> => session.push());
pcbjam.handle('progress', (): Promise<PluginCommands['progress']['result']> => session.progress());
pcbjam.handle('open', (): Promise<PluginCommands['open']['result']> => session.open());
