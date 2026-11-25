/**
 * renderer.js — High-DPI Canvas rendering for Biomass maps, Prescription maps,
 * Overview map (all fields), and printable A4 Landscape Control Report PDF via jsPDF.
 */
window.AppRenderer = (function () {
    "use strict";

    // Matching palette from our proven Python Kontrollbericht
    const HEADER_BG = "#1b4332";
    const ACCENT_GREEN = "#40916c";
    const TEXT_DARK = "#0f172a";
    const TEXT_MUTED = "#475569";

    const BIOMASS_STOPS = [
        [0.00, [180, 83, 9]],     // #b45309
        [0.20, [245, 158, 11]],   // #f59e0b
        [0.40, [253, 224, 71]],   // #fde047
        [0.60, [132, 204, 22]],   // #84cc16
        [0.80, [21, 128, 61]],    // #15803d
        [1.00, [6, 78, 59]],      // #064e3b
    ];

    const RATE_PALETTES = {
        1: ["#2d6a4f"],
        3: ["#f6e57a", "#52b757", "#0a4f2c"],
        5: ["#f6e57a", "#b8df63", "#52b757", "#1f8a4c", "#0a4f2c"],
        7: ["#fef08a", "#e4e86a", "#a3d95b", "#52b757", "#24954f", "#126d3d", "#064024"],
    };

    function getRateColors(nZones) {
        if (RATE_PALETTES[nZones]) return RATE_PALETTES[nZones];
        const out = [];
        for (let i = 0; i < nZones; i++) {
            const t = nZones === 1 ? 0.5 : i / (nZones - 1);
            out.push(rgbToHex(interpolateStops(t, [
                [0.0, [246, 229, 122]],
                [0.5, [82, 183, 87]],
                [1.0, [10, 79, 44]],
            ])));
        }
        return out;
    }

    function rgbToHex([r, g, b]) {
        return "#" + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
    }

    function interpolateStops(t, stops) {
        const tc = Math.max(0, Math.min(1, t));
        for (let i = 0; i < stops.length - 1; i++) {
            const [t0, c0] = stops[i];
            const [t1, c1] = stops[i + 1];
            if (tc >= t0 && tc <= t1) {
                const f = (tc - t0) / Math.max(1e-9, t1 - t0);
                return [
                    c0[0] + f * (c1[0] - c0[0]),
                    c0[1] + f * (c1[1] - c0[1]),
                    c0[2] + f * (c1[2] - c0[2]),
                ];
            }
        }
        return stops[stops.length - 1][1];
    }

    function biomassColorCss(z) {
        if (Number.isNaN(z)) return "#e2e8f0";
        const t = (z + 1.8) / 3.6;
        const [r, g, b] = interpolateStops(t, BIOMASS_STOPS);
        return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    }

    /**
     * Compute metric viewport mapping for a single field onto canvas (width x height).
     */
    function computeFieldTransform(bio, width, height, padPx = 22) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const ring of bio.outerM) {
            for (const p of ring) {
                if (p[0] < minX) minX = p[0];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
            }
        }
        const padM = Math.max(16, Math.max(maxX - minX, maxY - minY) * 0.06);
        minX -= padM; maxX += padM;
        minY -= padM; maxY += padM;

        const spanX = Math.max(1, maxX - minX);
        const spanY = Math.max(1, maxY - minY);
        const availW = Math.max(10, width - 2 * padPx);
        const availH = Math.max(10, height - 2 * padPx);
        const scale = Math.min(availW / spanX, availH / spanY);

        const cx = 0.5 * (minX + maxX);
        const cy = 0.5 * (minY + maxY);
        const ox = width * 0.5 - cx * scale;
        const oy = height * 0.5 + cy * scale;

        return {
            scale,
            minX, maxX, minY, maxY,
            toX: (x) => ox + x * scale,
            toY: (y) => oy - y * scale,
            fromX: (px) => (px - ox) / scale,
            fromY: (py) => (oy - py) / scale,
        };
    }

    /**
     * Build clipping path (outer rings clockwise, inner holes evenodd).
     */
    function buildPolygonPath(ctx, outerM, innerM, tf) {
        ctx.beginPath();
        for (const ring of outerM) {
            for (let i = 0; i < ring.length; i++) {
                const x = tf.toX(ring[i][0]);
                const y = tf.toY(ring[i][1]);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
        }
        for (const hole of innerM) {
            for (let i = 0; i < hole.length; i++) {
                const x = tf.toX(hole[i][0]);
                const y = tf.toY(hole[i][1]);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
        }
    }

    /**
     * Draw scale bar and North arrow onto a canvas.
     */
    function drawScaleAndNorth(ctx, width, height, scalePxPerM) {
        const widthM = width / scalePxPerM;
        const sbLenM = window.AppGeo.chooseScaleBar(widthM);
        const sbPx = sbLenM * scalePxPerM;

        // Scale bar bottom-left
        const pad = 12;
        const boxW = sbPx + 20;
        const boxH = 30;
        const bx = pad;
        const by = height - pad - boxH;

        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.90)";
        ctx.strokeStyle = "#cbd5e1";
        ctx.lineWidth = 1;
        roundRect(ctx, bx, by, boxW, boxH, 5);
        ctx.fill();
        ctx.stroke();

        const barX = bx + 10;
        const barY = by + 18;
        const barH = 5;
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(barX, barY, sbPx * 0.5, barH);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(barX + sbPx * 0.5, barY, sbPx * 0.5, barH);
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, barY, sbPx, barH);

        ctx.fillStyle = TEXT_DARK;
        ctx.font = "bold 10.5px system-ui, -apple-system, Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const label = sbLenM >= 1000 ? `${sbLenM / 1000} km` : `${sbLenM} m`;
        ctx.fillText(label, barX + sbPx * 0.5, barY - 3);

        // North arrow top-right
        const nr = 15;
        const nx = width - pad - nr;
        const ny = pad + nr;
        ctx.fillStyle = "rgba(255,255,255,0.90)";
        ctx.strokeStyle = "#cbd5e1";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(nx, ny, nr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Arrow triangle
        ctx.fillStyle = HEADER_BG;
        ctx.beginPath();
        ctx.moveTo(nx, ny - 10);
        ctx.lineTo(nx + 4.5, ny + 1);
        ctx.lineTo(nx, ny - 1.5);
        ctx.lineTo(nx - 4.5, ny + 1);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = HEADER_BG;
        ctx.font = "bold 9px system-ui, -apple-system, Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("N", nx, ny + 2);
        ctx.restore();
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    /**
     * Render either "biomass" or "prescription" map of a single field onto a canvas.
     * Returns the viewport transform for interactive hover inspection.
     */
    function renderFieldMapCanvas(canvas, res, mode, cssW, cssH, dpr = window.devicePixelRatio || 1) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Background
        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(0, 0, cssW, cssH);

        const bio = res.bio;
        const tf = computeFieldTransform(bio, cssW, cssH, 20);
        const [gx0, gx1, gy0, gy1] = bio.extentM;
        const cellW_m = (gx1 - gx0) / bio.nCols;
        const cellH_m = (gy1 - gy0) / bio.nRows;

        const rateColors = getRateColors(res.zoneRates.length);
        const rateColorMap = new Map();
        res.zoneRates.forEach((r, i) => rateColorMap.set(r, rateColors[i]));

        // Clipped raster cells
        ctx.save();
        buildPolygonPath(ctx, bio.outerM, bio.innerM, tf);
        ctx.clip("evenodd");

        // Fill base light neutral inside polygon
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(0, 0, cssW, cssH);

        for (let r = 0; r < bio.nRows; r++) {
            const yTopM = gy0 + (r + 1) * cellH_m;
            const yBotM = gy0 + r * cellH_m;
            const py0 = tf.toY(yTopM);
            const py1 = tf.toY(yBotM);
            const cellH = py1 - py0;
            const rowOff = r * bio.nCols;

            for (let c = 0; c < bio.nCols; c++) {
                const idx = rowOff + c;
                if (!bio.dilatedMask[idx]) continue;

                const xLeftM = gx0 + c * cellW_m;
                const xRightM = gx0 + (c + 1) * cellW_m;
                const px0 = tf.toX(xLeftM);
                const px1 = tf.toX(xRightM);

                if (mode === "biomass") {
                    if (!bio.insideMask[idx]) continue;
                    ctx.fillStyle = biomassColorCss(bio.smoothZ[idx]);
                } else {
                    const rate = res.rateGrid[idx];
                    if (rate <= 0) continue;
                    ctx.fillStyle = rateColorMap.get(rate) || "#52b757";
                }
                ctx.fillRect(px0 - 0.35, py0 - 0.35, (px1 - px0) + 0.7, cellH + 0.7);
            }
        }

        // Subtle 10m gridlines on prescription map for small/medium fields
        if (mode === "prescription" && Math.max(bio.nCols, bio.nRows) <= 75) {
            ctx.strokeStyle = "rgba(15,23,42,0.14)";
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            for (let c = 0; c <= bio.nCols; c++) {
                const x = tf.toX(gx0 + c * cellW_m);
                ctx.moveTo(x, tf.toY(gy0));
                ctx.lineTo(x, tf.toY(gy1));
            }
            for (let r = 0; r <= bio.nRows; r++) {
                const y = tf.toY(gy0 + r * cellH_m);
                ctx.moveTo(tf.toX(gx0), y);
                ctx.lineTo(tf.toX(gx1), y);
            }
            ctx.stroke();
        }
        ctx.restore();

        // Crisp field boundary outline
        ctx.save();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1.8;
        ctx.lineJoin = "round";
        for (const ring of bio.outerM) {
            ctx.beginPath();
            for (let i = 0; i < ring.length; i++) {
                const x = tf.toX(ring[i][0]);
                const y = tf.toY(ring[i][1]);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
        }
        for (const hole of bio.innerM) {
            ctx.beginPath();
            for (let i = 0; i < hole.length; i++) {
                const x = tf.toX(hole[i][0]);
                const y = tf.toY(hole[i][1]);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();

        drawScaleAndNorth(ctx, cssW, cssH, tf.scale);
        return tf;
    }

    /**
     * Render overview map of all fields onto a canvas; returns hit-test boxes for click navigation.
     */
    function renderOverviewMapCanvas(canvas, fields, selectedUid, cssW, cssH, dpr = window.devicePixelRatio || 1) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = "#f4f7f5";
        ctx.fillRect(0, 0, cssW, cssH);

        if (!fields || fields.length === 0) return [];

        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const f of fields) {
            for (const r of f.outerRings) {
                for (const p of r) {
                    if (p[0] < minLon) minLon = p[0];
                    if (p[0] > maxLon) maxLon = p[0];
                    if (p[1] < minLat) minLat = p[1];
                    if (p[1] > maxLat) maxLat = p[1];
                }
            }
        }

        const lon0 = 0.5 * (minLon + maxLon);
        const lat0 = 0.5 * (minLat + maxLat);
        const cosLat = Math.cos((lat0 * Math.PI) / 180.0);

        const toLocalM = (lon, lat) => [
            (lon - lon0) * 111320.0 * cosLat,
            (lat - lat0) * 110540.0,
        ];

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const projFields = fields.map(f => {
            const outerM = f.outerRings.map(r => r.map(p => {
                const [x, y] = toLocalM(p[0], p[1]);
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                return [x, y];
            }));
            const [cx, cy] = toLocalM(f.centerLon, f.centerLat);
            return { f, outerM, cx, cy };
        });

        const spanX = Math.max(100, maxX - minX);
        const spanY = Math.max(100, maxY - minY);
        const padM = Math.max(spanX, spanY) * 0.12;
        minX -= padM; maxX += padM; minY -= padM; maxY += padM;

        const padPx = 28;
        const scale = Math.min((cssW - 2 * padPx) / (maxX - minX), (cssH - 2 * padPx) / (maxY - minY));
        const midX = 0.5 * (minX + maxX);
        const midY = 0.5 * (minY + maxY);
        const toX = (x) => cssW * 0.5 + (x - midX) * scale;
        const toY = (y) => cssH * 0.5 - (y - midY) * scale;

        // Subtle coordinate grid background
        ctx.strokeStyle = "rgba(27,67,50,0.08)";
        ctx.lineWidth = 1;
        const gridStep = window.AppGeo.chooseScaleBar((maxX - minX) * 1.4);
        const gxStart = Math.floor(minX / gridStep) * gridStep;
        const gyStart = Math.floor(minY / gridStep) * gridStep;
        ctx.beginPath();
        for (let gx = gxStart; gx <= maxX; gx += gridStep) {
            const px = toX(gx);
            ctx.moveTo(px, 0); ctx.lineTo(px, cssH);
        }
        for (let gy = gyStart; gy <= maxY; gy += gridStep) {
            const py = toY(gy);
            ctx.moveTo(0, py); ctx.lineTo(cssW, py);
        }
        ctx.stroke();

        const hits = [];
        projFields.forEach((pf, idx) => {
            const isSel = pf.f.uid === selectedUid;
            const isActive = pf.f.selected;
            ctx.save();
            ctx.fillStyle = !isActive
                ? "rgba(148,163,184,0.35)"
                : (isSel ? "#1b4332" : "rgba(64,145,108,0.72)");
            ctx.strokeStyle = isSel ? "#f59e0b" : "#1b4332";
            ctx.lineWidth = isSel ? 2.5 : 1.4;

            for (const ring of pf.outerM) {
                ctx.beginPath();
                for (let i = 0; i < ring.length; i++) {
                    const px = toX(ring[i][0]);
                    const py = toY(ring[i][1]);
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();

            const lx = toX(pf.cx);
            const ly = toY(pf.cy);
            hits.push({ uid: pf.f.uid, cx: lx, cy: ly, outerM: pf.outerM, toX, toY });

            // Pill label
            const label = `${idx + 1}. ${pf.f.name}`;
            ctx.save();
            ctx.font = isSel ? "bold 11px system-ui, sans-serif" : "600 10px system-ui, sans-serif";
            const tw = ctx.measureText(label).width;
            const pw = tw + 10;
            const ph = 16;
            const px = Math.max(6, Math.min(cssW - pw - 6, lx - pw * 0.5));
            const py = Math.max(6, Math.min(cssH - ph - 6, ly - ph * 0.5));

            ctx.fillStyle = isSel ? "#1b4332" : "rgba(255,255,255,0.92)";
            ctx.strokeStyle = isSel ? "#f59e0b" : "#94a3b8";
            ctx.lineWidth = 0.9;
            roundRect(ctx, px, py, pw, ph, 4);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = isSel ? "#ffffff" : "#0f172a";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, px + pw * 0.5, py + ph * 0.5 + 0.5);
            ctx.restore();
        });

        drawScaleAndNorth(ctx, cssW, cssH, scale);
        return hits;
    }

    /**
     * Generate printable A4 Landscape Control Report PDF via jsPDF
     * (Cover + Overview Map + Sentinel-2 Scenes + Summary Table + 1 Page per Field).
     */
    async function generateControlReportPdf(farmMeta, results, scenes, config, onProgress) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
        const W = 297, H = 210;
        const totalPages = 2 + results.length;
        const todayStr = new Date().toLocaleDateString("de-DE");

        const productName = config.productName || "Kalkammonsalpeter (KAS)";
        const stratLabel = config.strategy === "potential"
            ? "Ertragspotenzial fördern (stark -> mehr, schwach -> weniger)"
            : (config.strategy === "uniform"
                ? "Gleichmäßig (konstante Zielmenge)"
                : "Bestände ausgleichen (schwach -> mehr, stark -> weniger)");

        const totArea = results.reduce((s, r) => s + r.field.areaHa, 0);
        const totKg = results.reduce((s, r) => s + r.totalKg, 0);
        const avgRateAll = totArea > 0 ? totKg / totArea : 0;
        const rates = results[0]?.zoneRates || [];
        const rateColors = getRateColors(rates.length);

        const report = (p, m) => { if (typeof onProgress === "function") onProgress(p, m); };

        // Helper: Header banner on each page
        function drawHeader(title, subtitle, rightTop, rightBot) {
            doc.setFillColor(27, 67, 50);
            doc.rect(0, 0, W, 22, "F");
            doc.setFillColor(64, 145, 108);
            doc.rect(0, 20.8, W, 1.2, "F");

            doc.setTextColor(255, 255, 255);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(14.5);
            doc.text(title, 8, 9.5);

            doc.setTextColor(216, 243, 220);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8.5);
            doc.text(subtitle, 8, 16.5);

            doc.setTextColor(183, 228, 199);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(8.5);
            doc.text(rightTop, W - 8, 9.2, { align: "right" });

            doc.setTextColor(255, 255, 255);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8.5);
            doc.text(rightBot, W - 8, 16.0, { align: "right" });
        }

        function drawFooter(pageNum) {
            doc.setDrawColor(226, 232, 240);
            doc.line(8, H - 10, W - 8, H - 10);
            doc.setTextColor(100, 116, 139);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.5);
            doc.text(`Applikationskarten-Kontrollbericht  •  ${farmMeta.farmName}  •  Erstellt am ${todayStr}`, 8, H - 5.5);
            doc.text(`Seite ${pageNum} von ${totalPages}`, W - 8, H - 5.5, { align: "right" });
        }

        // ==================== PAGE 1: COVER + OVERVIEW MAP ====================
        report(5, "Erzeuge Deckblatt & Lagekarte…");
        drawHeader(
            `Kontrollbericht Dünger-Applikationskarten (${productName})`,
            `Strategie: ${stratLabel}`,
            "RAUCH / CC-ISOBUS TASKDATA v4.2",
            `${farmMeta.farmName}  •  ${todayStr}`
        );

        // KPI Cards row
        const kpis = [
            { label: "Schläge", val: `${results.length} Felder` },
            { label: "Gesamtfläche", val: `${window.AppGeo.fmtDe(totArea, 2)} ha` },
            { label: "Ø Streumenge", val: `${window.AppGeo.fmtDe(avgRateAll, 1)} kg/ha` },
            { label: "Gesamtbedarf", val: `${window.AppGeo.fmtDe(totKg / 1000, 2)} t (${window.AppGeo.fmtDe(totKg, 0)} kg)` },
        ];
        const cardW = (W - 16 - 9) / 4;
        kpis.forEach((k, i) => {
            const cx = 8 + i * (cardW + 3);
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(226, 232, 240);
            doc.roundedRect(cx, 27, cardW, 18, 2, 2, "FD");
            doc.setTextColor(71, 85, 105);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.text(k.label, cx + 4, 33);
            doc.setTextColor(15, 23, 42);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(12);
            doc.text(k.val, cx + 4, 41.5);
        });

        // Overview Map Canvas (left side)
        const ovCanvas = document.createElement("canvas");
        renderOverviewMapCanvas(ovCanvas, results.map(r => r.field), null, 680, 480, 2);
        const ovImg = ovCanvas.toDataURL("image/png");
        doc.setDrawColor(203, 213, 225);
        doc.rect(8, 50, 175, 145);
        doc.addImage(ovImg, "PNG", 8.5, 50.5, 174, 144);

        // Right column: Parameters + Sentinel-2 Scenes table
        const rx = 189;
        doc.setTextColor(27, 67, 50);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10.5);
        doc.text("Einstellungen & Terminal-Daten", rx, 55);

        const paramRows = [
            ["Produkt:", productName],
            ["Zonenstufen:", rates.map(r => `${r}`).join(" / ") + " kg/ha"],
            ["Raster / Typ:", `${config.cellSizeM || 10} m  (ISOXML Grid Typ 2)`],
            ["ID-Bereich:", `${results[0]?.tskId || ""} – ${results[results.length - 1]?.tskId || ""} (kollisionsfrei)`],
            ["Randpixel-Filter:", config.edgeFilter !== false ? "Aktiv (10 m Mischpixel gefiltert)" : "Aus"],
            ["OutOfField / Default:", `0 kg/ha  /  Ø je Schlag`],
        ];
        doc.setFontSize(8.2);
        let py = 62;
        for (const [k, v] of paramRows) {
            doc.setFont("helvetica", "bold");
            doc.setTextColor(71, 85, 105);
            doc.text(k, rx, py);
            doc.setFont("helvetica", "normal");
            doc.setTextColor(15, 23, 42);
            doc.text(String(v).slice(0, 44), rx + 33, py);
            py += 5.8;
        }

        py += 5;
        doc.setTextColor(27, 67, 50);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10.5);
        doc.text(`Verwendete Sentinel-2-Szenen (${scenes.length})`, rx, py);
        py += 5;

        // Table header
        doc.setFillColor(27, 67, 50);
        doc.rect(rx, py, W - rx - 8, 6, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.5);
        doc.text("Datum", rx + 2, py + 4.2);
        doc.text("Wolkenfrei", rx + 25, py + 4.2);
        doc.text("NDVI-Med.", rx + 46, py + 4.2);
        doc.text("Szene", rx + 65, py + 4.2);
        py += 6;

        doc.setFont("helvetica", "normal");
        const maxScenesShow = Math.min(scenes.length, 14);
        for (let i = 0; i < maxScenesShow; i++) {
            const sc = scenes[i];
            if (i % 2 === 1) {
                doc.setFillColor(248, 250, 252);
                doc.rect(rx, py, W - rx - 8, 5.5, "F");
            }
            doc.setTextColor(15, 23, 42);
            doc.setFontSize(7.2);
            doc.text(window.AppGeo.fmtDateDe(sc.date), rx + 2, py + 3.9);
            doc.text(`${window.AppGeo.fmtDe(sc.validPct, 1)} %`, rx + 25, py + 3.9);
            doc.text(window.AppGeo.fmtDe(sc.ndviMedian, 2), rx + 46, py + 3.9);
            doc.text(sc.id.slice(0, 26), rx + 65, py + 3.9);
            py += 5.5;
        }
        drawFooter(1);

        // ==================== PAGE 2: SUMMARY TABLE ====================
        report(12, "Erzeuge Gesamtverzeichnis…");
        doc.addPage();
        drawHeader(
            "Gesamtverzeichnis aller Schläge",
            `${results.length} Schläge  •  ${window.AppGeo.fmtDe(totArea, 2)} ha gesamt  •  ${window.AppGeo.fmtDe(totKg, 0)} kg ${productName}`,
            "ÜBERSICHTSTABELLE",
            farmMeta.farmName
        );

        let ty = 30;
        const colX = [8, 17, 72, 92, 114, 134, 157, 178];
        doc.setFillColor(27, 67, 50);
        doc.rect(8, ty, W - 16, 7, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.8);
        doc.text("Nr", colX[0] + 1.5, ty + 4.8);
        doc.text("Schlagname", colX[1], ty + 4.8);
        doc.text("Fläche (ha)", colX[2], ty + 4.8);
        doc.text("GRD-Datei", colX[3], ty + 4.8);
        doc.text("Szenen", colX[4], ty + 4.8);
        doc.text("Ø kg/ha", colX[5], ty + 4.8);
        doc.text("Gesamt (kg)", colX[6], ty + 4.8);

        const zoneAreaW = (W - 8) - colX[7];
        const zColW = zoneAreaW / Math.max(1, rates.length);
        rates.forEach((r, zi) => {
            doc.text(`${r} kg/ha`, colX[7] + zi * zColW + zColW * 0.5, ty + 4.8, { align: "center" });
        });
        ty += 7;

        const rowH = Math.min(7.2, Math.max(5.2, 148 / Math.max(1, results.length + 1)));
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.6);

        results.forEach((res, i) => {
            if (ty + rowH > H - 20) return; // guard overflow on huge farm lists
            if (i % 2 === 1) {
                doc.setFillColor(248, 250, 252);
                doc.rect(8, ty, W - 16, rowH, "F");
            }
            doc.setTextColor(15, 23, 42);
            doc.text(String(i + 1).padStart(2, "0"), colX[0] + 1.5, ty + rowH * 0.68);
            doc.text(res.field.name.slice(0, 30), colX[1], ty + rowH * 0.68);
            doc.text(window.AppGeo.fmtDe(res.field.areaHa, 2), colX[2], ty + rowH * 0.68);
            doc.text(`${res.grdName}.BIN`, colX[3], ty + rowH * 0.68);
            doc.text(String(res.bio.usedScenes.length), colX[4] + 3, ty + rowH * 0.68);
            doc.text(window.AppGeo.fmtDe(res.avgRate, 1), colX[5], ty + rowH * 0.68);
            doc.text(window.AppGeo.fmtDe(res.totalKg, 0), colX[6], ty + rowH * 0.68);

            rates.forEach((r, zi) => {
                const pct = res.totIn > 0 ? ((res.zoneCounts.get(r) || 0) / res.totIn) * 100.0 : 0;
                doc.text(`${window.AppGeo.fmtDe(pct, 1)} %`, colX[7] + zi * zColW + zColW * 0.5, ty + rowH * 0.68, { align: "center" });
            });
            ty += rowH;
        });

        // Total row
        doc.setFillColor(216, 243, 220);
        doc.rect(8, ty, W - 16, 7.5, "F");
        doc.setFont("helvetica", "bold");
        doc.setTextColor(27, 67, 50);
        doc.text("GESAMT", colX[1], ty + 5.2);
        doc.text(window.AppGeo.fmtDe(totArea, 2), colX[2], ty + 5.2);
        doc.text(window.AppGeo.fmtDe(avgRateAll, 1), colX[5], ty + 5.2);
        doc.text(`${window.AppGeo.fmtDe(totKg, 0)} kg (${window.AppGeo.fmtDe(totKg / 1000, 2)} t)`, colX[6], ty + 5.2);
        drawFooter(2);

        // ==================== PAGES 3..N: PER-FIELD CONTROL SHEETS ====================
        const tmpBioCanvas = document.createElement("canvas");
        const tmpRxCanvas = document.createElement("canvas");

        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            const b = res.bio;
            report(15 + Math.round(((i + 1) / results.length) * 80), `Rendere Kontrollseite ${i + 1}/${results.length}: ${res.field.name}…`);

            // Yield briefly so browser UI updates progress bar smoothly
            await new Promise(resolve => setTimeout(resolve, 0));

            doc.addPage();
            const yrsStr = b.yearsUsed.length ? b.yearsUsed.join("/") : "–";
            drawHeader(
                `${String(i + 1).padStart(2, "0")}. ${res.field.name}  (${window.AppGeo.fmtDe(res.field.areaHa, 2)} ha)`,
                `Dünger: ${productName}  |  ${res.tskId}  |  ${res.grdName}.BIN (ISOXML Grid Typ 2, ${b.cellSizeM} m)`,
                "APPLIKATIONSKARTE (RAUCH / ISOBUS)",
                `${farmMeta.farmName}  •  Sentinel-2 (${yrsStr})`
            );

            // Map titles
            doc.setTextColor(27, 67, 50);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(9.5);
            doc.text(`Biomassezonen (Sentinel-2: ${b.usedScenes.length} Szenen, ${yrsStr})`, 8, 29);
            doc.text(`Applikationskarte (${res.grdName}.BIN – ${rates.length} Zonen, ${b.cellSizeM} m Raster)`, 153, 29);

            // Render both maps at high DPI
            renderFieldMapCanvas(tmpBioCanvas, res, "biomass", 540, 410, 2);
            renderFieldMapCanvas(tmpRxCanvas, res, "prescription", 540, 410, 2);

            doc.setDrawColor(203, 213, 225);
            doc.rect(8, 31.5, 136, 103);
            doc.addImage(tmpBioCanvas.toDataURL("image/png"), "PNG", 8.4, 31.9, 135.2, 102.2);

            doc.rect(153, 31.5, 136, 103);
            doc.addImage(tmpRxCanvas.toDataURL("image/png"), "PNG", 153.4, 31.9, 135.2, 102.2);

            // Left Biomass Colorbar
            const cbX = 14, cbY = 138, cbW = 124, cbH = 4;
            const steps = 40;
            for (let s = 0; s < steps; s++) {
                const [r, g, bl] = interpolateStops(s / (steps - 1), BIOMASS_STOPS);
                doc.setFillColor(Math.round(r), Math.round(g), Math.round(bl));
                doc.rect(cbX + (s * cbW) / steps, cbY, cbW / steps + 0.3, cbH, "F");
            }
            doc.setDrawColor(203, 213, 225);
            doc.rect(cbX, cbY, cbW, cbH);
            doc.setTextColor(71, 85, 105);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.2);
            doc.text("sehr schwach", cbX, cbY + 7.5);
            doc.text("mittel", cbX + cbW * 0.5, cbY + 7.5, { align: "center" });
            doc.text("sehr stark", cbX + cbW, cbY + 7.5, { align: "right" });

            // Right Prescription Legend
            const rxLegX = 159, rxLegW = 124;
            const swW = rxLegW / Math.max(1, rates.length);
            rates.forEach((rateVal, zi) => {
                const hex = rateColors[zi];
                const rr = parseInt(hex.slice(1, 3), 16);
                const gg = parseInt(hex.slice(3, 5), 16);
                const bb = parseInt(hex.slice(5, 7), 16);
                doc.setFillColor(rr, gg, bb);
                doc.rect(rxLegX + zi * swW, cbY, swW, cbH, "F");
                doc.setTextColor(15, 23, 42);
                doc.setFont("helvetica", "bold");
                doc.setFontSize(7.4);
                doc.text(`${rateVal} kg/ha`, rxLegX + zi * swW + swW * 0.5, cbY + 7.5, { align: "center" });
            });
            doc.setDrawColor(203, 213, 225);
            doc.rect(rxLegX, cbY, rxLegW, cbH);

            // Bottom summary strip: KPIs + Zone Distribution Bars
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(226, 232, 240);
            doc.roundedRect(8, 151, 281, 45, 2, 2, "FD");

            // Left info block
            doc.setTextColor(27, 67, 50);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(9.5);
            doc.text("Schlag-Kennzahlen", 13, 158);

            const fieldStats = [
                ["Schlagfläche:", `${window.AppGeo.fmtDe(res.field.areaHa, 2)} ha`],
                ["Ø Streumenge:", `${window.AppGeo.fmtDe(res.avgRate, 1)} kg/ha`],
                ["Gesamtbedarf:", `${window.AppGeo.fmtDe(res.totalKg, 0)} kg (${window.AppGeo.fmtDe(res.totalKg / 1000, 2)} t)`],
                ["Rastergröße:", `${b.nCols} × ${b.nRows} Zellen (${b.cellSizeM} m)`],
                ["Ø NDVI (Kern):", Number.isNaN(b.meanNdviAvg) ? "–" : window.AppGeo.fmtDe(b.meanNdviAvg, 3)],
            ];
            let sy = 164.5;
            doc.setFontSize(8.2);
            for (const [k, v] of fieldStats) {
                doc.setFont("helvetica", "bold");
                doc.setTextColor(71, 85, 105);
                doc.text(k, 13, sy);
                doc.setFont("helvetica", "normal");
                doc.setTextColor(15, 23, 42);
                doc.text(v, 44, sy);
                sy += 6.1;
            }

            // Right horizontal zone share bars
            doc.setTextColor(27, 67, 50);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(9.5);
            doc.text("Flächenverteilung der Düngezonen", 112, 158);

            const barStart = 136;
            const barMaxW = 105;
            const barStep = Math.min(6.4, 32 / Math.max(1, rates.length));
            rates.forEach((rateVal, zi) => {
                const by = 161.5 + zi * barStep;
                const pct = res.totIn > 0 ? ((res.zoneCounts.get(rateVal) || 0) / res.totIn) * 100.0 : 0;
                const areaZ = res.field.areaHa * (pct / 100.0);
                const hex = rateColors[zi];
                const rr = parseInt(hex.slice(1, 3), 16);
                const gg = parseInt(hex.slice(3, 5), 16);
                const bb = parseInt(hex.slice(5, 7), 16);

                doc.setFont("helvetica", "bold");
                doc.setFontSize(7.6);
                doc.setTextColor(15, 23, 42);
                doc.text(`${rateVal} kg/ha`, 112, by + 3.6);

                doc.setFillColor(226, 232, 240);
                doc.rect(barStart, by + 0.5, barMaxW, barStep - 2.0, "F");
                doc.setFillColor(rr, gg, bb);
                doc.rect(barStart, by + 0.5, Math.max(0.8, (pct / 100.0) * barMaxW), barStep - 2.0, "F");

                doc.setFont("helvetica", "normal");
                doc.setTextColor(71, 85, 105);
                doc.text(`${window.AppGeo.fmtDe(pct, 1)} %  (${window.AppGeo.fmtDe(areaZ, 2)} ha)`, barStart + barMaxW + 4, by + 3.6);
            });

            drawFooter(i + 3);
        }

        report(98, "Speichere PDF-Datei…");
        return doc.output("blob");
    }

    return {
        getRateColors,
        renderFieldMapCanvas,
        renderOverviewMapCanvas,
        generateControlReportPdf,
    };
})();
