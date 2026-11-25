/**
 * prescription.js — Parse TASKDATA.XML/.zip, compute multi-year Sentinel-2 biomass zones
 * with 10m edge-pixel filtering, apply fertilizer strategies, and build & verify
 * RAUCH / CC-Isobus v4.0-compatible ISOXML v4.2 TASKDATA packages.
 */
window.AppPrescription = (function () {
    "use strict";

    const DEG2RAD = Math.PI / 180.0;

    /**
     * XML-escape an attribute value safely.
     */
    function escXml(str) {
        return String(str ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    /**
     * Parse an uploaded File (.zip or .xml) and extract CTR, FRM, and PFD fields.
     */
    async function parseUploadedFile(file) {
        let xmlText = "";
        let sourceName = file.name;

        if (file.name.toLowerCase().endsWith(".zip")) {
            const zip = await window.JSZip.loadAsync(file);
            let xmlEntry = null;
            zip.forEach((relPath, entry) => {
                if (entry.dir) return;
                const base = relPath.split("/").pop().toUpperCase();
                if (base === "TASKDATA.XML" && !xmlEntry) {
                    xmlEntry = entry;
                }
            });
            if (!xmlEntry) {
                // Fallback: any .xml file containing ISO11783_TaskData
                const xmlCandidates = [];
                zip.forEach((relPath, entry) => {
                    if (!entry.dir && relPath.toLowerCase().endsWith(".xml")) {
                        xmlCandidates.push(entry);
                    }
                });
                for (const c of xmlCandidates) {
                    const txt = await c.async("string");
                    if (txt.includes("ISO11783_TaskData")) {
                        xmlText = txt;
                        break;
                    }
                }
                if (!xmlText) {
                    throw new Error("In der ZIP-Datei wurde keine TASKDATA.XML gefunden.");
                }
            } else {
                xmlText = await xmlEntry.async("string");
            }
        } else if (file.name.toLowerCase().endsWith(".xml")) {
            xmlText = await file.text();
        } else {
            throw new Error("Bitte eine TASKDATA.XML oder eine ZIP-Datei (z. B. export.zip) auswählen.");
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, "application/xml");
        const parseErr = doc.querySelector("parsererror");
        if (parseErr) {
            throw new Error("Die TASKDATA.XML konnte nicht gelesen werden (ungültiges XML).");
        }

        const root = doc.documentElement;
        if (!root || root.tagName !== "ISO11783_TaskData") {
            throw new Error("Die Datei ist keine gültige ISO11783 TASKDATA.XML.");
        }

        // Extract CTR & FRM attributes (first ones found)
        const ctrEl = root.querySelector(":scope > CTR");
        const frmEl = root.querySelector(":scope > FRM");
        const ctrAttrs = {};
        if (ctrEl) {
            for (const a of ctrEl.attributes) ctrAttrs[a.name] = a.value;
        }
        const frmAttrs = {};
        if (frmEl) {
            for (const a of frmEl.attributes) frmAttrs[a.name] = a.value;
        }

        const farmName = frmAttrs.B
            || [ctrAttrs.C, ctrAttrs.B].filter(Boolean).join(" ")
            || "Landwirtschaftlicher Betrieb";

        // Extract all PFD (Partfield) elements with polygon geometry
        const pfdEls = Array.from(root.querySelectorAll(":scope > PFD"));
        const fields = [];
        for (let i = 0; i < pfdEls.length; i++) {
            const pfd = pfdEls[i];
            const outerRings = [];
            const innerRings = [];

            const plns = Array.from(pfd.querySelectorAll(":scope > PLN"));
            for (const pln of plns) {
                // Only use Partfield Boundary (A="1") or unspecified, ignore Guidance/Obstacles unless only PLN
                const plnType = pln.getAttribute("A");
                if (plnType && plnType !== "1" && plnType !== "2" && plns.length > 1) {
                    continue;
                }
                const lsgs = Array.from(pln.querySelectorAll(":scope > LSG"));
                for (const lsg of lsgs) {
                    const pnts = Array.from(lsg.querySelectorAll(":scope > PNT"));
                    const pts = [];
                    for (const p of pnts) {
                        const lat = parseFloat(p.getAttribute("C"));
                        const lon = parseFloat(p.getAttribute("D"));
                        if (Number.isFinite(lat) && Number.isFinite(lon)) {
                            pts.push([lon, lat]); // [lon, lat]
                        }
                    }
                    if (pts.length >= 3) {
                        if (lsg.getAttribute("A") === "2") {
                            innerRings.push(pts);
                        } else {
                            outerRings.push(pts);
                        }
                    }
                }
            }

            if (outerRings.length === 0) continue;

            const origId = pfd.getAttribute("A") || `PFD${i + 1}`;
            const name = (pfd.getAttribute("C") || origId).trim();
            let areaM2 = parseInt(pfd.getAttribute("D") || "0", 10);
            if (!Number.isFinite(areaM2) || areaM2 <= 0) {
                areaM2 = Math.round(window.AppGeo.computePolygonAreaM2(outerRings, innerRings));
            }

            // Compute centroid
            let sumLon = 0, sumLat = 0, cnt = 0;
            for (const r of outerRings) {
                for (const p of r) { sumLon += p[0]; sumLat += p[1]; cnt++; }
            }

            fields.push({
                uid: `f_${i}_${origId}`,
                origId,
                name,
                areaM2,
                areaHa: areaM2 / 10000.0,
                outerRings,
                innerRings,
                centerLon: sumLon / Math.max(1, cnt),
                centerLat: sumLat / Math.max(1, cnt),
                selected: true,
            });
        }

        if (fields.length === 0) {
            throw new Error("In der TASKDATA.XML wurden keine Schläge mit Schlaggrenzen (PFD/PLN) gefunden.");
        }

        return {
            sourceName,
            farmName,
            ctrAttrs,
            frmAttrs,
            fields,
        };
    }

    /**
     * Gentle 3x3 Gaussian smoothing strictly inside `mask` (matches Python gaussian_smooth_nan).
     */
    function gaussianSmoothNan(arr, mask, nRows, nCols) {
        const k = [
            [1, 2, 1],
            [2, 4, 2],
            [1, 2, 1],
        ];
        const out = new Float64Array(nRows * nCols);
        out.fill(NaN);

        for (let r = 0; r < nRows; r++) {
            for (let c = 0; c < nCols; c++) {
                const idx = r * nCols + c;
                if (!mask[idx]) continue;
                let num = 0.0, den = 0.0;
                for (let dy = -1; dy <= 1; dy++) {
                    const rr = r + dy;
                    if (rr < 0 || rr >= nRows) continue;
                    const rowOff = rr * nCols;
                    for (let dx = -1; dx <= 1; dx++) {
                        const cc = c + dx;
                        if (cc < 0 || cc >= nCols) continue;
                        const nIdx = rowOff + cc;
                        if (mask[nIdx]) {
                            const val = arr[nIdx];
                            if (!Number.isNaN(val)) {
                                const w = k[dy + 1][dx + 1];
                                num += w * val;
                                den += w;
                            }
                        }
                    }
                }
                if (den > 0) out[idx] = num / den;
            }
        }
        return out;
    }

    /**
     * Stage 1 (cached): Build WGS84 ISOXML grid for a field, sample Sentinel-2 scenes,
     * normalize per year on clean interior (core_mask), smooth, and propagate to rim pixels.
     */
    function computeFieldBiomass(field, scenes, options) {
        const cellSizeM = Number(options.cellSizeM || 10.0);
        const useEdgeFilter = options.edgeFilter !== false;

        let minLonRaw = Infinity, maxLonRaw = -Infinity;
        let minLatRaw = Infinity, maxLatRaw = -Infinity;
        for (const r of field.outerRings) {
            for (const p of r) {
                if (p[0] < minLonRaw) minLonRaw = p[0];
                if (p[0] > maxLonRaw) maxLonRaw = p[0];
                if (p[1] < minLatRaw) minLatRaw = p[1];
                if (p[1] > maxLatRaw) maxLatRaw = p[1];
            }
        }
        const lon0 = 0.5 * (minLonRaw + maxLonRaw);
        const lat0 = 0.5 * (minLatRaw + maxLatRaw);
        const cosLat = Math.cos(lat0 * DEG2RAD);

        const cellLat = cellSizeM / 110540.0;
        const cellLon = cellSizeM / (111320.0 * cosLat);

        const minLat = minLatRaw - cellLat * 0.5;
        const maxLat = maxLatRaw + cellLat * 0.5;
        const minLon = minLonRaw - cellLon * 0.5;
        const maxLon = maxLonRaw + cellLon * 0.5;

        const nCols = Math.max(1, Math.ceil((maxLon - minLon) / cellLon));
        const nRows = Math.max(1, Math.ceil((maxLat - minLat) / cellLat));
        const total = nRows * nCols;

        const cLons = new Float64Array(nCols);
        const cLats = new Float64Array(nRows);
        const cxM = new Float64Array(nCols);
        const cyM = new Float64Array(nRows);
        for (let c = 0; c < nCols; c++) {
            cLons[c] = minLon + (c + 0.5) * cellLon;
            cxM[c] = (cLons[c] - lon0) * 111320.0 * cosLat;
        }
        for (let r = 0; r < nRows; r++) {
            cLats[r] = minLat + (r + 0.5) * cellLat;
            cyM[r] = (cLats[r] - lat0) * 110540.0;
        }

        const outerM = field.outerRings.map(r => window.AppGeo.projectRingToLocalMeters(r, lon0, lat0));
        const innerM = field.innerRings.map(r => window.AppGeo.projectRingToLocalMeters(r, lon0, lat0));

        // Inside polygon mask (row 0 = South -> row nRows-1 = North, col 0 = West -> col nCols-1 = East)
        const insideMask = new Uint8Array(total);
        let insideCount = 0;
        for (let r = 0; r < nRows; r++) {
            const py = cyM[r];
            const rowOff = r * nCols;
            for (let c = 0; c < nCols; c++) {
                const px = cxM[c];
                let inside = false;
                for (let k = 0; k < outerM.length; k++) {
                    if (window.AppGeo.pointInRing(px, py, outerM[k])) {
                        inside = true;
                        break;
                    }
                }
                if (inside && innerM.length > 0) {
                    for (let k = 0; k < innerM.length; k++) {
                        if (window.AppGeo.pointInRing(px, py, innerM[k])) {
                            inside = false;
                            break;
                        }
                    }
                }
                if (inside) {
                    insideMask[rowOff + c] = 1;
                    insideCount++;
                }
            }
        }

        // Fallback if tiny polygon missed all cell centers: mark center cell
        if (insideCount === 0) {
            const cr = Math.floor(nRows / 2);
            const cc = Math.floor(nCols / 2);
            insideMask[cr * nCols + cc] = 1;
            insideCount = 1;
        }

        // 1-cell border dilation & 1-cell interior erosion (4-neighborhood)
        const dilatedMask = new Uint8Array(total);
        const erodedMask = new Uint8Array(total);
        let erodedCount = 0;

        for (let r = 0; r < nRows; r++) {
            const rowOff = r * nCols;
            for (let c = 0; c < nCols; c++) {
                const idx = rowOff + c;
                const center = insideMask[idx];
                const up = r + 1 < nRows ? insideMask[(r + 1) * nCols + c] : 0;
                const dn = r - 1 >= 0 ? insideMask[(r - 1) * nCols + c] : 0;
                const lf = c - 1 >= 0 ? insideMask[rowOff + c - 1] : 0;
                const rt = c + 1 < nCols ? insideMask[rowOff + c + 1] : 0;

                if (center || up || dn || lf || rt) {
                    dilatedMask[idx] = 1;
                }
                if (center && up && dn && lf && rt) {
                    erodedMask[idx] = 1;
                    erodedCount++;
                }
            }
        }

        const useCore = useEdgeFilter && (erodedCount >= Math.max(12, 0.25 * insideCount));
        const coreMask = useCore ? erodedMask : insideMask;
        const coreCount = useCore ? erodedCount : insideCount;

        // Precompute UTM cell coordinates per distinct EPSG used by scenes
        const utmCache = new Map();
        function getUtmGrid(zone, north, epsg) {
            if (utmCache.has(epsg)) return utmCache.get(epsg);
            const ux = new Float64Array(total);
            const uy = new Float64Array(total);
            for (let r = 0; r < nRows; r++) {
                const lat = cLats[r];
                const rowOff = r * nCols;
                for (let c = 0; c < nCols; c++) {
                    const [e, n] = window.AppGeo.wgs84ToUtm(cLons[c], lat, zone, north);
                    ux[rowOff + c] = e;
                    uy[rowOff + c] = n;
                }
            }
            const obj = { ux, uy };
            utmCache.set(epsg, obj);
            return obj;
        }

        // Sample each Sentinel-2 scene & normalize per year strictly on coreMask
        const zByYear = new Map();
        const usedScenes = [];
        const rawNdviSum = new Float64Array(total);
        const rawNdviCnt = new Uint16Array(total);

        for (const sc of scenes) {
            const { ux, uy } = getUtmGrid(sc.utmZone, sc.utmNorth, sc.epsg);
            const [a, , cTr, , e, fTr] = sc.transform;
            const sw = sc.width;
            const sh = sc.height;
            const sampled = new Float64Array(total);
            sampled.fill(NaN);

            const validIn = [];
            for (let idx = 0; idx < total; idx++) {
                if (!dilatedMask[idx]) continue;
                const sCol = Math.floor((ux[idx] - cTr) / a);
                const sRow = Math.floor((uy[idx] - fTr) / e);
                if (sRow >= 0 && sRow < sh && sCol >= 0 && sCol < sw) {
                    const v = sc.ndvi[sRow * sw + sCol];
                    if (!Number.isNaN(v)) {
                        sampled[idx] = v;
                        if (coreMask[idx]) validIn.push(v);
                    }
                }
            }

            if (validIn.length < Math.max(5, 0.85 * coreCount)) {
                continue;
            }
            const sortedIn = validIn.slice().sort((x, y) => x - y);
            const medNdvi = window.AppGeo.percentileSorted(sortedIn, 50);
            if (medNdvi < 0.25) continue; // Skip bare soil / stubble scenes

            let sum = 0;
            for (let i = 0; i < validIn.length; i++) sum += validIn[i];
            const mu = sum / validIn.length;
            let varSum = 0;
            for (let i = 0; i < validIn.length; i++) {
                const d = validIn[i] - mu;
                varSum += d * d;
            }
            const std = Math.sqrt(varSum / validIn.length);
            if (std < 0.008) continue;

            const zMap = new Float64Array(total);
            for (let idx = 0; idx < total; idx++) {
                const v = sampled[idx];
                if (Number.isNaN(v)) {
                    zMap[idx] = NaN;
                } else {
                    const z = (v - mu) / std;
                    zMap[idx] = Math.max(-2.5, Math.min(2.5, z));
                    rawNdviSum[idx] += v;
                    rawNdviCnt[idx] += 1;
                }
            }

            if (!zByYear.has(sc.year)) zByYear.set(sc.year, []);
            zByYear.get(sc.year).push(zMap);
            usedScenes.push({
                date: sc.date,
                year: sc.year,
                ndviMed: Number(medNdvi.toFixed(3)),
            });
        }

        // Equal-weight multi-year composite
        const yearsUsed = Array.from(zByYear.keys()).sort((a, b) => a - b);
        const multiyearZ = new Float64Array(total);
        multiyearZ.fill(NaN);

        if (yearsUsed.length > 0) {
            const yearMeans = yearsUsed.map(yr => {
                const maps = zByYear.get(yr);
                const ym = new Float64Array(total);
                for (let idx = 0; idx < total; idx++) {
                    let s = 0, cnt = 0;
                    for (let m = 0; m < maps.length; m++) {
                        const v = maps[m][idx];
                        if (!Number.isNaN(v)) { s += v; cnt++; }
                    }
                    ym[idx] = cnt > 0 ? s / cnt : NaN;
                }
                return ym;
            });

            for (let idx = 0; idx < total; idx++) {
                let s = 0, cnt = 0;
                for (let y = 0; y < yearMeans.length; y++) {
                    const v = yearMeans[y][idx];
                    if (!Number.isNaN(v)) { s += v; cnt++; }
                }
                multiyearZ[idx] = cnt > 0 ? s / cnt : NaN;
            }
        } else {
            // Fallback if no cloud-free active scenes for this field
            for (let idx = 0; idx < total; idx++) {
                if (insideMask[idx]) multiyearZ[idx] = 0.0;
            }
        }

        // Smooth strictly inside coreMask, then propagate outward to mixed rim pixels
        const smoothCore = gaussianSmoothNan(multiyearZ, coreMask, nRows, nCols);
        const smoothZ = new Float64Array(total);
        smoothZ.fill(NaN);

        const coreCoords = [];
        for (let r = 0; r < nRows; r++) {
            const rowOff = r * nCols;
            for (let c = 0; c < nCols; c++) {
                const idx = rowOff + c;
                if (coreMask[idx]) {
                    const v = Number.isNaN(smoothCore[idx]) ? 0.0 : smoothCore[idx];
                    smoothZ[idx] = v;
                    coreCoords.push([r, c, v]);
                }
            }
        }

        // Propagate nearest core value to rim cells (insideMask & !coreMask)
        if (coreCoords.length > 0) {
            for (let r = 0; r < nRows; r++) {
                const rowOff = r * nCols;
                for (let c = 0; c < nCols; c++) {
                    const idx = rowOff + c;
                    if (insideMask[idx] && !coreMask[idx]) {
                        let bestD2 = Infinity;
                        let bestVal = 0.0;
                        for (let k = 0; k < coreCoords.length; k++) {
                            const dr = coreCoords[k][0] - r;
                            const dc = coreCoords[k][1] - c;
                            const d2 = dr * dr + dc * dc;
                            if (d2 < bestD2) {
                                bestD2 = d2;
                                bestVal = coreCoords[k][2];
                                if (d2 <= 1) break;
                            }
                        }
                        smoothZ[idx] = bestVal;
                    }
                }
            }
        }

        // Average NDVI strictly inside coreMask
        let ndviSumCore = 0, ndviCntCore = 0;
        for (let idx = 0; idx < total; idx++) {
            if (coreMask[idx] && rawNdviCnt[idx] > 0) {
                ndviSumCore += rawNdviSum[idx] / rawNdviCnt[idx];
                ndviCntCore++;
            }
        }
        const fieldNdviAvg = ndviCntCore > 0 ? ndviSumCore / ndviCntCore : NaN;

        const gx0 = (minLon - lon0) * 111320.0 * cosLat;
        const gx1 = (minLon + nCols * cellLon - lon0) * 111320.0 * cosLat;
        const gy0 = (minLat - lat0) * 110540.0;
        const gy1 = (minLat + nRows * cellLat - lat0) * 110540.0;

        return {
            field,
            cellSizeM,
            lon0,
            lat0,
            minLat,
            minLon,
            cellLat,
            cellLon,
            nCols,
            nRows,
            outerM,
            innerM,
            extentM: [gx0, gx1, gy0, gy1],
            insideMask,
            dilatedMask,
            coreMask,
            insideCount,
            smoothZ,
            meanNdviAvg: fieldNdviAvg,
            usedScenes,
            yearsUsed,
        };
    }

    /**
     * Compute discrete ascending rate levels for the given config.
     */
    function computeZoneRates(config) {
        const strategy = config.strategy || "balance";
        const target = Math.max(0, Number(config.targetRate) || 300);
        if (strategy === "uniform") {
            return [Math.round(target)];
        }
        const nZones = Math.max(3, Math.min(7, Number(config.numZones) || 5));
        let minR = Math.max(0, Number(config.minRate));
        let maxR = Math.max(0, Number(config.maxRate));
        if (!Number.isFinite(minR)) minR = Math.max(0, target - 40);
        if (!Number.isFinite(maxR)) maxR = target + 40;
        if (minR > maxR) [minR, maxR] = [maxR, minR];

        const mid = 0.5 * (minR + maxR);
        const rates = [];
        const half = (nZones - 1) / 2;

        if (Math.abs(target - mid) < 0.5 || target <= minR || target >= maxR) {
            // Symmetric linear spacing
            for (let i = 0; i < nZones; i++) {
                const t = nZones === 1 ? 0.5 : i / (nZones - 1);
                rates.push(Math.round(minR + t * (maxR - minR)));
            }
        } else {
            // Piecewise linear through min -> target -> max so center zone = targetRate
            for (let i = 0; i < nZones; i++) {
                if (i <= half) {
                    const t = i / half;
                    rates.push(Math.round(minR + t * (target - minR)));
                } else {
                    const t = (i - half) / half;
                    rates.push(Math.round(target + t * (maxR - target)));
                }
            }
        }
        return rates;
    }

    /**
     * Stage 2 (instantaneous): Classify cached biomass grid into fertilizer rate grid & stats.
     */
    function applyStrategyToField(bio, config, index1Based) {
        const { nRows, nCols, insideMask, dilatedMask, smoothZ, field } = bio;
        const total = nRows * nCols;
        const strategy = config.strategy || "balance";
        const zoneRates = computeZoneRates(config); // ascending [min ... max]
        const nZones = zoneRates.length;

        const rateGrid = new Float64Array(total);
        rateGrid.fill(0.0);

        if (strategy === "uniform" || nZones === 1 || bio.usedScenes.length === 0) {
            const rConst = Math.round(Number(config.targetRate) || zoneRates[Math.floor(nZones / 2)]);
            for (let idx = 0; idx < total; idx++) {
                if (insideMask[idx]) rateGrid[idx] = rConst;
            }
        } else {
            // Collect sorted smoothZ inside polygon
            const valsIn = [];
            for (let idx = 0; idx < total; idx++) {
                if (insideMask[idx]) {
                    valsIn.push(Number.isNaN(smoothZ[idx]) ? 0.0 : smoothZ[idx]);
                }
            }
            valsIn.sort((a, b) => a - b);

            const thresholds = [];
            for (let k = 1; k < nZones; k++) {
                thresholds.push(window.AppGeo.percentileSorted(valsIn, (k * 100.0) / nZones));
            }

            // Map quantile bin 0..nZones-1 (0 = weakest biomass, nZones-1 = strongest biomass)
            // balance:   weakest -> max rate (index nZones-1), strongest -> min rate (index 0)
            // potential: weakest -> min rate (index 0),        strongest -> max rate (index nZones-1)
            for (let idx = 0; idx < total; idx++) {
                if (!insideMask[idx]) continue;
                const z = Number.isNaN(smoothZ[idx]) ? 0.0 : smoothZ[idx];
                let bin = 0;
                while (bin < thresholds.length && z > thresholds[bin]) bin++;
                const rateIdx = strategy === "potential" ? bin : (nZones - 1 - bin);
                rateGrid[idx] = zoneRates[rateIdx];
            }
        }

        // Border dilation: assign nearest inside rate to cells touching boundary
        // so spreader never drops to 0 kg/ha along the exact field edge
        const insideCoords = [];
        for (let r = 0; r < nRows; r++) {
            const rowOff = r * nCols;
            for (let c = 0; c < nCols; c++) {
                const idx = rowOff + c;
                if (insideMask[idx]) insideCoords.push([r, c, rateGrid[idx]]);
            }
        }
        for (let r = 0; r < nRows; r++) {
            const rowOff = r * nCols;
            for (let c = 0; c < nCols; c++) {
                const idx = rowOff + c;
                if (dilatedMask[idx] && !insideMask[idx]) {
                    let bestD2 = Infinity;
                    let bestRate = zoneRates[Math.floor(nZones / 2)];
                    for (let k = 0; k < insideCoords.length; k++) {
                        const dr = insideCoords[k][0] - r;
                        const dc = insideCoords[k][1] - c;
                        const d2 = dr * dr + dc * dc;
                        if (d2 < bestD2) {
                            bestD2 = d2;
                            bestRate = insideCoords[k][2];
                            if (d2 <= 1) break;
                        }
                    }
                    rateGrid[idx] = bestRate;
                }
            }
        }

        // Convert to ISOXML GRD Type 2 int32 values (0.01 kg/ha = mg/m^2)
        const grdInt32 = new Int32Array(total);
        for (let idx = 0; idx < total; idx++) {
            grdInt32[idx] = Math.round(rateGrid[idx] * 100.0);
        }

        // Compute exact field statistics strictly inside polygon
        const zoneCounts = new Map();
        for (const r of zoneRates) zoneCounts.set(r, 0);
        let rateSum = 0;
        let totIn = 0;
        for (let idx = 0; idx < total; idx++) {
            if (!insideMask[idx]) continue;
            const v = rateGrid[idx];
            rateSum += v;
            totIn++;
            zoneCounts.set(v, (zoneCounts.get(v) || 0) + 1);
        }

        const avgRate = totIn > 0 ? rateSum / totIn : 0;
        const totalKg = avgRate * field.areaHa;
        const startId = Math.max(1, parseInt(config.startId, 10) || 501);
        const numId = startId + (index1Based - 1);
        const grdName = "GRD" + String(numId).padStart(5, "0");

        return {
            bio,
            field,
            zoneRates,
            rateGrid,
            grdInt32,
            avgRate,
            totalKg,
            zoneCounts,
            totIn,
            numId,
            pfdId: `PFD${numId}`,
            tskId: `TSK${numId}`,
            grdName,
            grdBytes: total * 4,
        };
    }

    /**
     * Build RAUCH / CC-Isobus v4.0-compatible ISOXML v4.2 TASKDATA.XML + GRD*.BIN files,
     * verify round-trip integrity, and package into a downloadable TASKDATA.zip.
     */
    async function buildIsoxmlZip(farmMeta, results, config) {
        const startId = Math.max(1, parseInt(config.startId, 10) || 501);
        const ctrId = `CTR${startId}`;
        const frmId = `FRM${startId}`;
        const vpnId = `VPN${startId}`;
        const cpcId = `CPC${startId}`;
        const pdtId = `PDT${startId}`;
        const productName = (config.productName || "Kalkammonsalpeter (KAS)").trim();
        const taskPrefix = (config.taskPrefix || "KAS").trim();

        const lines = [];
        lines.push('<?xml version="1.0" encoding="UTF-8"?>');
        lines.push('<ISO11783_TaskData VersionMajor="4" VersionMinor="2" ManagementSoftwareManufacturer="udomi" ManagementSoftwareVersion="1.0.0" DataTransferOrigin="1" DataTransferLanguage="de-DE">');

        // Customer (CTR)
        const ctr = Object.assign({}, farmMeta.ctrAttrs || {});
        ctr.A = ctrId;
        if (!ctr.B) ctr.B = farmMeta.farmName || "Betrieb";
        const ctrAttrStr = Object.entries(ctr)
            .map(([k, v]) => `${k}="${escXml(v)}"`)
            .join(" ");
        lines.push(`    <CTR ${ctrAttrStr} />`);

        // Farm (FRM)
        const frm = Object.assign({}, farmMeta.frmAttrs || {});
        frm.A = frmId;
        if (!frm.B) frm.B = farmMeta.farmName || "Betrieb";
        frm.I = ctrId;
        const frmAttrStr = Object.entries(frm)
            .map(([k, v]) => `${k}="${escXml(v)}"`)
            .join(" ");
        lines.push(`    <FRM ${frmAttrStr} />`);

        // Value Presentation, Cultural Practice, Product
        lines.push(`    <VPN A="${vpnId}" B="0" C="0.01" D="2" E="kg/ha" />`);
        lines.push(`    <CPC A="${cpcId}" B="Düngung" />`);
        lines.push(`    <PDT A="${pdtId}" B="${escXml(productName)}" F="1" />`);

        // Partfields (PFD) with exact original boundaries
        for (const res of results) {
            const f = res.field;
            lines.push(`    <PFD A="${res.pfdId}" C="${escXml(f.name)}" D="${f.areaM2}" E="${ctrId}" F="${frmId}">`);
            lines.push(`        <PLN A="1" B="${escXml(f.name)}" C="0">`);
            for (const ring of f.outerRings) {
                lines.push('            <LSG A="1">');
                for (const pt of ring) {
                    lines.push(`                <PNT A="2" C="${pt[1]}" D="${pt[0]}" />`);
                }
                lines.push('            </LSG>');
            }
            for (const hole of f.innerRings) {
                lines.push('            <LSG A="2">');
                for (const pt of hole) {
                    lines.push(`                <PNT A="2" C="${pt[1]}" D="${pt[0]}" />`);
                }
                lines.push('            </LSG>');
            }
            lines.push('        </PLN>');
            lines.push('    </PFD>');
        }

        // Tasks (TSK) + Binary GRD Buffers (strict Little-Endian Int32)
        const grdBuffers = new Map();
        for (const res of results) {
            const b = res.bio;
            const total = b.nRows * b.nCols;
            const buf = new ArrayBuffer(total * 4);
            const dv = new DataView(buf);
            for (let i = 0; i < total; i++) {
                dv.setInt32(i * 4, res.grdInt32[i], true); // true = Little-Endian
            }
            const bytes = new Uint8Array(buf);
            grdBuffers.set(`${res.grdName}.BIN`, bytes);

            const defaultInt = Math.round(res.avgRate * 100.0);
            const tskName = (taskPrefix ? `${taskPrefix} / ${res.field.name}` : res.field.name).slice(0, 32);

            lines.push(`    <TSK A="${res.tskId}" B="${escXml(tskName)}" C="${ctrId}" D="${frmId}" E="${res.pfdId}" G="1" H="1" I="3" J="2">`);
            lines.push(`        <GRD A="${b.minLat.toFixed(13)}" B="${b.minLon.toFixed(13)}" C="${b.cellLat.toFixed(14)}" D="${b.cellLon.toFixed(14)}" E="${b.nCols}" F="${b.nRows}" G="${res.grdName}" H="${bytes.byteLength}" I="2" J="4" />`);
            lines.push('        <TZN A="1" B="Default">');
            lines.push(`            <PDV A="0006" B="${defaultInt}" C="${pdtId}" E="${vpnId}" />`);
            lines.push('        </TZN>');
            lines.push('        <TZN A="2" B="OutOfField">');
            lines.push(`            <PDV A="0006" B="0" C="${pdtId}" E="${vpnId}" />`);
            lines.push('        </TZN>');
            lines.push('        <TZN A="3" B="PositionLost">');
            lines.push(`            <PDV A="0006" B="${defaultInt}" C="${pdtId}" E="${vpnId}" />`);
            lines.push('        </TZN>');
            lines.push('        <TZN A="4" B="Precision Application">');
            lines.push(`            <PDV A="0006" B="${defaultInt}" C="${pdtId}" E="${vpnId}" />`);
            lines.push('        </TZN>');
            lines.push(`        <OTP A="${cpcId}" />`);
            lines.push(`        <PAN A="${pdtId}" />`);
            lines.push('    </TSK>');
        }

        lines.push('</ISO11783_TaskData>');
        const xmlText = lines.join("\n") + "\n";

        // Round-trip verification before creating ZIP
        const verDoc = new DOMParser().parseFromString(xmlText, "application/xml");
        if (verDoc.querySelector("parsererror")) {
            throw new Error("ISOXML-Verifikation fehlgeschlagen: XML ungültig.");
        }
        const verRoot = verDoc.documentElement;
        const verTsks = Array.from(verRoot.querySelectorAll(":scope > TSK"));
        const verPfds = new Set(Array.from(verRoot.querySelectorAll(":scope > PFD")).map(e => e.getAttribute("A")));
        if (verTsks.length !== results.length) {
            throw new Error(`ISOXML-Verifikation fehlgeschlagen: ${verTsks.length} statt ${results.length} Aufträge.`);
        }
        for (const tsk of verTsks) {
            if (!verPfds.has(tsk.getAttribute("E"))) {
                throw new Error(`Ungültige PFD-Referenz in ${tsk.getAttribute("A")}`);
            }
            const grd = tsk.querySelector(":scope > GRD");
            const gname = grd.getAttribute("G") + ".BIN";
            const nc = parseInt(grd.getAttribute("E"), 10);
            const nr = parseInt(grd.getAttribute("F"), 10);
            const flen = parseInt(grd.getAttribute("H"), 10);
            const raw = grdBuffers.get(gname);
            if (!raw || raw.byteLength !== flen || flen !== nc * nr * 4) {
                throw new Error(`Byte-Größenfehler in ${gname}`);
            }
        }

        // Package into TASKDATA/ folder inside ZIP
        const zip = new window.JSZip();
        const folder = zip.folder("TASKDATA");
        folder.file("TASKDATA.XML", xmlText);
        for (const [fname, bytes] of grdBuffers.entries()) {
            folder.file(fname, bytes);
        }

        const zipBlob = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
        });

        return {
            zipBlob,
            xmlText,
            taskCount: verTsks.length,
            firstId: results[0]?.tskId || "",
            lastId: results[results.length - 1]?.tskId || "",
        };
    }

    /**
     * Build German Excel-compatible CSV (UTF-8 BOM, semicolon delimiter, decimal comma).
     */
    function buildSummaryCsv(results, config) {
        const rates = results[0]?.zoneRates || computeZoneRates(config);
        const header = [
            "Nr",
            "Schlagname",
            "Auftrag_ID",
            "GRD_Datei",
            "Flaeche_ha",
            "Duenger",
            "Strategie",
            "Ziel_Durchschnitt_kg_ha",
            "Gesamtmenge_kg",
            "Sentinel2_Szenen",
            "Mittlerer_NDVI",
            ...rates.map(r => `Anteil_${r}_kg_ha_Prozent`),
        ];

        const stratLabel = config.strategy === "potential"
            ? "Ertragspotenzial foerdern"
            : (config.strategy === "uniform" ? "Gleichmaessig" : "Bestaende ausgleichen");

        const rows = [header.join(";")];
        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            const b = res.bio;
            const cols = [
                i + 1,
                `"${String(res.field.name).replace(/"/g, '""')}"`,
                res.tskId,
                `${res.grdName}.BIN`,
                window.AppGeo.fmtDe(res.field.areaHa, 2),
                `"${String(config.productName || "").replace(/"/g, '""')}"`,
                `"${stratLabel}"`,
                window.AppGeo.fmtDe(res.avgRate, 1),
                window.AppGeo.fmtDe(res.totalKg, 0),
                b.usedScenes.length,
                Number.isNaN(b.meanNdviAvg) ? "" : window.AppGeo.fmtDe(b.meanNdviAvg, 3),
                ...rates.map(r => {
                    const pct = res.totIn > 0 ? ((res.zoneCounts.get(r) || 0) / res.totIn) * 100.0 : 0;
                    return window.AppGeo.fmtDe(pct, 1);
                }),
            ];
            rows.push(cols.join(";"));
        }

        const totArea = results.reduce((s, r) => s + r.field.areaHa, 0);
        const totKg = results.reduce((s, r) => s + r.totalKg, 0);
        const wAvg = totArea > 0 ? totKg / totArea : 0;
        rows.push([
            "",
            '"GESAMT"',
            "",
            "",
            window.AppGeo.fmtDe(totArea, 2),
            `"${String(config.productName || "").replace(/"/g, '""')}"`,
            `"${stratLabel}"`,
            window.AppGeo.fmtDe(wAvg, 1),
            window.AppGeo.fmtDe(totKg, 0),
            "",
            "",
            ...rates.map(() => ""),
        ].join(";"));

        // UTF-8 BOM so German Excel opens Umlauts cleanly on double-click
        return "\uFEFF" + rows.join("\r\n") + "\r\n";
    }

    return {
        parseUploadedFile,
        computeFieldBiomass,
        computeZoneRates,
        applyStrategyToField,
        buildIsoxmlZip,
        buildSummaryCsv,
    };
})();
