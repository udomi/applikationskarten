/**
 * asapplied.js — Browser-side ISOXML TASKDATA (TLG*.XML/BIN + GRD*.BIN + DEVICEDATA.XML)
 * parser, RAUCH throwing-point offset (DDI 0086) calculator, and swath rasterizer
 * for Soll/Ist & As-Applied analysis.
 */
window.AppAsApplied = (function () {
    "use strict";

    const DEG2RAD = Math.PI / 180.0;
    const EPOCH_1980_MS = Date.UTC(1980, 0, 1, 0, 0, 0);

    const CROP_ORDER = {
        "Winterraps Hauptfrucht": 1,
        "Wintergerste": 2,
        "Winterweichweizen": 3,
        "Mais Körnernutzung": 4,
        "Mais Silonutzung": 5,
        "Sonstige / ohne Kultur": 6,
    };

    const CROP_COLORS = {
        "Winterraps Hauptfrucht": "#eab308",
        "Wintergerste": "#f97316",
        "Winterweichweizen": "#22c55e",
        "Mais Körnernutzung": "#3b82f6",
        "Mais Silonutzung": "#06b6d4",
        "Sonstige / ohne Kultur": "#8b5cf6",
    };

    function getCropColor(cropName) {
        if (CROP_COLORS[cropName]) return CROP_COLORS[cropName];
        const lower = String(cropName || "").toLowerCase();
        if (lower.includes("raps")) return "#eab308";
        if (lower.includes("gerste")) return "#f97316";
        if (lower.includes("weizen")) return "#22c55e";
        if (lower.includes("mais")) return "#3b82f6";
        if (lower.includes("rübe") || lower.includes("ruebe")) return "#ec4899";
        return "#8b5cf6";
    }

    /**
     * Build a normalized uppercase-basename file store from either:
     *  - a single .zip File
     *  - or a FileList / Array of Files (e.g. from webkitdirectory folder upload or multi-file drop)
     * Each entry offers async getText() and async getArrayBuffer().
     */
    async function buildFileStore(filesInput) {
        const files = Array.from(filesInput || []);
        if (files.length === 0) {
            throw new Error("Keine Dateien ausgewählt.");
        }

        const store = new Map(); // UPPERCASE_BASENAME -> { name, getText, getArrayBuffer }
        let sourceLabel = "";

        if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
            sourceLabel = files[0].name;
            const zip = await window.JSZip.loadAsync(files[0]);
            zip.forEach((relPath, entry) => {
                if (entry.dir) return;
                const base = relPath.split("/").pop();
                const key = base.toUpperCase();
                if (!store.has(key) || relPath.toUpperCase().includes("TASKDATA/")) {
                    store.set(key, {
                        name: base,
                        getText: () => entry.async("string"),
                        getArrayBuffer: () => entry.async("arraybuffer"),
                    });
                }
            });
        } else {
            // Folder or multi-file upload
            const firstRel = files[0].webkitRelativePath || "";
            sourceLabel = firstRel ? firstRel.split("/")[0] : `${files.length} Dateien`;
            for (const f of files) {
                const key = f.name.toUpperCase();
                // Prefer files inside TASKDATA if multiple folders selected
                const relUp = (f.webkitRelativePath || "").toUpperCase();
                if (!store.has(key) || relUp.includes("TASKDATA/")) {
                    store.set(key, {
                        name: f.name,
                        getText: () => f.text(),
                        getArrayBuffer: () => f.arrayBuffer(),
                    });
                }
            }
        }

        if (!store.has("TASKDATA.XML")) {
            throw new Error("Keine TASKDATA.XML gefunden. Bitte den Ordner TASKDATA (vom USB-Stick) oder eine TASKDATA.zip auswählen.");
        }

        return { store, sourceLabel };
    }

    /**
     * Extract tractor GNSS-to-Rear-Hitch X offset (m) from DEVICEDATA.XML if available.
     * Falls back to -1.985 m (Fendt 714 standard: GNSS +0.805 m, Rear Hitch Mounted -1.180 m).
     */
    async function parseTractorHitchOffset(store) {
        const fallback = -1.985;
        if (!store.has("DEVICEDATA.XML")) return { offsetM: fallback, tractorName: null, fromDeviceData: false };
        try {
            const xml = await store.get("DEVICEDATA.XML").getText();
            const doc = new DOMParser().parseFromString(xml, "application/xml");
            const dvc = doc.querySelector("DVC");
            const tractorName = dvc ? (dvc.getAttribute("B") || null) : null;

            const dptMap = new Map();
            doc.querySelectorAll("DPT").forEach(dpt => {
                dptMap.set(dpt.getAttribute("A"), {
                    ddi: (dpt.getAttribute("B") || "").toUpperCase(),
                    val: parseInt(dpt.getAttribute("C") || "0", 10),
                });
            });

            let gnssX = null;
            let hitchX = null;
            doc.querySelectorAll("DET").forEach(det => {
                const detType = det.getAttribute("C");
                const detName = (det.getAttribute("D") || "").toLowerCase();
                const dors = Array.from(det.querySelectorAll(":scope > DOR")).map(x => x.getAttribute("A"));
                for (const objId of dors) {
                    const p = dptMap.get(objId);
                    if (!p || p.ddi !== "0086") continue;
                    if (detType === "7" || detName.includes("gnss")) {
                        gnssX = p.val / 1000.0;
                    } else if (detName.includes("rear hitch mounted")) {
                        hitchX = p.val / 1000.0;
                    }
                }
            });

            if (gnssX !== null && hitchX !== null) {
                return { offsetM: hitchX - gnssX, tractorName, fromDeviceData: true };
            }
            return { offsetM: fallback, tractorName, fromDeviceData: false };
        } catch {
            return { offsetM: fallback, tractorName: null, fromDeviceData: false };
        }
    }

    /**
     * Decode one TLG*.XML + TLG*.BIN pair strictly following ISO 11783-10 binary format.
     */
    async function decodeTlg(tlgName, store) {
        const xmlEntry = store.get((tlgName + ".XML").toUpperCase());
        const binEntry = store.get((tlgName + ".BIN").toUpperCase());
        if (!xmlEntry || !binEntry) return null;

        const [xmlText, buf] = await Promise.all([xmlEntry.getText(), binEntry.getArrayBuffer()]);
        const doc = new DOMParser().parseFromString(xmlText, "application/xml");
        const root = doc.documentElement;
        if (!root) return null;

        const dlvs = Array.from(root.querySelectorAll("DLV")).map(d => ({
            ddi: (d.getAttribute("A") || "").toUpperCase(),
            det: d.getAttribute("C") || "",
        }));
        const hasPtn = root.querySelector("PTN") !== null;

        // Auto-detect primary boom DET (prefer DET-42, else first DET carrying DDI 0007)
        let primaryDet = "DET-42";
        const hasDet42 = dlvs.some(d => d.det === "DET-42" && (d.ddi === "0007" || d.ddi === "008D"));
        if (!hasDet42) {
            const alt = dlvs.find(d => d.ddi === "0007");
            if (alt && alt.det) primaryDet = alt.det;
        }
        // Detect bin weight DET (DDI 004B) if present
        const binDlv = dlvs.find(d => d.ddi === "004B");
        const binDet = binDlv ? binDlv.det : null;

        const dv = new DataView(buf);
        const bytes = new Uint8Array(buf);
        const n = buf.byteLength;
        let pos = 0;

        // Current state map keyed by "DDI|DET"
        const state = Object.create(null);
        const records = [];

        while (pos < n) {
            if (pos + 6 > n) break;
            const ms = dv.getUint32(pos, true);
            const days = dv.getUint16(pos + 4, true);
            pos += 6;
            const tsMs = EPOCH_1980_MS + days * 86400000 + ms;

            let lat = null, lon = null, alt = null, pstat = null;
            if (hasPtn) {
                if (pos + 13 > n) break;
                const latI = dv.getInt32(pos, true);
                const lonI = dv.getInt32(pos + 4, true);
                const altI = dv.getInt32(pos + 8, true);
                pstat = bytes[pos + 12];
                pos += 13;
                lat = latI * 1e-7;
                lon = lonI * 1e-7;
                alt = altI * 1e-3;
            }

            if (pos >= n) break;
            const numDlvs = bytes[pos];
            pos += 1;
            if (pos + numDlvs * 5 > n) break;

            for (let k = 0; k < numDlvs; k++) {
                const idx = bytes[pos];
                const val = dv.getInt32(pos + 1, true);
                pos += 5;
                if (idx < dlvs.length) {
                    const d = dlvs[idx];
                    state[d.ddi + "|" + d.det] = val;
                }
            }

            records.push({
                tsMs,
                lat,
                lon,
                workState: state["008D|" + primaryDet] ?? 0,
                actualRate: (state["0007|" + primaryDet] ?? 0) * 0.01,
                targetRate: (state["0006|" + primaryDet] ?? 0) * 0.01,
                widthM: (state["0043|" + primaryDet] ?? 30000) / 1000.0,
                maxWidthM: (state["0046|" + primaryDet] ?? 36000) / 1000.0,
                oxM: (state["0086|" + primaryDet] ?? 0) / 1000.0,
                totalAmtRaw: state["0051|" + primaryDet],
                totalAreaRaw: state["0074|" + primaryDet],
                totalTimeRaw: state["0077|" + primaryDet],
                binWeightRaw: binDet ? state["004B|" + binDet] : undefined,
            });
        }

        return { records, primaryDet, binDet };
    }

    function computeCounterDelta(records, fieldKey, scale) {
        let total = 0.0;
        let prev = null;
        for (let i = 0; i < records.length; i++) {
            const v = records[i][fieldKey];
            if (v !== undefined) {
                if (prev !== null && v > prev) {
                    total += (v - prev) * scale;
                }
                prev = v;
            }
        }
        return total;
    }

    /**
     * Decode ISOXML GRD*.BIN (Type 2 int32 * scale, or Type 1 uint8 TZN lookup).
     */
    async function decodeGrd(grdMeta, store) {
        const entry = store.get((grdMeta.grdName + ".BIN").toUpperCase());
        if (!entry) return null;
        const buf = await entry.getArrayBuffer();
        const total = grdMeta.nCols * grdMeta.nRows;
        if (total <= 0) return null;

        const rates = new Float32Array(total);
        const dv = new DataView(buf);

        if (grdMeta.gridType === 1 && buf.byteLength >= total) {
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < total; i++) {
                const tznCode = bytes[i];
                rates[i] = grdMeta.tznRates.get(tznCode) || 0.0;
            }
        } else if (buf.byteLength >= total * 4) {
            const scale = grdMeta.scale || 0.01;
            for (let i = 0; i < total; i++) {
                const raw = dv.getInt32(i * 4, true);
                rates[i] = raw > 0 ? raw * scale : 0.0;
            }
        } else {
            return null;
        }

        return {
            grdName: grdMeta.grdName,
            minLat: grdMeta.minLat,
            minLon: grdMeta.minLon,
            cellLat: grdMeta.cellLat,
            cellLon: grdMeta.cellLon,
            nCols: grdMeta.nCols,
            nRows: grdMeta.nRows,
            rates,
        };
    }

    /**
     * Parse full RAUCH / CC-Isobus TASKDATA folder or ZIP into structured field analysis entries.
     */
    async function parseTaskdataDataset(filesInput, onProgress) {
        const report = (pct, msg) => { if (typeof onProgress === "function") onProgress(pct, msg); };

        report(5, "Lese TASKDATA-Verzeichnis…");
        const { store, sourceLabel } = await buildFileStore(filesInput);
        const deviceInfo = await parseTractorHitchOffset(store);

        report(12, "Analysiere TASKDATA.XML…");
        const xmlText = await store.get("TASKDATA.XML").getText();
        const doc = new DOMParser().parseFromString(xmlText, "application/xml");
        if (doc.querySelector("parsererror")) {
            throw new Error("TASKDATA.XML konnte nicht gelesen werden (ungültiges XML).");
        }
        const root = doc.documentElement;
        if (!root || root.tagName !== "ISO11783_TaskData") {
            throw new Error("Datei ist keine gültige ISO11783 TASKDATA.XML.");
        }

        const frm = root.querySelector(":scope > FRM");
        const ctr = root.querySelector(":scope > CTR");
        const farmName = (frm?.getAttribute("B") || [ctr?.getAttribute("C"), ctr?.getAttribute("B")].filter(Boolean).join(" ") || "Unbekannter Betrieb").replace(/\s+/g, " ").trim();

        const crops = new Map();
        root.querySelectorAll(":scope > CTP").forEach(el => {
            crops.set(el.getAttribute("A"), el.getAttribute("B") || "");
        });
        const products = new Map();
        root.querySelectorAll(":scope > PDT").forEach(el => {
            products.set(el.getAttribute("A"), el.getAttribute("B") || "");
        });
        const vpns = new Map();
        root.querySelectorAll(":scope > VPN").forEach(el => {
            vpns.set(el.getAttribute("A"), {
                scale: parseFloat(el.getAttribute("C") || "0.01") || 0.01,
                unit: el.getAttribute("E") || "kg/ha",
            });
        });

        // Parse PFD (Partfields)
        const fieldMap = new Map();
        root.querySelectorAll(":scope > PFD").forEach(pfd => {
            const fid = pfd.getAttribute("A");
            const outerRings = [];
            const innerRings = [];
            pfd.querySelectorAll(":scope > PLN").forEach(pln => {
                const plnType = pln.getAttribute("A");
                if (plnType && plnType !== "1" && plnType !== "2") return;
                pln.querySelectorAll(":scope > LSG").forEach(lsg => {
                    const pts = [];
                    lsg.querySelectorAll(":scope > PNT").forEach(p => {
                        const lat = parseFloat(p.getAttribute("C"));
                        const lon = parseFloat(p.getAttribute("D"));
                        if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lon, lat]);
                    });
                    if (pts.length >= 3) {
                        if (lsg.getAttribute("A") === "2") innerRings.push(pts);
                        else outerRings.push(pts);
                    }
                });
            });

            let areaM2 = parseInt(pfd.getAttribute("D") || "0", 10);
            if ((!Number.isFinite(areaM2) || areaM2 <= 0) && outerRings.length > 0) {
                areaM2 = Math.round(window.AppGeo.computePolygonAreaM2(outerRings, innerRings));
            }
            const cropName = crops.get(pfd.getAttribute("G") || "") || "Sonstige / ohne Kultur";

            let sumLon = 0, sumLat = 0, cnt = 0;
            for (const r of outerRings) for (const p of r) { sumLon += p[0]; sumLat += p[1]; cnt++; }

            fieldMap.set(fid, {
                id: fid,
                code: pfd.getAttribute("B") || "",
                name: (pfd.getAttribute("C") || fid).trim(),
                areaHa: areaM2 / 10000.0,
                crop: cropName,
                outerRings,
                innerRings,
                centerLon: cnt > 0 ? sumLon / cnt : null,
                centerLat: cnt > 0 ? sumLat / cnt : null,
                tasks: [],
            });
        });

        // Attach TSK elements that have TLGs (and/or GRDs)
        const allTasks = Array.from(root.querySelectorAll(":scope > TSK"));
        for (const tsk of allTasks) {
            const tlgs = Array.from(tsk.querySelectorAll(":scope > TLG")).map(el => el.getAttribute("A")).filter(Boolean);
            if (tlgs.length === 0) continue;
            const fid = tsk.getAttribute("E") || "";
            if (!fieldMap.has(fid)) continue;

            const pans = Array.from(new Set(
                Array.from(tsk.querySelectorAll(":scope > PAN"))
                    .map(el => products.get(el.getAttribute("A")) || el.getAttribute("A"))
                    .filter(Boolean)
            ));

            // Parse optional GRD metadata attached to this task
            const grdEl = tsk.querySelector(":scope > GRD");
            let grdMeta = null;
            if (grdEl && grdEl.getAttribute("G")) {
                const tznRates = new Map();
                let scale = 0.01;
                tsk.querySelectorAll(":scope > TZN").forEach(tzn => {
                    const code = parseInt(tzn.getAttribute("A") || "0", 10);
                    const pdv = tzn.querySelector("PDV");
                    if (pdv) {
                        const vpn = vpns.get(pdv.getAttribute("E") || "");
                        if (vpn) scale = vpn.scale;
                        const val = parseInt(pdv.getAttribute("B") || "0", 10) * scale;
                        tznRates.set(code, val);
                    }
                });
                grdMeta = {
                    grdName: grdEl.getAttribute("G"),
                    minLat: parseFloat(grdEl.getAttribute("A")),
                    minLon: parseFloat(grdEl.getAttribute("B")),
                    cellLat: parseFloat(grdEl.getAttribute("C")),
                    cellLon: parseFloat(grdEl.getAttribute("D")),
                    nCols: parseInt(grdEl.getAttribute("E") || "0", 10),
                    nRows: parseInt(grdEl.getAttribute("F") || "0", 10),
                    gridType: parseInt(grdEl.getAttribute("I") || "2", 10),
                    scale,
                    tznRates,
                };
            }

            fieldMap.get(fid).tasks.push({
                tid: tsk.getAttribute("A") || "",
                tname: tsk.getAttribute("B") || "",
                products: pans,
                tlgs,
                grdMeta,
            });
        }

        // Process each field's TLGs & GRDs
        const fieldsWithTasks = Array.from(fieldMap.values()).filter(f => f.tasks.length > 0);
        const activeFields = [];
        const inactiveCount = fieldMap.size - fieldsWithTasks.length;

        for (let fi = 0; fi < fieldsWithTasks.length; fi++) {
            const f = fieldsWithTasks[fi];
            if (fi % 5 === 0) {
                report(18 + Math.round((fi / Math.max(1, fieldsWithTasks.length)) * 78),
                    `Lese Protokolldaten (${fi + 1}/${fieldsWithTasks.length}): ${f.name}…`);
                await new Promise(r => setTimeout(r, 0));
            }

            const tracks = []; // Array of tracks; each point: { tsMs, lon, lat, sLon, sLat, ar, tr, wM, oxM }
            const activePts = [];
            let totKg = 0.0;
            let totHa = 0.0;
            let totSec = 0.0;
            let binDeltaKg = 0.0;
            const tlgNames = [];
            const productSet = new Set();
            let chosenGrdMeta = null;

            for (const t of f.tasks) {
                t.products.forEach(p => productSet.add(p));
                if (t.grdMeta && !chosenGrdMeta && store.has((t.grdMeta.grdName + ".BIN").toUpperCase())) {
                    chosenGrdMeta = t.grdMeta;
                }

                for (const tg of t.tlgs) {
                    const decoded = await decodeTlg(tg, store);
                    if (!decoded || decoded.records.length === 0) continue;
                    tlgNames.push(tg);
                    const recs = decoded.records;

                    totKg += computeCounterDelta(recs, "totalAmtRaw", 1.0);
                    totHa += computeCounterDelta(recs, "totalAreaRaw", 0.0001);
                    totSec += computeCounterDelta(recs, "totalTimeRaw", 1.0);

                    // Bin weight drop check (DDI 004B) if available
                    if (decoded.binDet) {
                        const validBins = recs.map(r => r.binWeightRaw).filter(v => v !== undefined && v > 0);
                        if (validBins.length >= 2) {
                            const drop = (validBins[0] - validBins[validBins.length - 1]) * 0.001;
                            if (drop > 5) binDeltaKg += drop;
                        }
                    }

                    // Valid GPS coordinates & smooth heading vectors (matching generate_as_applied_maps.py)
                    const nRecs = recs.length;
                    const validCoords = new Array(nRecs).fill(null);
                    for (let i = 0; i < nRecs; i++) {
                        const lat = recs[i].lat, lon = recs[i].lon;
                        if (lat !== null && lon !== null && lat > 35 && lat < 72 && lon > -15 && lon < 40) {
                            validCoords[i] = [lon, lat];
                        }
                    }

                    const headings = new Array(nRecs).fill(null);
                    let lastH = null;
                    const offsets = [[-1, 1], [0, 1], [-1, 0], [-2, 2], [0, 2], [-2, 0]];
                    for (let i = 0; i < nRecs; i++) {
                        const cur = validCoords[i];
                        if (!cur) continue;
                        const cosL = Math.cos(cur[1] * DEG2RAD);
                        let bestVec = null;
                        for (let oi = 0; oi < offsets.length; oi++) {
                            const ia = i + offsets[oi][0];
                            const ib = i + offsets[oi][1];
                            if (ia >= 0 && ia < nRecs && ib >= 0 && ib < nRecs && validCoords[ia] && validCoords[ib]) {
                                const dtSec = Math.abs(recs[ib].tsMs - recs[ia].tsMs) / 1000.0;
                                if (dtSec > 20.0) continue;
                                const dx = (validCoords[ib][0] - validCoords[ia][0]) * 111320.0 * cosL;
                                const dy = (validCoords[ib][1] - validCoords[ia][1]) * 110540.0;
                                const L = Math.hypot(dx, dy);
                                if (L >= 0.4 && L <= 80.0) {
                                    bestVec = [dx / L, dy / L];
                                    break;
                                }
                            }
                        }
                        if (bestVec) { headings[i] = bestVec; lastH = bestVec; }
                        else if (lastH) headings[i] = lastH;
                    }

                    let curTrack = [];
                    for (let i = 0; i < nRecs; i++) {
                        const r = recs[i];
                        let maxW = r.maxWidthM;
                        if (maxW < 6.0 || maxW > 48.0) maxW = 36.0;
                        let wM = r.widthM;
                        if (wM < 6.0 || wM > maxW) wM = Math.min(30.0, maxW);

                        if (r.workState === 1 && r.actualRate > 0 && validCoords[i]) {
                            const [lon, lat] = validCoords[i];
                            let sLon = lon, sLat = lat;
                            let appliedShiftM = 0.0;
                            if (r.oxM < -0.5 && headings[i]) {
                                const [ux, uy] = headings[i];
                                appliedShiftM = r.oxM + deviceInfo.offsetM;
                                const cosL = Math.cos(lat * DEG2RAD);
                                sLon = lon + (ux * appliedShiftM) / (111320.0 * cosL);
                                sLat = lat + (uy * appliedShiftM) / 110540.0;
                            }
                            const pt = {
                                tsMs: r.tsMs,
                                lon,
                                lat,
                                sLon,
                                sLat,
                                ar: r.actualRate,
                                tr: r.targetRate,
                                wM,
                                oxM: r.oxM,
                                shiftM: appliedShiftM,
                            };
                            curTrack.push(pt);
                            activePts.push(pt);
                        } else if (curTrack.length > 0) {
                            tracks.push(curTrack);
                            curTrack = [];
                        }
                    }
                    if (curTrack.length > 0) tracks.push(curTrack);
                }
            }

            if (activePts.length < 5) continue;

            // Decode associated GRD Soll map if present
            let sollGrd = null;
            if (chosenGrdMeta) {
                sollGrd = await decodeGrd(chosenGrdMeta, store);
            }

            // Fill center from tracks if PFD polygon missing
            if (f.centerLon === null || f.centerLat === null) {
                let sLo = 0, sLa = 0;
                for (const p of activePts) { sLo += p.sLon; sLa += p.sLat; }
                f.centerLon = sLo / activePts.length;
                f.centerLat = sLa / activePts.length;
            }

            // Compute statistics
            let minAr = Infinity, maxAr = -Infinity, sumAr = 0;
            let sumTr = 0, cntTr = 0;
            let sumShift = 0, cntShift = 0;
            const widthFreq = new Map();
            const dateSet = new Set();
            let minTs = Infinity, maxTs = -Infinity;

            for (const p of activePts) {
                if (p.ar < minAr) minAr = p.ar;
                if (p.ar > maxAr) maxAr = p.ar;
                sumAr += p.ar;
                if (p.tr > 0) { sumTr += p.tr; cntTr++; }
                if (p.shiftM < -0.5) { sumShift += p.shiftM; cntShift++; }
                const wk = Math.round(p.wM * 10) / 10;
                widthFreq.set(wk, (widthFreq.get(wk) || 0) + 1);
                if (p.tsMs < minTs) minTs = p.tsMs;
                if (p.tsMs > maxTs) maxTs = p.tsMs;
                dateSet.add(new Date(p.tsMs).toISOString().slice(0, 10));
            }

            let modeWidth = 30.0, bestWCount = -1;
            for (const [w, c] of widthFreq.entries()) {
                if (c > bestWCount) { bestWCount = c; modeWidth = w; }
            }

            const avgArPts = sumAr / activePts.length;
            const avgArArea = totHa > 0.05 ? totKg / totHa : avgArPts;
            const avgTrTlg = cntTr > 0 ? sumTr / cntTr : null;
            const avgShiftM = cntShift > 0 ? sumShift / cntShift : 0.0;
            const sortedDates = Array.from(dateSet).sort();

            const dtStart = new Date(minTs);
            const dtEnd = new Date(maxTs);
            const fmtHm = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

            // Compute Soll GRD stats inside polygon (or positive cells if no polygon)
            let sollStats = null;
            if (sollGrd) {
                sollStats = computeSollGrdStats(f, sollGrd);
            }

            // Compute point-by-point Soll/Ist match (both with offset & without offset)
            const matchStats = computeMatchStats(activePts, sollGrd);

            // Effective Soll rate & Soll kg for table/KPI comparison
            const avgSoll = sollStats ? sollStats.avgRate : avgTrTlg;
            const areaRef = f.areaHa > 0.01 ? f.areaHa : totHa;
            const sollTotalKg = avgSoll !== null ? avgSoll * areaRef : null;
            const istTotalKg = totKg > 0 ? totKg : avgArPts * areaRef;
            const diffPct = (avgSoll && avgSoll > 0) ? ((avgArPts - avgSoll) / avgSoll) * 100.0 : null;

            activeFields.push({
                uid: `aa_${f.id}`,
                id: f.id,
                code: f.code,
                name: f.name,
                crop: f.crop,
                areaHa: f.areaHa,
                workedHa: totHa,
                outerRings: f.outerRings,
                innerRings: f.innerRings,
                centerLon: f.centerLon,
                centerLat: f.centerLat,
                products: Array.from(productSet).sort(),
                productLabel: Array.from(productSet).sort().join(", ") || "Dünger",
                tlgNames,
                taskNames: f.tasks.map(t => t.tname).filter(Boolean),
                datesIso: sortedDates,
                dateDe: sortedDates.map(d => window.AppGeo.fmtDateDe(d)).join(", "),
                timeSpan: `${fmtHm(dtStart)}–${fmtHm(dtEnd)}`,
                tracks,
                activePts,
                sollGrd,
                sollStats,
                matchStats,
                totKg: istTotalKg,
                totSec,
                binDeltaKg: binDeltaKg > 5 ? binDeltaKg : null,
                minAr,
                maxAr,
                avgArPts,
                avgArArea,
                avgTrTlg,
                avgSoll,
                sollTotalKg,
                diffPct,
                modeWidth,
                distinctWidths: Array.from(widthFreq.keys()).sort((a, b) => a - b),
                avgShiftM,
                rasterCache: new Map(), // "offset_1" | "offset_0" -> raster object
            });
        }

        if (activeFields.length === 0) {
            throw new Error("In dieser TASKDATA wurden keine aufgezeichneten Ausbringdaten (TLG*.XML + TLG*.BIN mit aktivem Streuer) gefunden.");
        }

        activeFields.sort((a, b) => {
            const oa = CROP_ORDER[a.crop] || 99;
            const ob = CROP_ORDER[b.crop] || 99;
            if (oa !== ob) return oa - ob;
            return a.name.localeCompare(b.name, "de");
        });

        const cropsList = Array.from(new Set(activeFields.map(f => f.crop)));
        const allDates = activeFields.flatMap(f => f.datesIso).sort();

        report(100, `Fertig! ${activeFields.length} Schläge mit Ausbringdaten eingelesen.`);

        return {
            sourceLabel,
            farmName,
            deviceInfo,
            activeFields,
            inactiveCount,
            cropsList,
            dateRangeDe: allDates.length
                ? (allDates[0] === allDates[allDates.length - 1]
                    ? window.AppGeo.fmtDateDe(allDates[0])
                    : `${window.AppGeo.fmtDateDe(allDates[0])} – ${window.AppGeo.fmtDateDe(allDates[allDates.length - 1])}`)
                : "–",
        };
    }

    /**
     * Compute exact statistics & discrete zone shares of a Soll GRD file strictly inside the field polygon.
     */
    function computeSollGrdStats(field, grd) {
        const { minLat, minLon, cellLat, cellLon, nCols, nRows, rates } = grd;
        const lat0 = minLat + 0.5 * nRows * cellLat;
        const lon0 = minLon + 0.5 * nCols * cellLon;
        const cosLat = Math.cos(lat0 * DEG2RAD);
        const outerM = field.outerRings.map(r => window.AppGeo.projectRingToLocalMeters(r, lon0, lat0));
        const innerM = field.innerRings.map(r => window.AppGeo.projectRingToLocalMeters(r, lon0, lat0));
        const hasPoly = outerM.length > 0;

        let sum = 0, cnt = 0, minR = Infinity, maxR = -Infinity;
        const zoneMap = new Map();

        for (let r = 0; r < nRows; r++) {
            const cLat = minLat + (r + 0.5) * cellLat;
            const cy = (cLat - lat0) * 110540.0;
            const rowOff = r * nCols;
            for (let c = 0; c < nCols; c++) {
                const v = rates[rowOff + c];
                if (v <= 0) continue;
                if (hasPoly) {
                    const cLon = minLon + (c + 0.5) * cellLon;
                    const cx = (cLon - lon0) * 111320.0 * cosLat;
                    let inside = false;
                    for (let k = 0; k < outerM.length; k++) {
                        if (window.AppGeo.pointInRing(cx, cy, outerM[k])) { inside = true; break; }
                    }
                    if (inside && innerM.length > 0) {
                        for (let k = 0; k < innerM.length; k++) {
                            if (window.AppGeo.pointInRing(cx, cy, innerM[k])) { inside = false; break; }
                        }
                    }
                    if (!inside) continue;
                }
                sum += v;
                cnt++;
                if (v < minR) minR = v;
                if (v > maxR) maxR = v;
                const rk = Math.round(v * 4) / 4; // group to 0.25 kg/ha precision
                zoneMap.set(rk, (zoneMap.get(rk) || 0) + 1);
            }
        }

        if (cnt === 0) return null;
        const zones = Array.from(zoneMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([rate, count]) => ({ rate, count, pct: (count / cnt) * 100.0 }));

        return {
            avgRate: sum / cnt,
            minRate: minR,
            maxRate: maxR,
            cellCount: cnt,
            cellW_m: cellLon * 111320.0 * cosLat,
            cellH_m: cellLat * 110540.0,
            zones,
        };
    }

    /**
     * Evaluate spatial & rate agreement between TLG points and Soll GRD.
     */
    function computeMatchStats(activePts, sollGrd) {
        let within5 = 0, within10 = 0, tlgPaired = 0;
        for (const p of activePts) {
            if (p.tr > 0) {
                tlgPaired++;
                const rel = Math.abs(p.ar - p.tr) / p.tr;
                if (rel <= 0.05) within5++;
                if (rel <= 0.10) within10++;
            }
        }

        let grdMatchShifted = null, grdMatchRaw = null;
        if (sollGrd) {
            const checkPos = (useShift) => {
                let m = 0, t = 0;
                for (const p of activePts) {
                    if (p.tr <= 0) continue;
                    const lon = useShift ? p.sLon : p.lon;
                    const lat = useShift ? p.sLat : p.lat;
                    const c = Math.floor((lon - sollGrd.minLon) / sollGrd.cellLon);
                    const r = Math.floor((lat - sollGrd.minLat) / sollGrd.cellLat);
                    if (r >= 0 && r < sollGrd.nRows && c >= 0 && c < sollGrd.nCols) {
                        const gv = sollGrd.rates[r * sollGrd.nCols + c];
                        if (gv > 0) {
                            t++;
                            if (Math.abs(gv - p.tr) < 2.0) m++;
                        }
                    }
                }
                return t > 0 ? (m / t) * 100.0 : null;
            };
            grdMatchShifted = checkPos(true);
            grdMatchRaw = checkPos(false);
        }

        return {
            within5Pct: tlgPaired > 0 ? (within5 / tlgPaired) * 100.0 : null,
            within10Pct: tlgPaired > 0 ? (within10 / tlgPaired) * 100.0 : null,
            grdMatchShiftedPct: grdMatchShifted,
            grdMatchRawPct: grdMatchRaw,
        };
    }

    /**
     * On-demand fast swath rasterization for a single field (cached by offset flag).
     */
    function rasterizeAsAppliedField(item, useOffset = true) {
        const cacheKey = useOffset ? "offset_1" : "offset_0";
        if (item.rasterCache.has(cacheKey)) {
            return item.rasterCache.get(cacheKey);
        }

        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const p of item.activePts) {
            const lo = useOffset ? p.sLon : p.lon;
            const la = useOffset ? p.sLat : p.lat;
            if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
            if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
        }
        for (const r of item.outerRings) {
            for (const p of r) {
                if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0];
                if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
            }
        }
        const lon0 = 0.5 * (minLon + maxLon);
        const lat0 = 0.5 * (minLat + maxLat);
        const cosLat = Math.cos(lat0 * DEG2RAD);

        const toXY = (lo, la) => [
            (lo - lon0) * 111320.0 * cosLat,
            (la - lat0) * 110540.0,
        ];

        const outerM = item.outerRings.map(r => r.map(p => toXY(p[0], p[1])));
        const innerM = item.innerRings.map(r => r.map(p => toXY(p[0], p[1])));
        const tracksM = item.tracks.map(tr => ({
            pts: tr,
            xy: tr.map(p => toXY(useOffset ? p.sLon : p.lon, useOffset ? p.sLat : p.lat)),
        }));

        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        if (outerM.length > 0) {
            for (const r of outerM) for (const p of r) {
                if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
                if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
            }
            xmin -= 18; xmax += 18; ymin -= 18; ymax += 18;
        } else {
            for (const t of tracksM) for (const p of t.xy) {
                if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
                if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
            }
            xmin -= 30; xmax += 30; ymin -= 30; ymax += 30;
        }

        const span = Math.max(xmax - xmin, ymax - ymin, 60.0);
        // Fast crisp resolution (~260-320 px along longest side, between 1.0 m and 6.0 m)
        const res = Math.max(1.0, Math.min(6.0, span / 290.0));
        const nx = Math.max(10, Math.ceil((xmax - xmin) / res));
        const ny = Math.max(10, Math.ceil((ymax - ymin) / res));
        const total = nx * ny;

        const bestDist = new Float32Array(total);
        bestDist.fill(Infinity);
        const rateGrid = new Float32Array(total);
        rateGrid.fill(NaN);
        const targetGrid = new Float32Array(total);
        targetGrid.fill(NaN);

        // Rasterize swath segments via nearest-segment distance
        for (let ti = 0; ti < tracksM.length; ti++) {
            const { pts, xy } = tracksM[ti];
            const nPts = pts.length;
            const segCount = nPts === 1 ? 1 : nPts - 1;

            for (let si = 0; si < segCount; si++) {
                const i0 = si;
                const i1 = nPts === 1 ? 0 : si + 1;
                if (i0 !== i1 && (pts[i1].tsMs - pts[i0].tsMs) > 20000) continue;

                const x0 = xy[i0][0], y0 = xy[i0][1];
                const x1 = xy[i1][0], y1 = xy[i1][1];
                const dx = x1 - x0, dy = y1 - y0;
                const segLen2 = dx * dx + dy * dy;
                if (i0 !== i1 && segLen2 > 90.0 * 90.0) continue;

                const ar = 0.5 * (pts[i0].ar + pts[i1].ar);
                const trVal = (pts[i0].tr > 0 && pts[i1].tr > 0) ? 0.5 * (pts[i0].tr + pts[i1].tr) : (pts[i0].tr || pts[i1].tr || NaN);
                const wM = 0.5 * (pts[i0].wM + pts[i1].wM);
                const hw = 0.5 * wM + 1.5;
                const hw2 = hw * hw;

                const bx0 = Math.max(0, Math.floor((Math.min(x0, x1) - hw - xmin) / res));
                const bx1 = Math.min(nx - 1, Math.ceil((Math.max(x0, x1) + hw - xmin) / res));
                const by0 = Math.max(0, Math.floor((Math.min(y0, y1) - hw - ymin) / res));
                const by1 = Math.min(ny - 1, Math.ceil((Math.max(y0, y1) + hw - ymin) / res));

                for (let ry = by0; ry <= by1; ry++) {
                    const gy = ymin + (ry + 0.5) * res;
                    const rowOff = ry * nx;
                    for (let cx = bx0; cx <= bx1; cx++) {
                        const gx = xmin + (cx + 0.5) * res;
                        let d2;
                        if (segLen2 < 1e-6) {
                            const ex = gx - x0, ey = gy - y0;
                            d2 = ex * ex + ey * ey;
                        } else {
                            let t = ((gx - x0) * dx + (gy - y0) * dy) / segLen2;
                            if (t < 0) t = 0; else if (t > 1) t = 1;
                            const ex = gx - (x0 + t * dx);
                            const ey = gy - (y0 + t * dy);
                            d2 = ex * ex + ey * ey;
                        }
                        if (d2 <= hw2) {
                            const idx = rowOff + cx;
                            if (d2 < bestDist[idx]) {
                                bestDist[idx] = d2;
                                rateGrid[idx] = ar;
                                if (!Number.isNaN(trVal)) targetGrid[idx] = trVal;
                            }
                        }
                    }
                }
            }
        }

        // Compute Soll GRD metric extent relative to same (lon0, lat0)
        let sollExtentM = null;
        if (item.sollGrd) {
            const g = item.sollGrd;
            const [gx0, gy0] = toXY(g.minLon, g.minLat);
            const [gx1, gy1] = toXY(g.minLon + g.nCols * g.cellLon, g.minLat + g.nRows * g.cellLat);
            sollExtentM = [gx0, gx1, gy0, gy1];
        }

        const result = {
            lon0, lat0,
            outerM, innerM, tracksM,
            xmin, xmax: xmin + nx * res,
            ymin, ymax: ymin + ny * res,
            res, nx, ny,
            rateGrid,
            targetGrid,
            sollExtentM,
        };
        item.rasterCache.set(cacheKey, result);
        return result;
    }

    /**
     * Build German Excel-compatible CSV for all filtered As-Applied & Soll-Ist fields.
     */
    function buildAsAppliedCsv(items) {
        const header = [
            "Nr", "Schlagname", "Kultur", "Datum", "Zeitraum", "Produkt",
            "Schlagflaeche_ha", "Bearbeitet_ha", "Soll_Durchschnitt_kg_ha",
            "Ist_Durchschnitt_kg_ha", "Abweichung_Prozent", "Soll_Gesamt_kg",
            "Ist_Gesamt_kg", "Min_Ist_kg_ha", "Max_Ist_kg_ha",
            "Arbeitsbreite_m", "Wurfweiten_Offset_m", "Soll_GRD_Datei", "TLG_Dateien"
        ];
        const rows = [header.join(";")];
        items.forEach((it, idx) => {
            rows.push([
                idx + 1,
                `"${it.name.replace(/"/g, '""')}"`,
                `"${it.crop.replace(/"/g, '""')}"`,
                `"${it.dateDe}"`,
                `"${it.timeSpan}"`,
                `"${it.productLabel.replace(/"/g, '""')}"`,
                window.AppGeo.fmtDe(it.areaHa, 2),
                window.AppGeo.fmtDe(it.workedHa, 2),
                it.avgSoll !== null ? window.AppGeo.fmtDe(it.avgSoll, 1) : "",
                window.AppGeo.fmtDe(it.avgArPts, 1),
                it.diffPct !== null ? window.AppGeo.fmtDe(it.diffPct, 1) : "",
                it.sollTotalKg !== null ? window.AppGeo.fmtDe(it.sollTotalKg, 0) : "",
                window.AppGeo.fmtDe(it.totKg, 0),
                window.AppGeo.fmtDe(it.minAr, 1),
                window.AppGeo.fmtDe(it.maxAr, 1),
                window.AppGeo.fmtDe(it.modeWidth, 1),
                window.AppGeo.fmtDe(it.avgShiftM, 2),
                it.sollGrd ? `${it.sollGrd.grdName}.BIN` : "",
                `"${it.tlgNames.join(", ")}"`,
            ].join(";"));
        });
        return "\uFEFF" + rows.join("\r\n") + "\r\n";
    }

    return {
        getCropColor,
        parseTaskdataDataset,
        rasterizeAsAppliedField,
        buildAsAppliedCsv,
    };
})();
