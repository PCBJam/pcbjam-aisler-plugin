import { useRef, useState } from 'react';
import type { BoardSummary, BundleSummary, ImportStatus } from '../contracts';
import { callPlugin } from './pcbjam';

type StepId = 'inspect' | 'pack';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'inspect', label: 'Generating Gerbers, drill files and netlist' },
  { id: 'pack', label: 'Building the component list and ZIP' },
];

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; active: StepId }
  | { kind: 'done'; board: BoardSummary; bundle: BundleSummary }
  | { kind: 'failed'; active: StepId; message: string };

/** `watching`: AISLER is reading the upload. `late`: still reading when the panel stopped asking. */
type Push =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'watching'; projectId: string; status?: ImportStatus }
  | { kind: 'ready'; projectId: string; message: string }
  | { kind: 'late'; projectId: string }
  | { kind: 'rejected'; projectId: string; message: string };

const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [saved, setSaved] = useState('');
  const [push, setPush] = useState<Push>({ kind: 'idle' });
  const [pushError, setPushError] = useState('');
  // A new Generate or Push ends the watch of the one before.
  const run = useRef(0);

  async function generate() {
    run.current++;
    setSaved('');
    setPush({ kind: 'idle' });
    setPushError('');
    let active: StepId = 'inspect';
    try {
      setPhase({ kind: 'running', active });
      const board = await callPlugin('inspect', {});
      setPhase({ kind: 'running', active: active = 'pack' });
      const bundle = await callPlugin('pack', {});
      setPhase({ kind: 'done', board, bundle });
    } catch (error) {
      setPhase({ kind: 'failed', active, message: message(error) });
    }
  }

  async function download() {
    try {
      const result = await callPlugin('download', {});
      setSaved(result.status === 'download-requested' ? 'Download started.' : 'Download cancelled.');
    } catch (error) {
      setSaved(message(error));
    }
  }

  async function pushToAisler() {
    const mine = ++run.current;
    setPushError('');
    setPush({ kind: 'uploading' });
    let projectId = '';
    try {
      ({ projectId } = await callPlugin('push', {}));
      setPush({ kind: 'watching', projectId });
      // Each look waits its turn in the plugin's logic, so this loop does not spin.
      for (;;) {
        const status = await callPlugin('progress', {});
        if (run.current !== mine) return;
        if (status.state === 'ready') return setPush({ kind: 'ready', projectId, message: status.message });
        if (status.state === 'failed') return setPush({ kind: 'rejected', projectId, message: status.message });
        if (status.state === 'timeout') return setPush({ kind: 'late', projectId });
        setPush({ kind: 'watching', projectId, status });
      }
    } catch (error) {
      if (run.current !== mine) return;
      // Uploaded, but the import could not be followed: the project page still shows it.
      setPush(projectId ? { kind: 'late', projectId } : { kind: 'idle' });
      setPushError(message(error));
    }
  }

  async function open() {
    try {
      const result = await callPlugin('open', {});
      if (result.status === 'cancelled') setPushError('Opening AISLER was cancelled. You can open the project again.');
      else setPushError('');
    } catch (error) {
      setPushError(message(error));
    }
  }

  const running = phase.kind === 'running';
  return (
    <main>
      <h1>AISLER</h1>
      <p>
        Send this board to AISLER for a quote. PCBJam builds the files on its servers from the saved project, the way
        AISLER's own KiCad plugin does: Gerbers, drill files, an IPC-356 netlist and the component list, in one ZIP.
      </p>
      {phase.kind === 'idle' && <button onClick={generate}>Generate AISLER ZIP</button>}
      {(phase.kind === 'running' || phase.kind === 'failed') && (
        <ol className="steps" aria-label="Progress">
          {STEPS.map((step, index) => {
            const first = STEPS.findIndex(s => s.id === phase.active);
            const state = step.id === phase.active ? (running ? 'active' : 'failed') : index < first ? 'done' : 'waiting';
            return <li key={step.id} data-state={state}>{state === 'done' ? '✓ ' : state === 'failed' ? '✕ ' : state === 'active' ? '… ' : ''}{step.label}</li>;
          })}
        </ol>
      )}
      {phase.kind === 'failed' && (
        <>
          <p role="alert" className="error">{phase.message}</p>
          <button onClick={generate}>Start over</button>
        </>
      )}
      {phase.kind === 'done' && (
        <section aria-label="AISLER ZIP">
          <p className="summary">
            <strong>{phase.bundle.name}</strong> · {size(phase.bundle.size)}<br />
            Board {phase.board.widthMm.toFixed(1)} × {phase.board.heightMm.toFixed(1)} mm, {plural(phase.board.copperLayers, 'copper layer')},
            {' '}{plural(phase.board.layers.length, 'Gerber file')}<br />
            {plural(phase.board.parts, 'part')} ({phase.board.smt} SMT, {phase.board.tht} through-hole),
            {' '}{phase.board.withMpn} with a part number{phase.board.notPlaced ? `, ${phase.board.notPlaced} not placed` : ''}
          </p>

          {push.kind === 'idle' && (
            <>
              <button onClick={pushToAisler}>Push to AISLER</button>
              <p className="hint">
                Uploads the ZIP to a new AISLER project. Until you claim that project with an AISLER account, anyone
                who has its link can see the board.
              </p>
            </>
          )}
          {push.kind === 'uploading' && <button disabled>Uploading to AISLER…</button>}
          {push.kind === 'watching' && (
            <p className="status" role="status">
              Uploaded as AISLER project {push.projectId}. AISLER is reading the files
              {push.status ? ` (${push.status.progress}%)` : ''}…
              {push.status?.message ? <><br />{push.status.message}</> : null}
            </p>
          )}
          {push.kind === 'ready' && (
            <p className="status" role="status">
              AISLER project {push.projectId} is ready{push.message ? `: ${push.message}` : '.'} Review the quote and order on AISLER's site.
            </p>
          )}
          {push.kind === 'late' && (
            <p className="status" role="status">
              Uploaded as AISLER project {push.projectId}. AISLER is still reading the files; its project page shows the result.
            </p>
          )}
          {push.kind === 'rejected' && (
            <p role="alert" className="error">
              AISLER could not read the upload{push.message ? `: ${push.message}` : '.'}
            </p>
          )}
          {(push.kind === 'ready' || push.kind === 'late') && <button onClick={open}>Open in AISLER</button>}
          {(push.kind === 'ready' || push.kind === 'late' || push.kind === 'rejected') && (
            <>
              <p className="hint">
                Until you claim the project with an AISLER account, anyone who has its link can see the board.
                Pushing again makes another AISLER project.
              </p>
              <button className="secondary" onClick={pushToAisler}>Push again</button>
            </>
          )}
          {pushError && <p role="alert" className="error">{pushError}</p>}

          <button className="secondary" onClick={download}>Download ZIP</button>
          {saved && <p className="status">{saved}</p>}
          <details>
            <summary>{phase.bundle.files.length} files</summary>
            <ul className="files">{phase.bundle.files.map(file => <li key={file.name}>{file.name} <span>{size(file.size)}</span></li>)}</ul>
          </details>
          <p className="note">
            Push uploads the ZIP to AISLER, the way AISLER's KiCad plugin does, and offers its project page in a new
            tab. Nothing is ordered from here. Or download the ZIP and upload it on AISLER's site yourself.
          </p>
          <button className="secondary" onClick={generate}>Generate again</button>
        </section>
      )}
    </main>
  );
}
