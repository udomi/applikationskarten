/**
 * geo.js — Exact WGS84 <-> UTM projection, polygon math, and German formatting helpers.
 * Zero external dependencies.
 */
window.AppGeo = (function () {
    "use strict";

    // WGS84 ellipsoid constants
    const WGS84_A = 6378137.0;
    const WGS84_F = 1.0 / 298.257223563;
    const WGS84_E2 = WGS84_F * (2.0 - WGS84_F);
    const WGS84_EP2 = WGS84_E2 / (1.0 - WGS84_E2);
    const UTM_K0 = 0.9996;
    const DEG2RAD = Math.PI / 180.0;

    /**
     * Parse EPSG code (e.g. 32632 -> { zone: 32, north: true }).
     */
    function parseUtmEpsg(epsgCode) {
        const code = Number(epsgCode);
        if (code >= 32601 && code <= 32660) {
            return { zone: code - 32600, north: true, epsg: code };
        }
        if (code >= 32701 && code <= 32760) {
            return { zone: code - 32700, north: false, epsg: code };
        }
        throw new Error("Nicht unterstütztes UTM-Koordinatensystem: EPSG:" + epsgCode);
    }

    /**
     * Exact WGS84 (lon, lat in degrees) -> UTM (easting, northing in meters)
     * using Snyder / Redfearn Transverse Mercator series (sub-mm accuracy).
     */
    function wgs84ToUtm(lonDeg, latDeg, zone, north) {
        const lat = latDeg * DEG2RAD;
        const lon = lonDeg * DEG2RAD;
        const lon0 = ((zone - 1) * 6 - 180 + 3) * DEG2RAD;

        const sinLat = Math.sin(lat);
        const cosLat = Math.cos(lat);
        const tanLat = Math.tan(lat);

        const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
        const T = tanLat * tanLat;
        const C = WGS84_EP2 * cosLat * cosLat;
        const A = cosLat * (lon - lon0);

        const e2 = WGS84_E2;
        const e4 = e2 * e2;
        const e6 = e4 * e2;
        const M = WGS84_A * (
            (1.0 - e2 / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0) * lat
            - (3.0 * e2 / 8.0 + 3.0 * e4 / 32.0 + 45.0 * e6 / 1024.0) * Math.sin(2.0 * lat)
            + (15.0 * e4 / 256.0 + 45.0 * e6 / 1024.0) * Math.sin(4.0 * lat)
            - (35.0 * e6 / 3072.0) * Math.sin(6.0 * lat)
        );

        const A2 = A * A;
        const A3 = A2 * A;
        const A4 = A2 * A2;
        const A5 = A4 * A;
        const A6 = A4 * A2;

        const easting = UTM_K0 * N * (
            A
            + (1.0 - T + C) * A3 / 6.0
            + (5.0 - 18.0 * T + T * T + 72.0 * C - 58.0 * WGS84_EP2) * A5 / 120.0
        ) + 500000.0;

        let northing = UTM_K0 * (
            M + N * tanLat * (
                A2 / 2.0
                + (5.0 - T + 9.0 * C + 4.0 * C * C) * A4 / 24.0
                + (61.0 - 58.0 * T + T * T + 600.0 * C - 330.0 * WGS84_EP2) * A6 / 720.0
            )
        );
        if (!north) {
            northing += 10000000.0;
        }
        return [easting, northing];
    }

    /**
     * Local metric projection around (lon0, lat0) matching build_prescription_maps.py.
     */
    function projectRingToLocalMeters(ring, lon0, lat0) {
        const cosLat = Math.cos(lat0 * DEG2RAD);
        const out = new Array(ring.length);
        for (let i = 0; i < ring.length; i++) {
            const lon = ring[i][0];
            const lat = ring[i][1];
            out[i] = [
                (lon - lon0) * 111320.0 * cosLat,
                (lat - lat0) * 110540.0,
            ];
        }
        return out;
    }

    /**
     * Fast ray-casting point-in-polygon check on a single ring [[x,y], ...].
     */
    function pointInRing(px, py, ring) {
        let inside = false;
        const n = ring.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            const intersect = ((yi > py) !== (yj > py)) &&
                (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /**
     * Compute polygon area in m^2 via shoelace formula on local metric coords.
     */
    function computePolygonAreaM2(outerRings, innerRings) {
        if (!outerRings || !outerRings.length) return 0;
        let sumLon = 0, sumLat = 0, cnt = 0;
        for (const r of outerRings) {
            for (const p of r) { sumLon += p[0]; sumLat += p[1]; cnt++; }
        }
        const lon0 = sumLon / Math.max(1, cnt);
        const lat0 = sumLat / Math.max(1, cnt);

        function ringArea(ring) {
            const m = projectRingToLocalMeters(ring, lon0, lat0);
            let a = 0;
            for (let i = 0; i < m.length; i++) {
                const j = (i + 1) % m.length;
                a += m[i][0] * m[j][1] - m[j][0] * m[i][1];
            }
            return Math.abs(a) * 0.5;
        }

        let total = 0;
        for (const r of outerRings) total += ringArea(r);
        for (const h of (innerRings || [])) total -= ringArea(h);
        return Math.max(0, total);
    }

    /**
     * Format number with German locale (comma decimal, dot thousands).
     */
    function fmtDe(val, decimals = 1) {
        if (val === null || val === undefined || Number.isNaN(val)) return "–";
        return Number(val).toLocaleString("de-DE", {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });
    }

    /**
     * Format YYYY-MM-DD as DD.MM.YYYY.
     */
    function fmtDateDe(isoDate) {
        if (!isoDate || isoDate.length < 10) return isoDate || "–";
        return `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}.${isoDate.slice(0, 4)}`;
    }

    /**
     * Safe ASCII slug for filenames.
     */
    function slugify(text) {
        return String(text || "feld")
            .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
            .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
            .replace(/ß/g, "ss")
            .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
            .replace(/[^A-Za-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "") || "feld";
    }

    /**
     * Choose nice round scale bar length (~22% of map width in meters).
     */
    function chooseScaleBar(widthM) {
        const candidates = [10, 20, 25, 50, 100, 150, 200, 250, 300, 500, 1000, 2000, 5000];
        const target = widthM * 0.22;
        let best = candidates[0];
        let bestDiff = Math.abs(best - target);
        for (const c of candidates) {
            const d = Math.abs(c - target);
            if (d < bestDiff) { best = c; bestDiff = d; }
        }
        return best;
    }

    /**
     * Quantile helper on sorted ascending numeric array (linear interpolation like numpy).
     */
    function percentileSorted(sorted, q) {
        const n = sorted.length;
        if (n === 0) return 0;
        if (n === 1) return sorted[0];
        const pos = (q / 100.0) * (n - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sorted[lo];
        const frac = pos - lo;
        return sorted[lo] * (1.0 - frac) + sorted[hi] * frac;
    }

    return {
        parseUtmEpsg,
        wgs84ToUtm,
        projectRingToLocalMeters,
        pointInRing,
        computePolygonAreaM2,
        fmtDe,
        fmtDateDe,
        slugify,
        chooseScaleBar,
        percentileSorted,
    };
})();
