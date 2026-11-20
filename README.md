# AISLER for PCBJam

A [PCBJam](https://pcbjam.com) plugin for the PCB editor that sends the open
board to [AISLER](https://aisler.net) for a quote. It builds the ZIP that
[AISLER's KiCad plugin](https://github.com/AislerHQ/PushForKiCad) builds:

- Gerbers of AISLER's layer list (copper, silkscreen, mask, paste, outline),
  one `<board>-<layer>.gbr` per layer the board has, in X2 format with 4.6
  coordinates
- drill files, plated and non-plated holes apart (`<board>-PTH.drl`,
  `<board>-NPTH.drl`)
- an IPC-356 netlist (`netlist.ipc`)
- the component list (`components.json`), the same text AISLER's plugin
  writes for the same board

KiCad's own exporters make the Gerber, drill and netlist files on PCBJam's
servers from the saved project.

**Push to AISLER** asks AISLER for a new project, uploads the ZIP to the
address AISLER issues for it, follows the import and offers AISLER's project
page in a new browser tab (after you confirm). Nothing is ordered from the
plugin. Or download the ZIP and upload it on AISLER's site yourself.

Two things to know before pushing:

- Every push makes a new AISLER project.
- Until you claim that project with an AISLER account, anyone who has its
  link can see the board.

The plugin uses only PCBJam's public plugin API (`pcbjam.exports.*`,
`pcbjam.files.saveBundle`, `pcbjam.http.request`, `pcbjam.http.upload`,
`pcbjam.ui.openExternal`); the file bytes never enter the plugin sandbox.
PCBJam sends the requests from its servers, only to the three AISLER paths
in `manifest.json`.

Not in this version: AISLER's ODB++ file (`odb.zip`), and pushing a new
revision to an AISLER project made earlier.

## Testing without AISLER

Every push to the real AISLER makes a real project, so `mock/` is a stand-in
for the three endpoints. It issues a signed upload address, checks what the
plugin sends, reports the import and serves a project page listing what
arrived:

```sh
npm run mock                                       # http://127.0.0.1:3059
cloudflared tunnel --url http://127.0.0.1:3059     # an https name for it
PUBLIC_ORIGIN=https://<name>.trycloudflare.com npm run mock
AISLER_ORIGIN=https://<name>.trycloudflare.com npm run build   # dist/aisler-mock.zip, "AISLER Export (mock)"
```

Publish the mock build on a PCBJam test stack and approve its endpoint; the
real build (`npm run build`) always targets `https://aisler.net`.

## Building from source

```sh
npm ci
npm test           # components.json rules, the workflow against a fake host, the mock
npm run build      # dist/plugin/ and dist/aisler.zip
```

Plugin logic is in `src/main.ts` and `src/logic/` (runs in PCBJam's QuickJS
sandbox), the panel in `src/ui/` (React).

`test/fixtures/components.expected.json` is what Python's `json.dump` writes
for `test/fixtures/fab-components.json`, the way AISLER's plugin does it. To
check a real board as well, put PCBJam's `fab-components.json` for it next to
the `components.json` AISLER's plugin made in desktop KiCad and run
`AISLER_REFERENCE_DIR=<that folder> npm test`.

Questions: the [PCBJam Discord](https://discord.gg/ybhqJxjR3E).

## License

MIT, see [LICENSE](LICENSE). The export recipe and the `components.json`
rules are ported from AISLER's MIT-licensed KiCad plugin (© AISLER B.V.); its
notice, and those of the bundled React packages, are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and in the plugin package's
`LICENSE.txt`.

AISLER is a trademark of its owner. This plugin is not made, affiliated with or
endorsed by AISLER.
