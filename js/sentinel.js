/**
 * sentinel.js — Direct browser-side Copernicus Sentinel-2 L2A STAC search & COG window reader.
 * Uses Element84 Earth Search v1 STAC API + AWS S3 Cloud-Optimized GeoTIFFs via geotiff.js
 * with HTTP Range requests (only fetches the tiny field bounding-box tiles, zero backend needed).
 */
window.AppSentinel = (function () {
    "use strict";

    const STAC_URL = "https://earth-search.aws.element84.com/v1/search";

    /**
     * Compute WGS84 bounding box [minLon, minLat, maxLon, maxLat] for all fields with buffer (~500m).
     */
    function computeFieldsBbox(fields, bufferDeg = 0.005) {
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const f of fields) {
            for (const ring of f.outerRings) {
                for (const pt of ring) {
                    if (pt[0] < minLon) minLon = pt[0];
                    if (pt[1] < minLat) minLat = pt[1];
                    if (pt[0] > maxLon) maxLon = pt[0];
                    if (pt[1] > maxLat) maxLat = pt[1];
                }
            }
        }
        return [minLon - bufferDeg, minLat - bufferDeg, maxLon + bufferDeg, maxLat + bufferDeg];
    }

    /**
     * Query Earth Search STAC API for Sentinel-2 L2A scenes in a date range.
     */
    async function searchStacRange(bbox, startIso, endIso, maxCloudPct, signal) {
        const payload = {
            collections: ["sentinel-2-l2a"],
            bbox: bbox,
            datetime: `${startIso}T00:00:00Z/${endIso}T23:59:59Z`,
            query: { "eo:cloud_cover": { lt: maxCloudPct } },
            limit: 80,
        };
        const resp = await fetch(STAC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
        });
        if (!resp.ok) {
            throw new Error(`STAC-Suche fehlgeschlagen (HTTP ${resp.status})`);
        }
        const data = await resp.json();
        const feats = data.features || [];

        // Prefer scenes covering the full bbox; deduplicate by date keeping lowest cloud cover
        const byDateFull = new Map();
        const byDateAny = new Map();
        for (const f of feats) {
            const dt = (f.properties?.datetime || "").slice(0, 10);
            if (!dt) continue;
            const cc = Number(f.properties?.["eo:cloud_cover"] ?? 100);
            const fb = f.bbox || [0, 0, 0, 0];
            const coversFull = (fb[0] <= bbox[0] && fb[1] <= bbox[1] && fb[2] >= bbox[2] && fb[3] >= bbox[3]);

            const targetMap = coversFull ? byDateFull : byDateAny;
            const existing = targetMap.get(dt);
            if (!existing || cc < Number(existing.properties?.["eo:cloud_cover"] ?? 100)) {
                targetMap.set(dt, f);
            }
        }

        const items = byDateFull.size > 0
            ? Array.from(byDateFull.values())
            : Array.from(byDateAny.values());

        items.sort((a, b) =>
            Number(a.properties?.["eo:cloud_cover"] ?? 100) -
            Number(b.properties?.["eo:cloud_cover"] ?? 100)
        );
        return items;
    }

    /**
     * Read Red (B04), NIR (B08), and SCL windows for the farm bbox directly from AWS S3 COGs.
     */
    async function fetchSceneWindow(item, bbox, signal) {
        const assets = item.assets || {};
        const redHref = assets.red?.href;
        const nirHref = assets.nir?.href;
        const sclHref = assets.scl?.href;
        if (!redHref || !nirHref || !sclHref) {
            throw new Error("Szene enthält nicht alle benötigten Bänder (red/nir/scl).");
        }

        // Open COG headers (small HTTP Range requests)
        const [tiffR, tiffN, tiffS] = await Promise.all([
            window.GeoTIFF.fromUrl(redHref, { allowFullFile: false }),
            window.GeoTIFF.fromUrl(nirHref, { allowFullFile: false }),
            window.GeoTIFF.fromUrl(sclHref, { allowFullFile: false }),
        ]);

        const [imgR, imgN, imgS] = await Promise.all([
            tiffR.getImage(),
            tiffN.getImage(),
            tiffS.getImage(),
        ]);

        // Extract UTM EPSG from GeoKeys or STAC item projection metadata
        const geoKeys = imgR.getGeoKeys() || {};
        const epsg = geoKeys.ProjectedCSTypeGeoKey
            || item.properties?.["proj:epsg"]
            || Number(String(item.properties?.["proj:code"] || "").replace("EPSG:", ""));
        const utmInfo = window.AppGeo.parseUtmEpsg(epsg);

        // Project all 4 bbox corners to UTM to handle UTM convergence accurately
        const corners = [
            window.AppGeo.wgs84ToUtm(bbox[0], bbox[1], utmInfo.zone, utmInfo.north),
            window.AppGeo.wgs84ToUtm(bbox[2], bbox[1], utmInfo.zone, utmInfo.north),
            window.AppGeo.wgs84ToUtm(bbox[0], bbox[3], utmInfo.zone, utmInfo.north),
            window.AppGeo.wgs84ToUtm(bbox[2], bbox[3], utmInfo.zone, utmInfo.north),
        ];
        const uxMin = Math.min(...corners.map(c => c[0]));
        const uxMax = Math.max(...corners.map(c => c[0]));
        const uyMin = Math.min(...corners.map(c => c[1]));
        const uyMax = Math.max(...corners.map(c => c[1]));

        // Compute pixel window on 10m Red image
        const [origX, origY] = imgR.getOrigin();
        const [resX, resY] = imgR.getResolution(); // resX > 0 (10), resY < 0 (-10)
        const imgW = imgR.getWidth();
        const imgH = imgR.getHeight();

        const col0 = Math.max(0, Math.floor((uxMin - origX) / resX));
        const col1 = Math.min(imgW, Math.ceil((uxMax - origX) / resX));
        // Note resY is negative: uyMax -> smaller row, uyMin -> larger row
        const row0 = Math.max(0, Math.floor((uyMax - origY) / resY));
        const row1 = Math.min(imgH, Math.ceil((uyMin - origY) / resY));

        const w = col1 - col0;
        const h = row1 - row0;
        if (w <= 2 || h <= 2) {
            throw new Error("Ausschnitt liegt außerhalb der Sentinel-2-Kachel.");
        }

        // Compute matching window on 20m SCL image
        const [sOrigX, sOrigY] = imgS.getOrigin();
        const [sResX, sResY] = imgS.getResolution();
        const sImgW = imgS.getWidth();
        const sImgH = imgS.getHeight();

        const winUxMin = origX + col0 * resX;
        const winUxMax = origX + col1 * resX;
        const winUyMax = origY + row0 * resY;
        const winUyMin = origY + row1 * resY;

        const sCol0 = Math.max(0, Math.floor((winUxMin - sOrigX) / sResX));
        const sCol1 = Math.min(sImgW, Math.ceil((winUxMax - sOrigX) / sResX));
        const sRow0 = Math.max(0, Math.floor((winUyMax - sOrigY) / sResY));
        const sRow1 = Math.min(sImgH, Math.ceil((winUyMin - sOrigY) / sResY));

        // Fetch pixel tiles concurrently via HTTP Range requests
        const [redRas, nirRas, sclRas] = await Promise.all([
            imgR.readRasters({ window: [col0, row0, col1, row1], samples: [0], signal }),
            imgN.readRasters({ window: [col0, row0, col1, row1], samples: [0], signal }),
            imgS.readRasters({
                window: [sCol0, sRow0, sCol1, sRow1],
                width: w,
                height: h,
                resampleMethod: "nearest",
                samples: [0],
                signal,
            }),
        ]);

        const redArr = redRas[0];
        const nirArr = nirRas[0];
        const sclArr = sclRas[0];
        const total = w * h;

        const ndvi = new Float32Array(total);
        const validValues = [];
        let validCount = 0;

        for (let i = 0; i < total; i++) {
            const scl = sclArr[i];
            const rDn = redArr[i];
            const nDn = nirArr[i];
            // SCL 4 = Vegetation, 5 = Not vegetated / bare soil
            if ((scl === 4 || scl === 5) && rDn > 0 && nDn > 0) {
                const rRefl = Math.min(1.0, Math.max(0.001, rDn * 0.0001));
                const nRefl = Math.min(1.0, Math.max(0.001, nDn * 0.0001));
                const v = (nRefl - rRefl) / (nRefl + rRefl + 1e-6);
                ndvi[i] = v;
                validCount++;
                // Subsample for fast median estimate if huge
                if (total <= 120000 || (i & 3) === 0) validValues.push(v);
            } else {
                ndvi[i] = NaN;
            }
        }

        const validFrac = validCount / total;
        let ndviMed = NaN;
        if (validValues.length > 0) {
            validValues.sort((a, b) => a - b);
            ndviMed = window.AppGeo.percentileSorted(validValues, 50);
        }

        // Affine transform matching rasterio window_transform:
        // x = a * col + c, y = e * row + f
        return {
            date: item.properties.datetime.slice(0, 10),
            year: Number(item.properties.datetime.slice(0, 4)),
            id: item.id,
            sceneCloudPct: Number(item.properties?.["eo:cloud_cover"] ?? 0),
            validPct: validFrac * 100.0,
            ndviMedian: ndviMed,
            utmZone: utmInfo.zone,
            utmNorth: utmInfo.north,
            epsg: utmInfo.epsg,
            transform: [resX, 0, winUxMin, 0, resY, winUyMax],
            width: w,
            height: h,
            ndvi,
        };
    }

    /**
     * Fetch cloud-free Sentinel-2 scenes according to mode:
     *   - "multiyear": 3 years (e.g. 2024–2026), Mar 15–Jul 15, up to 4 scenes/year >= 18 days apart
     *   - "latest":    most recent 1–3 cloud-free scenes (last 180 days, active vegetation)
     *   - "singleyear": specific single year (Mar 15–Jul 15, up to 4 scenes)
     */
    async function fetchScenesForFields(fields, options, onProgress, signal) {
        const bbox = computeFieldsBbox(fields, 0.005);
        const mode = options.mode || "multiyear";
        const nowYear = new Date().getFullYear();
        // Ensure we include up to 2026 or current year
        const maxYear = Math.min(nowYear, 2026);
        const selected = [];

        const report = (pct, msg) => {
            if (typeof onProgress === "function") onProgress(pct, msg);
        };

        if (mode === "latest") {
            report(5, "Suche aktuellste wolkenfreie Sentinel-2-Aufnahmen…");
            const endDate = new Date();
            const startDate = new Date(endDate.getTime() - 210 * 86400000);
            const fmtIso = (d) => d.toISOString().slice(0, 10);
            const items = await searchStacRange(bbox, fmtIso(startDate), fmtIso(endDate), 35, signal);
            // Sort newest first (with low cloud tie-breaker)
            items.sort((a, b) => {
                const da = a.properties.datetime.slice(0, 10);
                const db = b.properties.datetime.slice(0, 10);
                return db.localeCompare(da);
            });
            report(15, `${items.length} aktuelle Kandidaten gefunden – prüfe Wolkenfreiheit über den Schlägen…`);

            const maxTry = Math.min(items.length, 15);
            for (let i = 0; i < maxTry && selected.length < 3; i++) {
                if (signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
                const it = items[i];
                const dt = it.properties.datetime.slice(0, 10);
                const cc = Number(it.properties?.["eo:cloud_cover"] ?? 0);
                report(15 + Math.round((i / Math.max(1, maxTry)) * 75),
                    `Lade Ausschnitt ${window.AppGeo.fmtDateDe(dt)} (Kachel-Wolken ${cc.toFixed(1)} %)…`);
                try {
                    const sc = await fetchSceneWindow(it, bbox, signal);
                    if (sc.validPct >= 88.0 && sc.ndviMedian >= 0.22 && sc.ndviMedian <= 0.92) {
                        selected.push(sc);
                    }
                } catch (err) {
                    if (err.name === "AbortError") throw err;
                    console.warn("Szene übersprungen:", dt, err);
                }
            }
        } else {
            const years = mode === "singleyear"
                ? [Number(options.singleYear || maxYear)]
                : [maxYear - 2, maxYear - 1, maxYear];

            const totalYears = years.length;
            const maxPerYear = mode === "singleyear" ? 4 : 4;

            for (let yi = 0; yi < totalYears; yi++) {
                if (signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
                const year = years[yi];
                const basePct = Math.round((yi / totalYears) * 90);
                const yearSpanPct = Math.round(90 / totalYears);

                report(basePct + 2, `Suche Sentinel-2-Szenen für ${year} (März–Juli)…`);
                let items = [];
                try {
                    items = await searchStacRange(bbox, `${year}-03-15`, `${year}-07-15`, 40, signal);
                } catch (err) {
                    if (err.name === "AbortError") throw err;
                    console.warn("STAC-Fehler Jahr", year, err);
                    continue;
                }

                const pickedYear = [];
                const maxChecks = Math.min(items.length, 12);
                let checked = 0;

                for (const it of items) {
                    if (signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
                    if (pickedYear.length >= maxPerYear || checked >= maxChecks) break;

                    const dt = it.properties.datetime.slice(0, 10);
                    const tCur = Date.parse(dt);
                    const tooClose = pickedYear.some(p => Math.abs(tCur - Date.parse(p.date)) < 18 * 86400000);
                    if (tooClose) continue;

                    checked++;
                    const cc = Number(it.properties?.["eo:cloud_cover"] ?? 0);
                    const prog = basePct + 5 + Math.round((checked / Math.max(1, maxChecks)) * (yearSpanPct - 8));
                    report(prog, `Jahr ${year}: Lade ${window.AppGeo.fmtDateDe(dt)} (${cc.toFixed(1)} % Wolken, ${selected.length} gültig)…`);

                    try {
                        const sc = await fetchSceneWindow(it, bbox, signal);
                        if (sc.validPct >= 90.0 && sc.ndviMedian >= 0.25 && sc.ndviMedian <= 0.90) {
                            pickedYear.push(sc);
                            selected.push(sc);
                        }
                    } catch (err) {
                        if (err.name === "AbortError") throw err;
                        console.warn("Szene übersprungen:", dt, err);
                    }
                }
            }
        }

        selected.sort((a, b) => a.date.localeCompare(b.date));
        report(96, `${selected.length} wolkenfreie Sentinel-2-Szenen erfolgreich geladen.`);
        return selected;
    }

    return {
        computeFieldsBbox,
        fetchScenesForFields,
    };
})();
