// CrimpNet-serveri
//
//  - /device  WebSocket ESP32:lle (vaatii tokenin)
//  - /ui      WebSocket selaimelle (live-data + komennot laitteelle)
//  - /api/pulls        tallennetut vedot (ilman näytteitä)
//  - /api/pulls/:id    yksi veto näytteineen
//  - /                 käyttöliittymä (public/index.html)
//
// Käynnistys:  DEVICE_TOKEN=salainen node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const { PullDetector } = require("./pulls");

const PORT = Number(process.env.PORT || 8080);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "vaihda-tama-pitkaksi-satunnaiseksi";
const DATA_DIR = path.join(__dirname, "data");
const PULLS_FILE = path.join(DATA_DIR, "pulls.jsonl");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!process.env.DEVICE_TOKEN) {
  console.warn("⚠  DEVICE_TOKEN ei asetettu, käytetään oletusta. Aseta oma ennen demoa.");
}

// --- Tallennus (JSON Lines: yksi veto per rivi) -----------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadPulls() {
  if (!fs.existsSync(PULLS_FILE)) return [];
  return fs.readFileSync(PULLS_FILE, "utf8")
    .split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

const pulls = loadPulls();
let nextId = pulls.reduce((m, p) => Math.max(m, p.id), 0) + 1;

function savePull(pull) {
  pulls.push(pull);
  fs.appendFileSync(PULLS_FILE, JSON.stringify(pull) + "\n");
}

function summary(p) {
  const { samples, ...rest } = p;
  return rest;
}

// --- HTTP: staattiset tiedostot + REST-API ---------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/pulls" && req.method === "GET") {
    return sendJson(res, 200, pulls.map(summary).reverse());
  }
  const m = url.pathname.match(/^\/api\/pulls\/(\d+)$/);
  if (m && req.method === "GET") {
    const p = pulls.find((x) => x.id === Number(m[1]));
    return p ? sendJson(res, 200, p) : sendJson(res, 404, { error: "not found" });
  }

  // Staattiset tiedostot
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

// --- WebSocketit -------------------------------------------------------------

const deviceWss = new WebSocketServer({ noServer: true });
const uiWss = new WebSocketServer({ noServer: true });

let device = null;          // aktiivinen ESP32-yhteys
let deviceStatus = null;    // viimeisin status-viesti laitteelta

function broadcastUi(msg) {
  const data = JSON.stringify(msg);
  for (const c of uiWss.clients) if (c.readyState === 1) c.send(data);
}

const detector = new PullDetector((stats) => {
  const pull = { id: nextId++, at: new Date().toISOString(), ...stats };
  savePull(pull);
  console.log(`Veto #${pull.id}: huippu ${pull.peakKg} kg, kesto ${(pull.durationMs / 1000).toFixed(1)} s`);
  broadcastUi({ type: "pull", pull: summary(pull) });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/device") {
    if (url.searchParams.get("token") !== DEVICE_TOKEN) {
      console.warn("Laite yritti yhdistää väärällä tokenilla");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    deviceWss.handleUpgrade(req, socket, head, (ws) => deviceWss.emit("connection", ws, req));
  } else if (url.pathname === "/ui") {
    uiWss.handleUpgrade(req, socket, head, (ws) => uiWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

deviceWss.on("connection", (ws, req) => {
  if (device) device.terminate();   // vain yksi laite kerrallaan
  device = ws;
  console.log(`Laite yhdistetty (${req.socket.remoteAddress})`);
  broadcastUi({ type: "device", connected: true });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "samples" && Array.isArray(msg.s)) {
      for (const [t, kg] of msg.s) detector.push(t, kg);
      broadcastUi(msg);
    } else if (msg.type === "status") {
      deviceStatus = msg;
      broadcastUi(msg);
    }
  });

  ws.on("close", () => {
    if (device === ws) {
      device = null;
      console.log("Laite irtosi");
      broadcastUi({ type: "device", connected: false });
    }
  });
});

uiWss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "device", connected: !!device }));
  if (deviceStatus) ws.send(JSON.stringify(deviceStatus));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const allowed = ["tare", "calibrate", "status"];
    if (msg.cmd && allowed.includes(msg.cmd)) {
      if (!device) return ws.send(JSON.stringify({ type: "error", msg: "Laite ei ole yhteydessä" }));
      device.send(JSON.stringify({ cmd: msg.cmd, kg: Number(msg.kg) || undefined }));
    }
  });
});

// --- Käynnistys --------------------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CrimpNet-serveri portissa ${PORT}`);
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  for (const ip of ips) {
    console.log(`  Käyttöliittymä: http://${ip}:${PORT}`);
    console.log(`  ESP32:n SERVER_HOST: "${ip}"`);
  }
});
