// A stand-in for the part of AISLER this plugin talks to, for tests and manual
// runs: every push to the real AISLER makes a real project. It behaves as
// AISLER answered when probed on 2026-11-20, and on staging on 2026-11-24:
//
//   GET  /p/new.json             201 {project_url, project_id, import_url, upload_url, started}
//                                upload_url = <origin>/api/import?p=<token>&s=<signature>
//   POST /api/import?p=..&s=..   multipart: upload[file] (the ZIP), upload[title]
//                                201 {callback, redirect}; a signed address works once
//   GET  /api/import/<job>       200 {progress, message}: 0..99 working, 100 ready, -1 failed
//   GET  /p/<ID>                 the project page (here: a list of what arrived)
//
// The token is base64 with its padding left on, so about one in three ends in
// "=", written %3D in the address (here: every second one). A request without
// a User-Agent gets an empty 400 from AISLER's CDN.
//
// The import "reads" the ZIP like AISLER does as far as this plugin can get it
// wrong: no board outline Gerber is a failed import.
import { createServer } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { unzipSync } from "fflate";

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * @param {{ port?: number, host?: string, publicOrigin?: string, processingPolls?: number }} options
 *   publicOrigin: the https origin the answers name (a tunnel or a test name).
 *   processingPolls: how many times the import says "working" before it is done.
 */
export async function startAislerMock({ port = 3059, host = "127.0.0.1", publicOrigin, processingPolls = 2 } = {}) {
  const secret = randomBytes(32);
  const sign = (token) => createHmac("sha256", secret).update(token).digest("hex");
  /** project id -> { id, token, upload?: {...} } */
  const projects = new Map();
  let issued = 0;
  /** job id -> { project, polls, failure? } */
  const jobs = new Map();
  const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));

  const server = createServer(async (req, res) => {
    if (!req.headers["user-agent"]) { res.writeHead(400, { "content-type": "application/json" }).end(); return; }
    const origin = publicOrigin ?? `http://${host}:${server.address().port}`;
    const url = new URL(req.url, "http://mock");
    try {
      if (req.method === "GET" && url.pathname === "/p/new.json") {
        const id = Array.from(randomBytes(8), (b) => LETTERS[b % 26]).join("");
        // 164 characters like AISLER's: [A-Za-z0-9_-], and for every second project one "=" of padding at the end.
        const token = randomBytes(issued++ % 2 ? 122 : 123).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
        projects.set(id, { id, token });
        return json(res, 201, {
          project_url: `${origin}/p/${id}`,
          project_id: id,
          import_url: `${origin}/p/${id}/import`,
          upload_url: `${origin}/api/import?p=${token.replaceAll("=", "%3D")}&s=${sign(token)}`,
          started: false,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/import") {
        const token = url.searchParams.get("p") ?? "", signature = url.searchParams.get("s") ?? "";
        const expected = sign(token);
        const project = [...projects.values()].find((p) => p.token === token);
        if (!project || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
          return json(res, 403, { error: "Forbidden" });
        // A signed address takes one upload; AISLER refuses a second push to an unclaimed project.
        if (project.upload) return json(res, 403, { error: "Forbidden" });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) throw Object.assign(new Error("Upload too large"), { status: 413 });
          chunks.push(chunk);
        }
        const form = await new Request("http://mock/upload", { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: Buffer.concat(chunks) }).formData();
        const file = form.get("upload[file]");
        if (!file || typeof file === "string") throw Object.assign(new Error("Missing upload[file]"), { status: 400 });
        const title = form.get("upload[title]");
        if (typeof title !== "string" || !title) throw Object.assign(new Error("Missing upload[title]"), { status: 400 });
        const bytes = new Uint8Array(await file.arrayBuffer());
        let files;
        try {
          files = Object.entries(unzipSync(bytes)).map(([name, data]) => ({ name, size: data.length }));
        } catch {
          throw Object.assign(new Error("upload[file] is not a ZIP"), { status: 400 });
        }
        project.upload = { filename: file.name, title, size: bytes.length, files, at: new Date().toISOString() };
        const job = randomBytes(12).toString("hex");
        const failure = files.some((f) => /-Edge_Cuts\.gbr$/.test(f.name)) ? undefined : "Board outline is missing";
        jobs.set(job, { project: project.id, polls: 0, failure });
        return json(res, 201, { callback: `${origin}/api/import/${job}`, redirect: `${origin}/p/${project.id}` });
      }
      const status = /^\/api\/import\/([0-9a-f]{24})$/.exec(url.pathname);
      if (req.method === "GET" && status) {
        const job = jobs.get(status[1]);
        if (!job) return json(res, 404, { error: "Not found" });
        job.polls++;
        if (job.polls <= processingPolls)
          return json(res, 200, { progress: Math.min(90, Math.round((job.polls / (processingPolls + 1)) * 100)), message: "Processing your design" });
        return json(res, 200, job.failure ? { progress: -1, message: job.failure } : { progress: 100, message: "Your production data is ready" });
      }
      const page = /^\/p\/([A-Z]{8})$/.exec(url.pathname);
      if (req.method === "GET" && page) {
        const project = projects.get(page[1]);
        if (!project?.upload) { res.writeHead(404, { "content-type": "text/plain" }).end("No such project"); return; }
        const { upload } = project;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>Mock AISLER project</title><body style="font:15px system-ui;max-width:760px;margin:40px auto">
<h1>Mock AISLER project ${project.id}</h1><p data-testid="mock-project">Received <strong>${escape(upload.filename)}</strong> (${upload.size} bytes)
titled <strong>${escape(upload.title)}</strong>, ${upload.files.length} files.</p>
<ul>${upload.files.map((f) => `<li>${escape(f.name)} <small>${f.size} bytes</small></li>`).join("")}</ul>
<p><small>This is a stand-in for AISLER's project page; nothing was ordered.</small></p></body>`);
        return;
      }
      if (req.method === "GET" && url.pathname === "/mock/projects") return json(res, 200, [...projects.values()].map(({ id, upload }) => ({ id, upload })));
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    } catch (error) {
      json(res, error.status ?? 500, { error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    origin: `http://${host}:${server.address().port}`,
    projects,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
