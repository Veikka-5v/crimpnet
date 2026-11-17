// Simuloitu ESP32: lähettää samanlaista vetodataa kuin firmware
// USE_FAKE_DATA-tilassa. Tällä voi testata serverin ja käyttöliittymän
// ilman laitteistoa.
//
// Käyttö:  DEVICE_TOKEN=salainen node tools/fake-device.js [ws://localhost:8080]

const WebSocket = require("ws");

const base = process.argv[2] || "ws://localhost:8080";
const token = process.env.DEVICE_TOKEN || "vaihda-tama-pitkaksi-satunnaiseksi";
const HZ = 80;
const PER_PACKET = 8;

let offsetKg = 0;
let cpk = 21000;

function fakeForceKg(ms) {
  const p = ms % 11000;
  const noise = (Math.random() - 0.5) * 0.2;
  if (p < 4000) return noise;
  const t = (p - 4000) / 1000;
  const peak = 32;
  let f;
  if (t < 0.4) f = peak * (t / 0.4);
  else if (t < 6.5) f = peak * (1 - 0.04 * (t - 0.4));
  else f = peak * 0.76 * (1 - (t - 6.5) / 0.5);
  return Math.max(0, f) + noise * 3;
}

function connect() {
  const ws = new WebSocket(`${base}/device?token=${encodeURIComponent(token)}`);
  const start = Date.now();
  let buf = [];
  let timer;

  ws.on("open", () => {
    console.log("Simuloitu laite yhdistetty");
    ws.send(JSON.stringify({ type: "status", msg: "hello", offset: 0, cpk, fake: true }));
    timer = setInterval(() => {
      const t = Date.now() - start;
      buf.push([t, Math.round((fakeForceKg(t) - offsetKg) * 100) / 100]);
      if (buf.length >= PER_PACKET) {
        ws.send(JSON.stringify({ type: "samples", s: buf }));
        buf = [];
      }
    }, 1000 / HZ);
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    console.log("Komento serveriltä:", msg);
    if (msg.cmd === "tare") {
      offsetKg = fakeForceKg(Date.now() - start);
      ws.send(JSON.stringify({ type: "status", msg: "tared", offset: offsetKg, cpk, fake: true }));
    } else if (msg.cmd === "calibrate") {
      ws.send(JSON.stringify({ type: "status", msg: "calibrated", offset: offsetKg, cpk, fake: true }));
    } else if (msg.cmd === "status") {
      ws.send(JSON.stringify({ type: "status", msg: "ok", offset: offsetKg, cpk, fake: true }));
    }
  });

  ws.on("close", () => {
    clearInterval(timer);
    console.log("Yhteys katkesi, yritetään uudelleen 2 s päästä");
    setTimeout(connect, 2000);
  });
  ws.on("error", (e) => console.error("Virhe:", e.message));
}

connect();
