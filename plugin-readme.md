# AISLER Export

Sends the board open in PCBJam's PCB editor to AISLER for a quote. It builds the ZIP AISLER's own KiCad plugin builds: Gerbers, drill files, an IPC-356 netlist and the component list. PCBJam generates the files on its servers from the saved project; the plugin never sees them. Push it to AISLER and open the project page AISLER returns, or download the ZIP and upload it on AISLER's site.

Every push makes a new AISLER project. Until you claim that project with an AISLER account, anyone who has its link can see the board.

Source: https://github.com/PCBJam/pcbjam-aisler-plugin (MIT; the export recipe and the component list rules are ported from AISLER's MIT-licensed KiCad plugin, see LICENSE.txt).

AISLER is a trademark of its owner. This plugin is not made, affiliated with or endorsed by AISLER.
