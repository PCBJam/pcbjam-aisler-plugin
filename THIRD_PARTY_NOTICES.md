# Third-party notices

| Project | Where in this plugin | License |
|---|---|---|
| [AISLER Push for KiCad](https://github.com/AislerHQ/PushForKiCad) 0.3.2, by AISLER B.V. | `src/logic/workflow.ts`: the layer list, the Gerber and drill settings and the three requests (new project, upload, import status) follow it; `src/logic/components.ts`: the fields, skip rule and key order of `components.json` are ported from it | MIT, below |
| React, React DOM and Scheduler 18.3.1 | bundled into the panel (`ui.html`) | MIT; the build appends their license files to the package's `LICENSE.txt` |

AISLER is a trademark of its owner. This plugin is not made, affiliated with
or endorsed by AISLER; it prepares files for, and uploads them to, the
endpoints AISLER's own KiCad plugin uses.

## AISLER Push for KiCad

MIT License

Copyright (c) 2022 AISLER B.V., https://aisler.net

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
