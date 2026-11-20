// npm run mock -- serves the mock AISLER on :3059. For a manual run in PCBJam,
// expose it over https (e.g. `cloudflared tunnel --url http://127.0.0.1:3059`)
// and pass that origin: PUBLIC_ORIGIN=https://<name>.trycloudflare.com npm run mock
import { startAislerMock } from "./aisler-mock.mjs";
const mock = await startAislerMock({ port: Number(process.env.PORT ?? 3059), publicOrigin: process.env.PUBLIC_ORIGIN });
console.log(`Mock AISLER on ${mock.origin}${process.env.PUBLIC_ORIGIN ? " (public " + process.env.PUBLIC_ORIGIN + ")" : ""}`);
