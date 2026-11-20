/** Shared between QuickJS logic and the React UI. No browser or host objects. */

export interface BoardSummary {
  fileName: string;
  widthMm: number;
  heightMm: number;
  copperLayers: number;
  /** Parts in the component list (footprints excluded from the BOM are left out, as AISLER's plugin does). */
  parts: number;
  smt: number;
  tht: number;
  /** Parts with a manufacturer part number (`mpn`, `MPN`, `Mpn` or `AISLER_MPN`). */
  withMpn: number;
  /** Parts marked "do not populate". */
  notPlaced: number;
  /** The Gerber layers that were plotted, by AISLER's names (`F_Cu`, `Edge_Cuts`). */
  layers: string[];
}

export interface BundleSummary {
  name: string;
  size: number;
  files: { name: string; size: number }[];
}

/** One look at AISLER's import of the uploaded ZIP. */
export interface ImportStatus {
  /** `processing`: ask again. `timeout`: AISLER is still working; the project page will show the result. */
  state: 'processing' | 'ready' | 'failed' | 'timeout';
  /** AISLER's own words, shown as plain text. */
  message: string;
  /** 0 to 100 while AISLER works. */
  progress: number;
}

export interface PluginCommands {
  /** Runs every export in one KiCad run and reads the component list. */
  inspect: { params: Record<string, never>; result: BoardSummary };
  pack: { params: Record<string, never>; result: BundleSummary };
  download: { params: Record<string, never>; result: { status: 'download-requested' | 'cancelled' } };
  /** Makes a new AISLER project and uploads the ZIP to it. */
  push: { params: Record<string, never>; result: { projectId: string } };
  /** Waits its turn, then asks AISLER once how the import is going. */
  progress: { params: Record<string, never>; result: ImportStatus };
  open: { params: Record<string, never>; result: { status: 'opened' | 'cancelled' } };
}
