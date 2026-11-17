#pragma once

// ---------------------------------------------------------------------------
// CrimpNet – laitteen asetukset
// Salasanat ja palvelimen osoite ovat secrets.h:ssa (ei Gitiin).
// ---------------------------------------------------------------------------

// 1 = lähetä simuloitua vetodataa (ei tarvitse HX711:tä eikä kennoa)
// 0 = lue oikeaa dataa HX711:ltä
#define USE_FAKE_DATA 1

// HX711-pinnit. Vältä strapping-pinnejä (perus-ESP32: 0, 2, 12, 15;
// ESP32-C3: 2, 8, 9). GPIO4/5 toimivat useimmissa levyissä.
#define HX711_DT_PIN  4
#define HX711_SCK_PIN 5

// Simuloidun datan näytteenottotaajuus. Oikealla HX711:llä taajuus tulee
// moduulista (10 Hz tehdasasetuksella, 80 Hz RATE-modin jälkeen).
#define FAKE_SAMPLE_HZ 80

// Montako näytettä lähetetään yhdessä viestissä. 8 näytettä @ 80 Hz = 100 ms.
#define SAMPLES_PER_PACKET 8

// Oletuskalibrointi, jos laitetta ei ole vielä kalibroitu.
// Kalibroi käyttöliittymästä: nollaa ensin, ripusta tunnettu paino ja paina
// "Kalibroi". Arvot tallentuvat ESP32:n pysyvään muistiin.
#define DEFAULT_COUNTS_PER_KG 21000.0f
