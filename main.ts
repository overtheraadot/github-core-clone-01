// main.ts — the entrypoint. Trial lifecycle (the starter's contract):
// bind an ephemeral port, register it with the env, poll /done, exit 0.
// `--standalone` runs the server without an env (local grading): the port
// comes from $PORT (0 = ephemeral) and the process serves until killed.

import { createApp } from './app.ts';

const STANDALONE = process.argv.includes('--standalone');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text().catch(() => '') };
}

async function getJson(url: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url);
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function main(): Promise<number> {
  const { server } = createApp();
  const port = STANDALONE ? Number(process.env.PORT ?? 0) || 0 : 0;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`makefun-forge listening on http://127.0.0.1:${boundPort}`);

  if (STANDALONE) {
    // Local grading: just serve. The runner dials this origin directly.
    return new Promise<number>(() => {
      // Never resolves: serve until the process is killed.
    });
  }

  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  if (envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    server.close();
    return 1;
  }
  const base = envUrl.replace(/\/+$/, '');

  // Register with a short exponential backoff. A 409 means another entry
  // already registered; keep waiting either way.
  let delayMs = 100;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const { status } = await postJson(`${base}/register`, { port: boundPort });
      if (status === 200 || status === 409) break;
    } catch {
      // The env may not be up yet; retry.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2000);
  }

  // Poll /done until the suite's export is written, then exit 0.
  delayMs = 100;
  for (;;) {
    try {
      const { json } = await getJson(`${base}/done`);
      if (json !== null && typeof json === 'object' && (json as Record<string, unknown>).done === true) break;
    } catch {
      // Transient; keep polling.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2000);
  }
  server.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
