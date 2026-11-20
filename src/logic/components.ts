/**
 * `components.json`, the component list in AISLER's ZIP: pure functions over
 * PCBJam's `fab-components` export.
 *
 * The fields, the skip rule, the mount type and the key order are ported from
 * AISLER's KiCad plugin: PushForKiCad (MIT, (c) AISLER B.V.),
 * src/push_thread.py @ 892ff80 (0.3.2). The file is written the way Python's
 * `json.dump` writes it there, so it is the same text for the same board.
 */

export interface FabFootprint {
  ref: string;
  fpid: string;
  side: 'top' | 'bottom';
  posMm: { x: number; y: number };
  rotationDeg: number;
  smd: boolean;
  excludeFromPos: boolean;
  excludeFromBom: boolean;
  dnp: boolean;
  fields: Record<string, string>;
}

export interface FabComponentsDoc {
  board: {
    widthMm: number;
    heightMm: number;
    bboxOriginMm: { x: number; y: number };
    auxOriginMm: { x: number; y: number };
    copperLayers: number;
    thicknessMm: number;
  };
  footprints: FabFootprint[];
}

/** One entry of `components.json`, keys in the order AISLER's plugin writes them. */
export interface AislerComponent {
  pos_x: number;
  pos_y: number;
  rotation: number;
  side: 'top' | 'bottom';
  designator: string;
  mpn: string | null;
  pack: string;
  value: string;
  mount_type: 'smt' | 'tht';
  place: boolean;
}

/** The fields AISLER's plugin reads the manufacturer part number from, first one wins. */
export const MPN_KEYS = ['mpn', 'MPN', 'Mpn', 'AISLER_MPN'] as const;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPoint = (value: unknown) => !!value && typeof value === 'object' && isNumber((value as { x: unknown }).x) && isNumber((value as { y: unknown }).y);

/** The export is PCBJam's, but check its shape before building a file from it. */
export function parseFabDoc(value: unknown): FabComponentsDoc {
  const doc = value as FabComponentsDoc;
  const board = doc?.board;
  if (!board || !isNumber(board.widthMm) || !isNumber(board.heightMm) || !isNumber(board.copperLayers) || !Array.isArray(doc.footprints))
    throw new Error('The component export has an unexpected format.');
  for (const fp of doc.footprints) {
    if (!fp || typeof fp.ref !== 'string' || typeof fp.fpid !== 'string' || (fp.side !== 'top' && fp.side !== 'bottom') || !isPoint(fp.posMm) || !isNumber(fp.rotationDeg)
      || typeof fp.fields !== 'object' || fp.fields === null)
      throw new Error('The component export has an unexpected format.');
  }
  return doc;
}

/**
 * The component list. As in AISLER's plugin: footprints excluded from the BOM
 * (logos, mounting holes) are left out; positions are absolute, in mm, with y
 * pointing up; anything that is not SMD counts as through-hole; a DNP part
 * stays in the list with `place: false`.
 */
export function aislerComponents(doc: FabComponentsDoc): AislerComponent[] {
  const components: AislerComponent[] = [];
  for (const fp of doc.footprints) {
    if (fp.excludeFromBom) continue;
    const mpnKey = MPN_KEYS.find(key => Object.hasOwn(fp.fields, key));
    components.push({
      pos_x: fp.posMm.x,
      pos_y: fp.posMm.y * -1.0,
      rotation: fp.rotationDeg,
      side: fp.side,
      designator: fp.ref,
      mpn: mpnKey === undefined ? null : fp.fields[mpnKey]!,
      // The footprint's name without its library.
      pack: fp.fpid.slice(fp.fpid.lastIndexOf(':') + 1),
      value: fp.fields.Value ?? '',
      mount_type: fp.smd ? 'smt' : 'tht',
      place: !fp.dnp,
    });
  }
  return components;
}

/**
 * A number the way Python prints a float: the shortest text that reads back as
 * the same number, always with a decimal point or an exponent (`118.0`,
 * `-0.0`, `1e-05`). AISLER's plugin computes these values as Python floats.
 */
export function pythonFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error('The component export has a number that cannot be written.');
  if (Object.is(value, -0)) return '-0.0';
  const size = Math.abs(value);
  if (size !== 0 && (size < 1e-4 || size >= 1e16)) {
    const [mantissa, exponent] = value.toExponential().split('e') as [string, string];
    const power = Number(exponent);
    return `${mantissa}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
  }
  const text = String(value);
  return text.includes('.') ? text : text + '.0';
}

/** A string the way Python's `json.dump` writes it: JSON, with everything outside ASCII as `\uXXXX`. */
export function pythonString(value: string): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** `components.json` as text, like `json.dump(components, file)`: one line, `, ` and `: ` as separators. */
export function buildComponentsJson(doc: FabComponentsDoc): string {
  const entry = (c: AislerComponent) => '{' + [
    `"pos_x": ${pythonFloat(c.pos_x)}`,
    `"pos_y": ${pythonFloat(c.pos_y)}`,
    `"rotation": ${pythonFloat(c.rotation)}`,
    `"side": ${pythonString(c.side)}`,
    `"designator": ${pythonString(c.designator)}`,
    `"mpn": ${c.mpn === null ? 'null' : pythonString(c.mpn)}`,
    `"pack": ${pythonString(c.pack)}`,
    `"value": ${pythonString(c.value)}`,
    `"mount_type": ${pythonString(c.mount_type)}`,
    `"place": ${c.place ? 'true' : 'false'}`,
  ].join(', ') + '}';
  return '[' + aislerComponents(doc).map(entry).join(', ') + ']';
}
