// Tiny DevTools-protocol client: node scripts/cdp.mjs "<js expression>"  (drives the running app for tests)
const port = process.env.CDP_PORT || 9222;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const expr = process.argv[2];
if (expr === '--shot') {
  ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  ws.onmessage = async (m) => {
    const d = JSON.parse(m.data);
    if (d.id === 2) {
      (await import('node:fs')).writeFileSync(process.argv[3], Buffer.from(d.result.data, 'base64'));
      process.exit(0);
    }
  };
} else {
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 1800000 } }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id === 1) {
    console.log(JSON.stringify(d.result?.result?.value ?? d.result, null, 1).slice(0, Number(process.env.MAXC || 4000)));
    process.exit(0);
  }
};
}
