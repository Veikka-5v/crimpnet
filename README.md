# CrimpNet

Verkotettu voimamittari kiipeilijän sormivoimatreeniin (Tindeq/Crimpdeq-tyyppinen).

```
[voimakenno] → [HX711] → [ESP32] --WiFi/WebSocket--> [Node-serveri] --WebSocket--> [selain/puhelin]
                                                          │
                                                   vedon tunnistus,
                                                   tallennus (data/pulls.jsonl)
```

## Kansiot

| Kansio | Sisältö |
|---|---|
| `firmware/crimpnet/` | ESP32:n Arduino-koodi |
| `server/` | Node.js-serveri (WebSocket + REST-API) |
| `server/public/` | Käyttöliittymä (live-käyrä, nollaus, kalibrointi, vetohistoria) |
| `server/tools/fake-device.js` | Simuloitu ESP32 testaukseen ilman laitteistoa |

## 1. Testaa ilman laitteistoa (voi tehdä heti)

Tarvitset Node.js 18 tai uudemman.

```bash
cd server
npm install
DEVICE_TOKEN=oma-salainen-token npm start
```

Toisessa terminaalissa:

```bash
cd server
DEVICE_TOKEN=oma-salainen-token npm run fake
```

Avaa selaimessa `http://localhost:8080`. Simuloitu laite tekee 7 sekunnin vedon 11 sekunnin välein, ja vedot ilmestyvät historiaan.

Windowsin PowerShellissä ympäristömuuttuja asetetaan näin: `$env:DEVICE_TOKEN="oma-salainen-token"; npm start`

## 2. ESP32 simuloidulla datalla

1. Arduino IDE: asenna **Boards Manager** -kohdasta `esp32` (Espressif).
2. **Library Manager** -kohdasta:
   - `WebSockets` (Markus Sattler)
   - `ArduinoJson` (Benoit Blanchon, versio 7)
   - `HX711 Arduino Library` (Bogdan Necula)
3. Kopioi `firmware/crimpnet/secrets.example.h` → `secrets.h` ja täytä:
   - hotspotin nimi ja salasana (hotspot 2,4 GHz:lle, WPA2)
   - `SERVER_HOST`: läppärin IP, jonka serveri tulostaa käynnistyessään
   - `DEVICE_TOKEN`: sama kuin serverillä
4. `config.h`:ssa `USE_FAKE_DATA 1`. Lataa koodi ESP32:lle.
5. Serial Monitor (115200): näet WiFi-yhteyden, näytetaajuuden ja WebSocket-tilan.
6. Avaa puhelimella `http://<läppärin-ip>:8080` (puhelin ja läppäri samassa hotspotissa).

Jos ESP32 ei saa yhteyttä serveriin, tarkista läppärin palomuuri (portti 8080 sisään).

## 3. Oikea HX711

1. Kytke HX711: VCC → 3V3, GND → GND, DT → GPIO4, SCK → GPIO5 (vaihda `config.h`:ssa tarvittaessa).
2. `config.h`: `USE_FAKE_DATA 0`, lataa koodi.
3. Serial Monitor näyttää näytetaajuuden: noin 10 Hz tehdasasetuksella, noin 80 Hz RATE-modin jälkeen.
4. Kalibroi käyttöliittymästä:
   1. Laite ilman kuormaa → **Nollaa**
   2. Ripusta tunnettu paino, kirjoita paino kg:na → **Kalibroi**
   3. Tarkista toisella painolla, että lukema täsmää.

Kalibrointi tallentuu ESP32:n pysyvään muistiin ja säilyy virrankatkon yli.

## Viestit

ESP32 → serveri

```json
{"type":"samples","s":[[12345,23.41],[12357,23.52]]}
{"type":"status","msg":"tared","offset":8423112,"cpk":21043.5,"fake":false}
```

Serveri → ESP32

```json
{"cmd":"tare"}
{"cmd":"calibrate","kg":20}
```

Serveri → käyttöliittymä: samat `samples`- ja `status`-viestit sekä `{"type":"pull","pull":{...}}` ja `{"type":"device","connected":true}`.

REST: `GET /api/pulls` (lista), `GET /api/pulls/:id` (yksi veto näytteineen).

## Vedon tunnistus

- Veto alkaa, kun voima ylittää 2 kg, ja päättyy, kun voima on ollut alle 1 kg:n 300 ms.
- Alle 0,5 s vedot hylätään.
- Tunnusluvut: huippuvoima, keskiarvo, kesto, aika huippuun ja RFD (nousunopeus 20 % → 80 % huipusta).

Rajat ovat `server/pulls.js`:n alussa.

## Tietoturva

- `secrets.h` ja `server/data/` ovat `.gitignore`-tiedostossa.
- Laite tunnistetaan tokenilla. Käyttöliittymä ei vaadi kirjautumista, joten käytä serveriä vain omassa verkossa (hotspot).
