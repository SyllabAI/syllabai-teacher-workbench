#!/usr/bin/env node
/**
 * R3-8 Phase E — minimal access-log forwarder (deployment infrastructure).
 *
 * Listens on 127.0.0.1:3000 (the platform Caddy upstream) and forwards every
 * request verbatim to the Next.js standalone server on 127.0.0.1:3001,
 * appending one JSONL line per response to the access log:
 *   { ts, method, path, status, ms }
 *
 * WHY: Next.js standalone has no access logging; Phase E requires detection
 * of 4xx/5xx spikes and repeated authentication failures (403 on /api/*).
 * This adds NO application behavior, no validation semantics, no headers —
 * it is byte-transparent plumbing. Bind 127.0.0.1 only: all external traffic
 * must traverse the TLS edge -> Caddy:81 -> here.
 *
 * Config: PORT_UP (listen, default 3000), PORT_APP (default 3001),
 * ACCESS_LOG (default /home/z/workbench-prod/logs/access.jsonl).
 */
import http from "http";
import fs from "fs";
import path from "path";

const UP = Number(process.env.PORT_UP || 3000);
const APP = Number(process.env.PORT_APP || 3001);
const APP_HOST = process.env.APP_HOST || "127.0.0.1";
const LOG_FILE = process.env.ACCESS_LOG || "/home/z/workbench-prod/logs/access.jsonl";

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const stream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(line) {
  stream.write(JSON.stringify(line) + "\n");
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const upstream = http.request(
    {
      host: APP_HOST,
      port: APP,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: req.headers.host },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
      log({
        ts: new Date().toISOString(),
        method: req.method,
        path: (req.url || "").slice(0, 300),
        status: up.statusCode,
        ms: Date.now() - started,
      });
    }
  );
  upstream.on("error", (e) => {
    log({ ts: new Date().toISOString(), method: req.method, path: (req.url || "").slice(0, 300), status: 502, error: String(e && e.code || e).slice(0, 80) });
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream unavailable");
  });
  req.pipe(upstream);
});

server.listen(UP, "127.0.0.1", () => {
  console.log(`access-log-proxy: 127.0.0.1:${UP} -> ${APP_HOST}:${APP}, log ${LOG_FILE}`);
});
