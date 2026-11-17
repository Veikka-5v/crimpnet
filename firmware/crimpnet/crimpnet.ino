// ---------------------------------------------------------------------------
// CrimpNet – ESP32-firmware
//
// Lukee voimaa HX711:ltä (tai tuottaa simuloitua dataa), kerää näytteet
// pieniksi paketeiksi ja lähettää ne WebSocketilla serverille.
// Serveriltä voi tulla komentoja: tare (nollaus) ja calibrate (kalibrointi).
//
// Kirjastot (Arduino IDE: Tools > Manage Libraries):
//   - "WebSockets" by Markus Sattler
//   - "ArduinoJson" by Benoit Blanchon (v7)
//   - "HX711 Arduino Library" by Bogdan Necula
// Lisäksi ESP32-levytuki (Boards Manager: "esp32" by Espressif).
// ---------------------------------------------------------------------------

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <HX711.h>

#include "config.h"
#include "secrets.h"   // kopioi secrets.example.h -> secrets.h

WebSocketsClient ws;
Preferences prefs;
HX711 scale;

// Kalibrointi: kg = (raw - offset) / countsPerKg
long  calOffset   = 0;
float countsPerKg = DEFAULT_COUNTS_PER_KG;

// Näytepuskuri
struct Sample { uint32_t t; float kg; };
Sample buf[SAMPLES_PER_PACKET];
uint8_t bufLen = 0;

bool wsConnected = false;
long lastRaw = 0;

// --- Kalibroinnin tallennus pysyvään muistiin ------------------------------

void loadCalibration() {
  prefs.begin("crimpnet", true);
  calOffset   = prefs.getLong("offset", 0);
  countsPerKg = prefs.getFloat("cpk", DEFAULT_COUNTS_PER_KG);
  prefs.end();
  Serial.printf("Kalibrointi: offset=%ld, counts/kg=%.2f\n", calOffset, countsPerKg);
}

void saveCalibration() {
  prefs.begin("crimpnet", false);
  prefs.putLong("offset", calOffset);
  prefs.putFloat("cpk", countsPerKg);
  prefs.end();
}

// --- Raakalukeman keskiarvo (komentoja varten) ------------------------------

long averageRaw(int n) {
#if USE_FAKE_DATA
  (void)n;
  return lastRaw;
#else
  long long sum = 0;
  for (int i = 0; i < n; i++) {
    while (!scale.is_ready()) { ws.loop(); delay(1); }
    sum += scale.read();
  }
  return (long)(sum / n);
#endif
}

void sendStatus(const char* msg) {
  JsonDocument doc;
  doc["type"]   = "status";
  doc["msg"]    = msg;
  doc["offset"] = calOffset;
  doc["cpk"]    = countsPerKg;
  doc["fake"]   = (bool)USE_FAKE_DATA;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

// --- Serveriltä tulevat komennot -------------------------------------------

void handleCommand(const char* payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;

  const char* cmd = doc["cmd"] | "";

  if (strcmp(cmd, "tare") == 0) {
    calOffset = averageRaw(20);
    saveCalibration();
    Serial.printf("Nollattu, offset=%ld\n", calOffset);
    sendStatus("tared");

  } else if (strcmp(cmd, "calibrate") == 0) {
    float kg = doc["kg"] | 0.0f;
    if (kg <= 0) { sendStatus("calibrate: anna paino > 0 kg"); return; }
    long raw = averageRaw(40);
    float cpk = (raw - calOffset) / kg;
    if (fabsf(cpk) < 1.0f) { sendStatus("calibrate: liian pieni muutos, onko paino kiinni?"); return; }
    countsPerKg = cpk;
    saveCalibration();
    Serial.printf("Kalibroitu, counts/kg=%.2f\n", countsPerKg);
    sendStatus("calibrated");

  } else if (strcmp(cmd, "status") == 0) {
    sendStatus("ok");
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("WebSocket yhdistetty");
      sendStatus("hello");
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("WebSocket katkesi, yritetään uudelleen...");
      break;
    case WStype_TEXT:
      handleCommand((const char*)payload, length);
      break;
    default:
      break;
  }
}

// --- Näytteiden tuottaminen -------------------------------------------------

#if USE_FAKE_DATA
// Simuloi toistuvia vetoja: 4 s lepo, 7 s veto (nousu, tasanne, väsyminen).
float fakeForceKg(uint32_t ms) {
  const uint32_t cycle = 11000;
  uint32_t p = ms % cycle;
  float noise = ((float)random(-100, 101)) / 1000.0f;  // ±0.1 kg
  if (p < 4000) return noise;
  float t = (p - 4000) / 1000.0f;                       // 0..7 s
  float peak = 32.0f;
  float f;
  if (t < 0.4f)      f = peak * (t / 0.4f);             // nopea nousu
  else if (t < 6.5f) f = peak * (1.0f - 0.04f * (t - 0.4f)); // hidas väsyminen
  else               f = peak * 0.76f * (1.0f - (t - 6.5f) / 0.5f); // irrotus
  if (f < 0) f = 0;
  return f + noise * 3;
}
#endif

bool readSample(Sample& s) {
#if USE_FAKE_DATA
  static uint32_t next = 0;
  uint32_t now = millis();
  if ((int32_t)(now - next) < 0) return false;
  next = now + 1000 / FAKE_SAMPLE_HZ;
  s.t  = now;
  s.kg = fakeForceKg(now);
  lastRaw = (long)(s.kg * countsPerKg) + calOffset;
  return true;
#else
  if (!scale.is_ready()) return false;
  long raw = scale.read();
  lastRaw = raw;
  s.t  = millis();
  s.kg = (raw - calOffset) / countsPerKg;
  return true;
#endif
}

void flushPacket() {
  if (bufLen == 0) return;
  if (wsConnected) {
    // {"type":"samples","s":[[t,kg],[t,kg],...]}
    JsonDocument doc;
    doc["type"] = "samples";
    JsonArray arr = doc["s"].to<JsonArray>();
    for (uint8_t i = 0; i < bufLen; i++) {
      JsonArray p = arr.add<JsonArray>();
      p.add(buf[i].t);
      p.add(roundf(buf[i].kg * 100) / 100.0f);
    }
    String out;
    serializeJson(doc, out);
    ws.sendTXT(out);
  }
  bufLen = 0;  // Ilman yhteyttä näytteet hylätään (ei kasvateta muistia)
}

// --- Setup & loop -----------------------------------------------------------

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("Yhdistetään WiFiin \"%s\"", WIFI_SSID);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - start > 20000) {
      Serial.println("\nEi yhteyttä. Onko hotspot 2,4 GHz ja WPA2? Yritetään uudelleen.");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      start = millis();
    }
  }
  Serial.print("\nWiFi OK, IP: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== CrimpNet ===");
  Serial.println(USE_FAKE_DATA ? "Tila: SIMULOITU DATA" : "Tila: HX711");

  loadCalibration();

#if !USE_FAKE_DATA
  scale.begin(HX711_DT_PIN, HX711_SCK_PIN);
#endif

  connectWifi();

  String path = String("/device?token=") + DEVICE_TOKEN;
  ws.begin(SERVER_HOST, SERVER_PORT, path.c_str());
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  ws.loop();

  if (WiFi.status() != WL_CONNECTED) {
    wsConnected = false;
    connectWifi();
    return;
  }

  static uint32_t lastPrint = 0;
  static uint32_t samplesThisSecond = 0;

  Sample s;
  if (readSample(s)) {
    samplesThisSecond++;
    buf[bufLen++] = s;
    if (bufLen >= SAMPLES_PER_PACKET) flushPacket();
  }

  // Tulosta näytetaajuus ja lukema kerran sekunnissa.
  // Hyödyllinen RATE-modin testaukseen: ~10 Hz ennen, ~80 Hz jälkeen.
  if (millis() - lastPrint >= 1000) {
    lastPrint = millis();
    Serial.printf("%lu Hz | raw=%ld | %.2f kg | ws=%s\n",
                  (unsigned long)samplesThisSecond, lastRaw,
                  (lastRaw - calOffset) / countsPerKg,
                  wsConnected ? "OK" : "ei yhteyttä");
    samplesThisSecond = 0;
  }
}
