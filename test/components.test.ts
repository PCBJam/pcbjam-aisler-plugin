import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { aislerComponents, buildComponentsJson, parseFabDoc, pythonFloat, pythonString } from '../src/logic/components';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const doc = () => parseFabDoc(JSON.parse(fixture('fab-components.json')));

describe('components.json', () => {
  it('is the text AISLER\'s plugin writes for the same board', () => {
    // components.expected.json was written by Python's json.dump from the same
    // values, the way PushForKiCad's push_thread.py does it.
    expect(buildComponentsJson(doc())).toBe(fixture('components.expected.json'));
  });

  it('follows the plugin\'s rules for each part', () => {
    const parts = aislerComponents(doc());
    // Excluded from the BOM (a mounting hole) is left out; DNP stays, not placed.
    expect(parts.map(p => p.designator)).toEqual(['R1', 'C2', 'J1', 'U3', 'G1']);
    expect(parts.find(p => p.designator === 'U3')).toMatchObject({ place: false, mpn: 'ATMEGA328P-AU' });
    // The part number: mpn before MPN before Mpn before AISLER_MPN; none is null.
    expect(parts.map(p => p.mpn)).toEqual(['RC0805FR-0710KL', 'first', null, 'ATMEGA328P-AU', '⚡ 5V 😀']);
    // y points up; the footprint name comes without its library; not SMD counts as through-hole.
    expect(parts.find(p => p.designator === 'J1')).toMatchObject({ pos_x: 138, pos_y: -69.5, pack: 'PinHeader_1x08_P2.54mm_Vertical', mount_type: 'tht', side: 'top' });
    expect(parts.find(p => p.designator === 'G1')).toMatchObject({ pack: 'LOGO', value: '' });
  });

  it('writes numbers and strings like Python does', () => {
    const cases: [number, string][] = [
      [118, '118.0'], [-76.61, '-76.61'], [0, '0.0'], [-0, '-0.0'], [0.1 + 0.2, '0.30000000000000004'],
      [1e-5, '1e-05'], [0.0001, '0.0001'], [0.00009, '9e-05'], [1.5e-7, '1.5e-07'], [-2.5e-10, '-2.5e-10'],
      [1e15, '1000000000000000.0'], [1e16, '1e+16'], [1.25e22, '1.25e+22'], [123456.789, '123456.789'],
    ];
    for (const [value, text] of cases) expect(pythonFloat(value), String(value)).toBe(text);
    expect(() => pythonFloat(NaN)).toThrow();
    expect(() => pythonFloat(Infinity)).toThrow();
    expect(pythonString('a"b\\c\n\t')).toBe('"a\\"b\\\\c\\n\\t"');
    expect(pythonString('100µF')).toBe('"100\\u00b5F"');
    expect(pythonString('😀')).toBe('"\\ud83d\\ude00"');
    expect(pythonString('~\x7f')).toBe('"~\x7f"');
  });

  it('refuses a component export of another shape', () => {
    const good = JSON.parse(fixture('fab-components.json'));
    for (const bad of [
      null, {}, { board: good.board }, { ...good, footprints: [{ ...good.footprints[0], side: 'inner' }] },
      { ...good, footprints: [{ ...good.footprints[0], posMm: { x: 'a', y: 1 } }] },
      { ...good, footprints: [{ ...good.footprints[0], fields: null }] },
      { ...good, board: { ...good.board, widthMm: '55' } },
    ])
      expect(() => parseFabDoc(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow(/unexpected format/);
  });

  // Not in the repository: a real board's component export next to the components.json that
  // AISLER's plugin made for it in desktop KiCad. AISLER_REFERENCE_DIR=<dir> npm test
  const reference = process.env.AISLER_REFERENCE_DIR;
  it.skipIf(!reference || !existsSync(path.join(reference, 'fab-components.json')))('matches a real push byte for byte', () => {
    const real = parseFabDoc(JSON.parse(readFileSync(path.join(reference!, 'fab-components.json'), 'utf8')));
    expect(buildComponentsJson(real)).toBe(readFileSync(path.join(reference!, 'components.json'), 'utf8'));
  });
});
