# Applikationskarten-Generator (Sentinel-2 → ISOBUS TASKDATA)

Eine schlanke, installationsfreie Web-App zur Erstellung von Dünger-Applikationskarten auf Basis wolkenfreier **Copernicus Sentinel-2 Satellitendaten (10 m)** für **RAUCH / CC-Isobus-Terminals** (`ISOXML v4.2`, `TASKDATA.XML` + `GRD*.BIN`).

## Funktionen
- **100 % lokal im Browser:** Alle Felddaten (`TASKDATA.XML` / `.zip`) bleiben direkt im Browser auf deinem PC – es werden keine Schlaggrenzen auf fremde Server hochgeladen oder gespeichert.
- **Automatischer Sentinel-2-Abruf:** Lädt kostenlos wolkenfreie 10-m-Satellitenausschnitte (mehrjährig oder aktuell) direkt über Element84 Earth Search / AWS Open Data.
- **Randpixel-Filter & Randpuffer:** Filtert 10-m-Mischpixel von Wegen/Hecken aus der Zonierung heraus und puffert die äußerste Randzelle, damit der Streuer am Vorgewende nie auf `0 kg/ha` abfällt.
- **Live-Anpassung:** Dünger, Strategie (*Bestände ausgleichen* / *Ertragspotenzial fördern* / *Gleichmäßig*), Zielmenge, Min/Max-Spanne und Zonenanzahl lassen sich in Echtzeit ändern.
- **Kollisionsfreie Terminal-IDs:** Startet standardmäßig ab ID `501` (`TSK501`, `PFD501`, `GRD00501.BIN`), damit im CCI / RAUCH-Terminal keine bestehenden Aufträge überschrieben werden.
- **Export:**
  - `TASKDATA.zip` (entpacken → Ordner `TASKDATA` direkt oben auf den USB-Stick kopieren)
  - Druckfertiger **Kontrollbericht (PDF, A4-Querformat)** mit Lagekarte, Gesamttabelle und Einzelkarten
  - Excel-fertige **CSV-Übersichtstabelle**

## Veröffentlichung über GitHub Pages (kostenlos)
1. Auf [github.com](https://github.com) anmelden und ein neues **öffentliches (Public)** Repository anlegen (z. B. `applikationskarten`).
2. Alle Dateien und Ordner aus diesem Verzeichnis (`index.html`, `css/`, `js/`, `lib/`, `README.md`) über **Add file → Upload files** hochladen und bestätigen (*Commit changes*).
3. Im Repository unter **Settings → Pages** bei *Source* „Deploy from a branch“ wählen, Branch **`main`** und Ordner **`/ (root)`** auswählen und auf **Save** klicken.
4. Nach ca. 1–2 Minuten ist die App dauerhaft unter `https://<dein-benutzername>.github.io/applikationskarten/` auf jedem Windows-PC im Browser erreichbar – ohne Installation!
