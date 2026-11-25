# Applikationskarten-Generator & Soll/Ist-Auswertung (Sentinel-2 & ISOBUS TASKDATA)

Eine schlanke, installationsfreie Web-App für **RAUCH / CC-Isobus-Terminals** (`ISOXML v4.2`), komplett lokal im Browser ohne fremde Datenspeicherung.

## Zwei Bereiche (Tabs)

### 1. Applikationskarten erstellen
- Schlaggrenzen per `TASKDATA.XML` oder `.zip` laden.
- Kostenloser, direkter Abruf wolkenfreier **Copernicus Sentinel-2 Satellitendaten (10 m)** im Browser (mehrjährig oder aktuell).
- **10-m-Randpixel-Filter** & **Randpuffer**, Live-Anpassung von Dünger, Strategie (*Bestände ausgleichen* / *Ertragspotenzial fördern* / *Gleichmäßig*), Zielmenge, Spanne, Zonenanzahl und kollisionsfreien Terminal-IDs (ab `501`).
- Export als terminal-fertige **`TASKDATA.zip`**, druckfertiger **Kontrollbericht (PDF, A4-Querformat)** und **Excel-CSV**.

### 2. Soll / Ist & As-Applied auswerten
- Direkte Auswahl des **`TASKDATA`-Ordners vom USB-Stick** (oder Upload als `TASKDATA.zip`).
- Liest `TASKDATA.XML`, `DEVICEDATA.XML`, `TLG*.XML/BIN` (Ist-Ausbringung `DDI 0007`, Soll `DDI 0006`, Gesamtmengen `DDI 0051`, Fläche `DDI 0074`, Arbeitsbreite `DDI 0043`, Waage `DDI 004B`) und `GRD*.BIN` (Soll-Applikationskarte) direkt im Browser aus.
- Automatische **Wurfweiten-Korrektur** (`DDI 0086` + Schlepper-GNSS/Heckhubwerk-Offset aus `DEVICEDATA.XML`, ein-/ausschaltbar) für lagegenauen Soll/Ist-Vergleich.
- Kultur-Filter, Schlagsuche, interaktive Side-by-Side-Karten mit Hover-Tooltip, Kultur-Übersichtskarte, Gesamttabelle sowie Export als **Einzelschlag-PDF**, **Gesamtbericht-PDF** und **Excel-CSV**.
