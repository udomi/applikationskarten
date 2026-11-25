/**
 * asapplied-renderer.js — Canvas & jsPDF rendering for Soll/Ist & As-Applied comparison maps,
 * crop-colored regional overview map, single-field Soll-Ist PDF, and multi-field report PDF.
 */
window.AppAsAppliedRenderer = (function () {
    "use strict";

    const HEADER_BG = "#1b4332";
    const TEXT_DARK = "#0f172a";

    // Matching agronomic fertilizer palette: warm yellow -> lime -> vibrant green -> deep forest
    const FERT_STOPS = [
        [0.00, [246, 229, 122]], // #f6e57a
        [0.25, [184, 223, 99]],  // #b8df63
        [0.50, [82, 183, 87]],   // #52b757
        [0.75, [31, 138, 76]],   // #1f8a4c
        [1.00, [10, 79, 44]],    // #0a4f2c
    ];

    function fertRgb(val, vmin, vmax) {
        const span = Math.max(1e-6, vmax - vmin);
        const t = Math.max(0, Math.min(1, (val - vmin) / span));
        for (let i = 0; i < FERT_STOPS.length - 1; i++) {
            const [t0, c0] = FERT_STOPS[i];
            const [t1, c1] = FERT_STOPS[i + 1];
            if (t >= t0 && t <= t1) {
                const f = (t - t0) / Math.max(1e-9, t1 - t0);
                return [
                    Math.round(c0[0] + f * (c1[0] - c0[0])),
                    Math.round(c0[1] + f * (c1[1] - c0[1])),
                    Math.round(c0[2] + f * (c1[2] - c0[2])),
                ];
            }
        }
        return FERT_STOPS[FERT_STOPS.length - 1][1];
    }

    function fertCss(val, vmin, vmax) {
        const [r, g, b] = fertRgb(val, vmin, vmax);
        return `rgb(${r},${g},${b})`;
    }

    /**
     * Compute clean shared color scale [vmin, vmax] across Soll & Ist for fair visual comparison.
     */
    function computeSharedScale(item) {
        let vmin = item.minAr;
        let vmax = item.maxAr;
        if (item.sollStats) {
            vmin = Math.min(vmin, item.sollStats.minRate);
            vmax = Math.max(vmax, item.sollStats.maxRate);
        } else if (item.avgTrTlg) {
            vmin = Math.min(vmin, item.avgTrTlg);
            vmax = Math.max(vmax, item.avgTrTlg);
        }
        if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax - vmin < 15) {
            const mid = Number.isFinite(item.avgArPts) ? item.avgArPts : 250;
            vmin = Math.max(0, Math.floor((mid - 40) / 10) * 10);
            vmax = Math.ceil((mid + 40) / 10) * 10;
        } else {
            vmin = Math.max(0, Math.floor((vmin - 5) / 5) * 5);
            vmax = Math.ceil((vmax + 5) / 5) * 5;
        }
        return [vmin, vmax];
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

    function drawScaleAndNorth(ctx, width, height, scalePxPerM) {
        const widthM = width / scalePxPerM;
        const sbLenM = window.AppGeo.chooseScaleBar(widthM);
        const sbPx = sbLenM * scalePxPerM;

        const pad = 11;
        const boxW = sbPx + 20;
        const boxH = 29;
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
        const barY = by + 17;
        const barH = 5;
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(barX, barY, sbPx * 0.5, barH);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(barX + sbPx * 0.5, barY, sbPx * 0.5, barH);
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, barY, sbPx, barH);

        ctx.fillStyle = TEXT_DARK;
        ctx.font = "bold 10px system-ui, -apple-system, Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(sbLenM >= 1000 ? `${sbLenM / 1000} km` : `${sbLenM} m`, barX + sbPx * 0.5, barY - 2);

        const nr = 14;
        const nx = width - pad - nr;
        const ny = pad + nr;
        ctx.fillStyle = "rgba(255,255,255,0.90)";
        ctx.strokeStyle = "#cbd5e1";
        ctx.beginPath();
        ctx.arc(nx, ny, nr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = HEADER_BG;
        ctx.beginPath();
        ctx.moveTo(nx, ny - 9);
        ctx.lineTo(nx + 4.2, ny + 1);
        ctx.lineTo(nx, ny - 1.5);
        ctx.lineTo(nx - 4.2, ny + 1);
        ctx.closePath();
        ctx.fill();

        ctx.font = "bold 8.5px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("N", nx, ny + 2);
        ctx.restore();
    }

    function computeViewport(raster, width, height, padPx = 18) {
        const spanX = Math.max(1, raster.xmax - raster.xmin);
        const spanY = Math.max(1, raster.ymax - raster.ymin);
        const scale = Math.min((width - 2 * padPx) / spanX, (height - 2 * padPx) / spanY);
        const cx = 0.5 * (raster.xmin + raster.xmax);
        const cy = 0.5 * (raster.ymin + raster.ymax);
        const ox = width * 0.5 - cx * scale;
        const oy = height * 0.5 + cy * scale;
        return {
            scale,
            toX: (x) => ox + x * scale,
            toY: (y) => oy - y * scale,
            fromX: (px) => (px - ox) / scale,
            fromY: (py) => (oy - py) / scale,
        };
    }

    function buildPolygonPath(ctx, outerM, innerM, tf) {
        ctx.beginPath();
        for (const ring of outerM) {
            for (let i = 0; i < ring.length; i++) {
                const x = tf.toX(ring[i][0]), y = tf.toY(ring[i][1]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
        }
        for (const hole of innerM) {
            for (let i = 0; i < hole.length; i++) {
                const x = tf.toX(hole[i][0]), y = tf.toY(hole[i][1]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
        }
    }

    function strokeBoundary(ctx, outerM, innerM, tf) {
        ctx.save();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1.8;
        ctx.lineJoin = "round";
        for (const ring of [...outerM, ...innerM]) {
            ctx.beginPath();
            for (let i = 0; i < ring.length; i++) {
                const x = tf.toX(ring[i][0]), y = tf.toY(ring[i][1]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    }

    /**
     * Render either "soll" (GRD*.BIN or fallback TLG DDI 0006 track) or "ist" (TLG DDI 0007 swath grid).
     */
    function renderComparisonMapCanvas(canvas, item, raster, mode, scaleRange, options, cssW, cssH, dpr = window.devicePixelRatio || 1) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(0, 0, cssW, cssH);

        const tf = computeViewport(raster, cssW, cssH, 18);
        const [vmin, vmax] = scaleRange;
        const hasPoly = raster.outerM.length > 0;

        ctx.save();
        if (hasPoly) {
            buildPolygonPath(ctx, raster.outerM, raster.innerM, tf);
            ctx.clip("evenodd");
            // Unworked fill inside polygon
            ctx.fillStyle = "#e2e8f0";
            ctx.fillRect(0, 0, cssW, cssH);
        }

        if (mode === "soll" && item.sollGrd && raster.sollExtentM) {
            const g = item.sollGrd;
            const [gx0, gx1, gy0, gy1] = raster.sollExtentM;
            const cw = (gx1 - gx0) / g.nCols;
            const ch = (gy1 - gy0) / g.nRows;

            for (let r = 0; r < g.nRows; r++) {
                const py0 = tf.toY(gy0 + (r + 1) * ch);
                const py1 = tf.toY(gy0 + r * ch);
                const hPx = py1 - py0;
                const rowOff = r * g.nCols;
                for (let c = 0; c < g.nCols; c++) {
                    const v = g.rates[rowOff + c];
                    if (v <= 0) continue;
                    const px0 = tf.toX(gx0 + c * cw);
                    const px1 = tf.toX(gx0 + (c + 1) * cw);
                    ctx.fillStyle = fertCss(v, vmin, vmax);
                    ctx.fillRect(px0 - 0.35, py0 - 0.35, (px1 - px0) + 0.7, hPx + 0.7);
                }
            }
            // Subtle gridlines for small/medium Soll rasters
            if (Math.max(g.nCols, g.nRows) <= 75) {
                ctx.strokeStyle = "rgba(15,23,42,0.12)";
                ctx.lineWidth = 0.45;
                ctx.beginPath();
                for (let c = 0; c <= g.nCols; c++) {
                    const x = tf.toX(gx0 + c * cw);
                    ctx.moveTo(x, tf.toY(gy0)); ctx.lineTo(x, tf.toY(gy1));
                }
                for (let r = 0; r <= g.nRows; r++) {
                    const y = tf.toY(gy0 + r * ch);
                    ctx.moveTo(tf.toX(gx0), y); ctx.lineTo(tf.toX(gx1), y);
                }
                ctx.stroke();
            }
        } else {
            // Render rasterized swath grid ("ist" uses rateGrid, fallback "soll" without GRD uses targetGrid)
            const grid = mode === "soll" ? raster.targetGrid : raster.rateGrid;
            const { nx, ny, xmin, ymin, res } = raster;

            // Draw via offscreen ImageData for instant crisp pixel speed
            const off = document.createElement("canvas");
            off.width = nx;
            off.height = ny;
            const octx = off.getContext("2d");
            const imgData = octx.createImageData(nx, ny);
            const data = imgData.data;

            for (let ry = 0; ry < ny; ry++) {
                // Canvas Y=0 is top (ymax), raster row 0 is bottom (ymin)
                const dstRow = (ny - 1 - ry) * nx;
                const srcRow = ry * nx;
                for (let cx = 0; cx < nx; cx++) {
                    const v = grid[srcRow + cx];
                    if (Number.isNaN(v) || v <= 0) continue;
                    const [r, g, b] = fertRgb(v, vmin, vmax);
                    const p = (dstRow + cx) * 4;
                    data[p] = r;
                    data[p + 1] = g;
                    data[p + 2] = b;
                    data[p + 3] = 255;
                }
            }
            octx.putImageData(imgData, 0, 0);

            const dx = tf.toX(xmin);
            const dy = tf.toY(ymin + ny * res);
            const dw = tf.toX(xmin + nx * res) - dx;
            const dh = tf.toY(ymin) - dy;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(off, dx, dy, dw, dh);

            // Optional tractor/spreader track lines overlay
            if (mode === "ist" && options && options.showTracks) {
                ctx.strokeStyle = "rgba(15, 23, 42, 0.45)";
                ctx.lineWidth = 1.0;
                ctx.setLineDash([4, 3]);
                for (const t of raster.tracksM) {
                    if (t.xy.length < 2) continue;
                    ctx.beginPath();
                    for (let i = 0; i < t.xy.length; i++) {
                        const px = tf.toX(t.xy[i][0]);
                        const py = tf.toY(t.xy[i][1]);
                        if (i === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                    }
                    ctx.stroke();
                }
                ctx.setLineDash([]);
            }
        }

        ctx.restore();

        if (hasPoly) {
            strokeBoundary(ctx, raster.outerM, raster.innerM, tf);
        }

        // If Soll without GRD, show subtle badge in top-left explaining source
        if (mode === "soll" && !item.sollGrd) {
            ctx.save();
            const txt = item.avgTrTlg ? "Soll aus TLG (DDI 0006) – keine GRD-Datei" : "Keine Soll-Karte im Auftrag hinterlegt";
            ctx.font = "600 10px system-ui, sans-serif";
            const tw = ctx.measureText(txt).width;
            ctx.fillStyle = "rgba(255,251,235,0.93)";
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = 1;
            roundRect(ctx, 10, 10, tw + 14, 22, 5);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#92400e";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(txt, 17, 21);
            ctx.restore();
        }

        drawScaleAndNorth(ctx, cssW, cssH, tf.scale);
        return tf;
    }

    /**
     * Render regional overview map colored by crop (matching generate_as_applied_maps.py).
     */
    function renderCropOverviewCanvas(canvas, items, selectedUid, cssW, cssH, dpr = window.devicePixelRatio || 1) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#f4f7f5";
        ctx.fillRect(0, 0, cssW, cssH);

        if (!items || items.length === 0) return [];

        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const it of items) {
            const pts = it.outerRings.length ? it.outerRings.flat() : [[it.centerLon, it.centerLat]];
            for (const p of pts) {
                if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0];
                if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
            }
        }
        const lon0 = 0.5 * (minLon + maxLon);
        const lat0 = 0.5 * (minLat + maxLat);
        const cosLat = Math.cos((lat0 * Math.PI) / 180.0);
        const toM = (lo, la) => [(lo - lon0) * 111320.0 * cosLat, (la - lat0) * 110540.0];

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const proj = items.map(it => {
            const outerM = it.outerRings.map(r => r.map(p => {
                const xy = toM(p[0], p[1]);
                if (xy[0] < minX) minX = xy[0]; if (xy[0] > maxX) maxX = xy[0];
                if (xy[1] < minY) minY = xy[1]; if (xy[1] > maxY) maxY = xy[1];
                return xy;
            }));
            const [cx, cy] = toM(it.centerLon, it.centerLat);
            if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
            return { it, outerM, cx, cy };
        });

        const span = Math.max(200, maxX - minX, maxY - minY);
        const padM = span * 0.1;
        minX -= padM; maxX += padM; minY -= padM; maxY += padM;

        const padPx = 26;
        const scale = Math.min((cssW - 2 * padPx) / (maxX - minX), (cssH - 2 * padPx) / (maxY - minY));
        const midX = 0.5 * (minX + maxX);
        const midY = 0.5 * (minY + maxY);
        const toX = (x) => cssW * 0.5 + (x - midX) * scale;
        const toY = (y) => cssH * 0.5 - (y - midY) * scale;

        // Subtle grid
        ctx.strokeStyle = "rgba(27,67,50,0.07)";
        ctx.lineWidth = 1;
        const step = window.AppGeo.chooseScaleBar((maxX - minX) * 1.4);
        ctx.beginPath();
        for (let gx = Math.floor(minX / step) * step; gx <= maxX; gx += step) {
            const px = toX(gx); ctx.moveTo(px, 0); ctx.lineTo(px, cssH);
        }
        for (let gy = Math.floor(minY / step) * step; gy <= maxY; gy += step) {
            const py = toY(gy); ctx.moveTo(0, py); ctx.lineTo(cssW, py);
        }
        ctx.stroke();

        const hits = [];
        proj.forEach(({ it, outerM, cx, cy }) => {
            const isSel = it.uid === selectedUid;
            const col = window.AppAsApplied.getCropColor(it.crop);
            const lx = toX(cx), ly = toY(cy);
            hits.push({ uid: it.uid, cx: lx, cy: ly });

            ctx.save();
            ctx.fillStyle = col;
            ctx.globalAlpha = isSel ? 0.95 : 0.78;
            ctx.strokeStyle = isSel ? "#0f172a" : "#1e293b";
            ctx.lineWidth = isSel ? 2.4 : 1.0;

            if (outerM.length > 0) {
                for (const ring of outerM) {
                    ctx.beginPath();
                    for (let i = 0; i < ring.length; i++) {
                        const px = toX(ring[i][0]), py = toY(ring[i][1]);
                        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                    }
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                }
            } else {
                ctx.beginPath();
                ctx.arc(lx, ly, isSel ? 7 : 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();

            // Label if few fields or selected
            if (isSel || items.length <= 20) {
                ctx.save();
                ctx.font = isSel ? "bold 10.5px system-ui, sans-serif" : "600 9.5px system-ui, sans-serif";
                const tw = ctx.measureText(it.name).width;
                const pw = tw + 8, ph = 15;
                const px = Math.max(4, Math.min(cssW - pw - 4, lx - pw * 0.5));
                const py = Math.max(4, Math.min(cssH - ph - 4, ly - ph * 0.5));
                ctx.fillStyle = isSel ? "#1b4332" : "rgba(255,255,255,0.88)";
                ctx.strokeStyle = isSel ? "#f59e0b" : "#94a3b8";
                ctx.lineWidth = 0.8;
                roundRect(ctx, px, py, pw, ph, 3.5);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = isSel ? "#ffffff" : "#0f172a";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(it.name, px + pw * 0.5, py + ph * 0.5 + 0.5);
                ctx.restore();
            }
        });

        // Crop legend box top-left
        const cropsPresent = Array.from(new Set(items.map(i => i.crop)));
        if (cropsPresent.length > 0) {
            ctx.save();
            const lh = 16;
            const boxH = 12 + cropsPresent.length * lh;
            const boxW = 165;
            ctx.fillStyle = "rgba(255,255,255,0.92)";
            ctx.strokeStyle = "#cbd5e1";
            ctx.lineWidth = 1;
            roundRect(ctx, 10, 10, boxW, boxH, 6);
            ctx.fill();
            ctx.stroke();
            ctx.font = "600 10px system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            cropsPresent.forEach((c, idx) => {
                const y = 16 + idx * lh + 5;
                ctx.fillStyle = window.AppAsApplied.getCropColor(c);
                ctx.fillRect(18, y - 4.5, 10, 9);
                ctx.strokeStyle = "#334155";
                ctx.lineWidth = 0.6;
                ctx.strokeRect(18, y - 4.5, 10, 9);
                ctx.fillStyle = TEXT_DARK;
                ctx.fillText(c.slice(0, 22), 33, y);
            });
            ctx.restore();
        }

        drawScaleAndNorth(ctx, cssW, cssH, scale);
        return hits;
    }

    /**
     * Draw one A4 Landscape Soll-Ist comparison page into an existing jsPDF document.
     */
    function addFieldComparisonPdfPage(doc, farmName, item, idx1, pageNum, totalPages, options) {
        const W = 297, H = 210;
        const raster = window.AppAsApplied.rasterizeAsAppliedField(item, options.useOffset);
        const scaleRange = computeSharedScale(item);
        const [vmin, vmax] = scaleRange;
        const todayStr = new Date().toLocaleDateString("de-DE");

        // Header
        doc.setFillColor(27, 67, 50);
        doc.rect(0, 0, W, 22, "F");
        doc.setFillColor(64, 145, 108);
        doc.rect(0, 20.8, W, 1.2, "F");

        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        const numPrefix = idx1 ? `${String(idx1).padStart(2, "0")}. ` : "";
        doc.text(`${numPrefix}${item.name}  (${window.AppGeo.fmtDe(item.areaHa || item.workedHa, 2)} ha)`, 8, 9.5);

        doc.setTextColor(216, 243, 220);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.4);
        doc.text(`Kultur: ${item.crop}  |  Dünger: ${item.productLabel}  |  Datum: ${item.dateDe} (${item.timeSpan})`, 8, 16.5);

        doc.setTextColor(183, 228, 199);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.text("SOLL / IST-VERGLEICH (AS-APPLIED)", W - 8, 9.2, { align: "right" });

        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.text(`${farmName}  •  Arbeitsbreite ${window.AppGeo.fmtDe(item.modeWidth, 1)} m`, W - 8, 16.0, { align: "right" });

        // Map Titles
        doc.setTextColor(27, 67, 50);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9.5);
        const sollTitle = item.sollGrd
            ? `Soll-Applikationskarte (${item.sollGrd.grdName}.BIN – ${item.sollGrd.nCols}×${item.sollGrd.nRows})`
            : "Soll-Vorgabe (TLG DDI 0006)";
        const offsetLbl = options.useOffset && item.avgShiftM < -0.5
            ? `inkl. Wurfweiten-Korrektur ${window.AppGeo.fmtDe(item.avgShiftM, 1)} m`
            : "Roh-GPS ohne Versatz";
        doc.text(sollTitle, 8, 29);
        doc.text(`Ist-Ausbringung (${item.tlgNames[0] || "TLG"} – ${offsetLbl})`, 153, 29);

        // Render both maps at high DPI on IDENTICAL shared color scale
        const cSoll = document.createElement("canvas");
        const cIst = document.createElement("canvas");
        renderComparisonMapCanvas(cSoll, item, raster, "soll", scaleRange, options, 540, 410, 2);
        renderComparisonMapCanvas(cIst, item, raster, "ist", scaleRange, options, 540, 410, 2);

        doc.setDrawColor(203, 213, 225);
        doc.rect(8, 31.5, 136, 102);
        doc.addImage(cSoll.toDataURL("image/png"), "PNG", 8.4, 31.9, 135.2, 101.2);

        doc.rect(153, 31.5, 136, 102);
        doc.addImage(cIst.toDataURL("image/png"), "PNG", 153.4, 31.9, 135.2, 101.2);

        // Shared horizontal colorbar centered underneath both maps
        const cbW = 160, cbH = 4.2, cbX = (W - cbW) * 0.5, cbY = 137.5;
        const steps = 48;
        for (let s = 0; s < steps; s++) {
            const val = vmin + (s / (steps - 1)) * (vmax - vmin);
            const [r, g, b] = fertRgb(val, vmin, vmax);
            doc.setFillColor(r, g, b);
            doc.rect(cbX + (s * cbW) / steps, cbY, cbW / steps + 0.3, cbH, "F");
        }
        doc.setDrawColor(203, 213, 225);
        doc.rect(cbX, cbY, cbW, cbH);
        doc.setTextColor(15, 23, 42);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.6);
        doc.text(`${window.AppGeo.fmtDe(vmin, 0)} kg/ha`, cbX, cbY + 7.5);
        doc.text(`${window.AppGeo.fmtDe(0.5 * (vmin + vmax), 0)} kg/ha  (Gemeinsame Farbskala Soll & Ist)`, cbX + cbW * 0.5, cbY + 7.5, { align: "center" });
        doc.text(`${window.AppGeo.fmtDe(vmax, 0)} kg/ha`, cbX + cbW, cbY + 7.5, { align: "right" });

        // Bottom KPI & Soll-Ist Comparison Box
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(226, 232, 240);
        doc.roundedRect(8, 150, 281, 46, 2, 2, "FD");

        // Left: Soll vs Ist Table
        doc.setTextColor(27, 67, 50);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9.2);
        doc.text("Soll / Ist-Kennzahlen im Vergleich", 13, 157);

        const diffSign = (v) => (v > 0 ? `+${window.AppGeo.fmtDe(v, 1)} %` : `${window.AppGeo.fmtDe(v, 1)} %`);
        const kgDiffPct = (item.sollTotalKg && item.sollTotalKg > 0)
            ? ((item.totKg - item.sollTotalKg) / item.sollTotalKg) * 100.0
            : null;

        const cmpRows = [
            ["Kennzahl", "Soll", "Ist (RAUCH)", "Abweichung"],
            [
                "Ø Streumenge",
                item.avgSoll !== null ? `${window.AppGeo.fmtDe(item.avgSoll, 1)} kg/ha` : "–",
                `${window.AppGeo.fmtDe(item.avgArPts, 1)} kg/ha`,
                item.diffPct !== null ? diffSign(item.diffPct) : "–",
            ],
            [
                "Gesamtmenge",
                item.sollTotalKg !== null ? `${window.AppGeo.fmtDe(item.sollTotalKg, 0)} kg` : "–",
                `${window.AppGeo.fmtDe(item.totKg, 0)} kg`,
                kgDiffPct !== null ? diffSign(kgDiffPct) : "–",
            ],
            [
                "Fläche (ha)",
                `${window.AppGeo.fmtDe(item.areaHa, 2)} ha`,
                `${window.AppGeo.fmtDe(item.workedHa, 2)} ha`,
                item.areaHa > 0 ? diffSign(((item.workedHa - item.areaHa) / item.areaHa) * 100) : "–",
            ],
            [
                "Spanne / Breite",
                item.sollStats ? `${window.AppGeo.fmtDe(item.sollStats.minRate, 0)}–${window.AppGeo.fmtDe(item.sollStats.maxRate, 0)} kg/ha` : "–",
                `${window.AppGeo.fmtDe(item.minAr, 0)}–${window.AppGeo.fmtDe(item.maxAr, 0)} kg/ha`,
                `Ø ${window.AppGeo.fmtDe(item.modeWidth, 1)} m`,
            ],
        ];

        const cx = [13, 52, 84, 120];
        let y = 163;
        cmpRows.forEach((row, ri) => {
            if (ri === 0) {
                doc.setFillColor(27, 67, 50);
                doc.rect(12, y - 4, 134, 5.5, "F");
                doc.setTextColor(255, 255, 255);
                doc.setFont("helvetica", "bold");
                doc.setFontSize(7.6);
            } else {
                if (ri % 2 === 0) {
                    doc.setFillColor(238, 242, 246);
                    doc.rect(12, y - 3.8, 134, 5.5, "F");
                }
                doc.setTextColor(15, 23, 42);
                doc.setFont("helvetica", ri === 0 ? "bold" : "normal");
                doc.setFontSize(7.8);
            }
            row.forEach((cell, ci) => {
                if (ri > 0 && ci === 0) doc.setFont("helvetica", "bold");
                else if (ri > 0) doc.setFont("helvetica", "normal");
                doc.text(cell, cx[ci], y);
            });
            y += 6.0;
        });

        // Right: Soll Zones or Diagnostics
        doc.setTextColor(27, 67, 50);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9.2);
        doc.text(item.sollStats ? "Soll-Zonenverteilung (GRD)" : "Technische Streudaten (TLG)", 155, 157);

        if (item.sollStats && item.sollStats.zones.length > 0 && item.sollStats.zones.length <= 7) {
            const zList = item.sollStats.zones;
            const barStart = 179, barMaxW = 72;
            const stepY = Math.min(6.4, 32 / zList.length);
            zList.forEach((z, zi) => {
                const by = 161 + zi * stepY;
                const [r, g, b] = fertRgb(z.rate, vmin, vmax);
                doc.setFont("helvetica", "bold");
                doc.setFontSize(7.6);
                doc.setTextColor(15, 23, 42);
                doc.text(`${window.AppGeo.fmtDe(z.rate, 1)} kg/ha`, 155, by + 3.4);

                doc.setFillColor(226, 232, 240);
                doc.rect(barStart, by + 0.4, barMaxW, stepY - 1.8, "F");
                doc.setFillColor(r, g, b);
                doc.rect(barStart, by + 0.4, Math.max(1, (z.pct / 100) * barMaxW), stepY - 1.8, "F");

                doc.setFont("helvetica", "normal");
                doc.setTextColor(71, 85, 105);
                doc.text(`${window.AppGeo.fmtDe(z.pct, 1)} %`, barStart + barMaxW + 4, by + 3.4);
            });
        } else {
            const diag = [
                ["Messpunkte (aktiv):", `${item.activePts.length}`],
                ["Arbeitsbreiten:", item.distinctWidths.map(w => `${window.AppGeo.fmtDe(w, 1)} m`).join(", ")],
                ["Wurfweiten-Versatz:", item.avgShiftM < -0.5 ? `${window.AppGeo.fmtDe(item.avgShiftM, 2)} m` : "kein Offset gemeldet"],
                ["Zonendeckung (±10 %):", item.matchStats.within10Pct !== null ? `${window.AppGeo.fmtDe(item.matchStats.within10Pct, 1)} %` : "–"],
                ["Waage (DDI 004B):", item.binDeltaKg ? `${window.AppGeo.fmtDe(item.binDeltaKg, 0)} kg Verbrauch` : "–"],
            ];
            let dy = 163;
            doc.setFontSize(8.0);
            for (const [k, v] of diag) {
                doc.setFont("helvetica", "bold"); doc.setTextColor(71, 85, 105); doc.text(k, 155, dy);
                doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42); doc.text(v, 198, dy);
                dy += 6.0;
            }
        }

        // Footer
        doc.setDrawColor(226, 232, 240);
        doc.line(8, H - 10, W - 8, H - 10);
        doc.setTextColor(100, 116, 139);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7.4);
        const tlgList = item.tlgNames.slice(0, 4).join(", ");
        doc.text(`Quelle: ISOXML TASKDATA (${item.id} | ${tlgList})  •  Soll (GRD / DDI 0006) vs. Ist (DDI 0007, ${offsetLbl})`, 8, H - 5.5);
        doc.text(`Erstellt am ${todayStr}  •  Seite ${pageNum} / ${totalPages}`, W - 8, H - 5.5, { align: "right" });
    }

    /**
     * Generate single-field Soll-Ist comparison PDF (1 crisp A4 landscape page).
     */
    function generateSingleFieldPdf(dataset, item, options) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
        addFieldComparisonPdfPage(doc, dataset.farmName, item, null, 1, 1, options);
        return doc.output("blob");
    }

    /**
     * Generate multi-field Soll-Ist & As-Applied Control Report PDF.
     */
    async function generateMultiFieldPdf(dataset, items, options, onProgress) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
        const W = 297, H = 210;
        const todayStr = new Date().toLocaleDateString("de-DE");
        const report = (p, m) => { if (typeof onProgress === "function") onProgress(p, m); };

        const rowsPerTablePage = 24;
        const tablePages = Math.max(1, Math.ceil(items.length / rowsPerTablePage));
        const totalPages = 1 + tablePages + items.length;

        const totArea = items.reduce((s, it) => s + (it.areaHa || it.workedHa), 0);
        const totWorked = items.reduce((s, it) => s + it.workedHa, 0);
        const totKg = items.reduce((s, it) => s + it.totKg, 0);
        const avgIst = totWorked > 0.1 ? totKg / totWorked : (items.reduce((s, it) => s + it.avgArPts, 0) / Math.max(1, items.length));

        // Page 1: Cover + Crop Overview Map
        report(4, "Erzeuge Deckblatt & Kultur-Übersichtskarte…");
        doc.setFillColor(27, 67, 50);
        doc.rect(0, 0, W, 22, "F");
        doc.setFillColor(64, 145, 108);
        doc.rect(0, 20.8, W, 1.2, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14.5);
        doc.text(`As-Applied & Soll/Ist-Auswertung (${dataset.farmName})`, 8, 9.5);
        doc.setTextColor(216, 243, 220);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.text(`Zeitraum: ${dataset.dateRangeDe}  •  Quelle: ${dataset.sourceLabel}`, 8, 16.5);
        doc.setTextColor(183, 228, 199);
        doc.setFont("helvetica", "bold");
        doc.text("RAUCH / CC-ISOBUS AUSWERTUNG", W - 8, 9.2, { align: "right" });
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "normal");
        doc.text(`Erstellt am ${todayStr}`, W - 8, 16.0, { align: "right" });

        // KPI Row
        const kpis = [
            { l: "Ausgewertete Schläge", v: `${items.length} Felder` },
            { l: "Bearbeitete Fläche", v: `${window.AppGeo.fmtDe(totWorked || totArea, 2)} ha` },
            { l: "Gesamte Düngermenge", v: `${window.AppGeo.fmtDe(totKg / 1000, 2)} t (${window.AppGeo.fmtDe(totKg, 0)} kg)` },
            { l: "Ø Ist-Streumenge", v: `${window.AppGeo.fmtDe(avgIst, 1)} kg/ha` },
        ];
        const cardW = (W - 16 - 9) / 4;
        kpis.forEach((k, i) => {
            const cx = 8 + i * (cardW + 3);
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(226, 232, 240);
            doc.roundedRect(cx, 27, cardW, 18, 2, 2, "FD");
            doc.setTextColor(71, 85, 105); doc.setFont("helvetica", "normal"); doc.setFontSize(8);
            doc.text(k.l, cx + 4, 33);
            doc.setTextColor(15, 23, 42); doc.setFont("helvetica", "bold"); doc.setFontSize(11.5);
            doc.text(k.v, cx + 4, 41.5);
        });

        const ovCanvas = document.createElement("canvas");
        renderCropOverviewCanvas(ovCanvas, items, null, 920, 520, 2);
        doc.setDrawColor(203, 213, 225);
        doc.rect(8, 49, W - 16, 146);
        doc.addImage(ovCanvas.toDataURL("image/png"), "PNG", 8.5, 49.5, W - 17, 145);

        doc.setDrawColor(226, 232, 240);
        doc.line(8, H - 10, W - 8, H - 10);
        doc.setTextColor(100, 116, 139); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
        doc.text(`As-Applied & Soll/Ist-Gesamtbericht  •  ${dataset.farmName}`, 8, H - 5.5);
        doc.text(`Seite 1 / ${totalPages}`, W - 8, H - 5.5, { align: "right" });

        // Summary Table Pages
        for (let tp = 0; tp < tablePages; tp++) {
            doc.addPage();
            const pageNum = 2 + tp;
            doc.setFillColor(27, 67, 50); doc.rect(0, 0, W, 22, "F");
            doc.setFillColor(64, 145, 108); doc.rect(0, 20.8, W, 1.2, "F");
            doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(14);
            doc.text(`Schlagverzeichnis Soll / Ist (${tp + 1}/${tablePages})`, 8, 9.5);
            doc.setTextColor(216, 243, 220); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
            doc.text(`${items.length} Schläge  •  ${window.AppGeo.fmtDe(totKg / 1000, 2)} t gesamt`, 8, 16.5);

            let ty = 29;
            const cols = [8, 17, 68, 102, 124, 164, 184, 206, 228, 250, 272];
            doc.setFillColor(27, 67, 50);
            doc.rect(8, ty, W - 16, 7, "F");
            doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(7.5);
            ["Nr", "Schlagname", "Kultur", "Datum", "Produkt", "Fläche", "Ø Soll", "Ø Ist", "Abw.", "Ist (kg)", "Breite"].forEach((h, hi) => {
                doc.text(h, cols[hi] + (hi === 0 ? 1.5 : 0), ty + 4.8);
            });
            ty += 7;

            const slice = items.slice(tp * rowsPerTablePage, (tp + 1) * rowsPerTablePage);
            doc.setFont("helvetica", "normal"); doc.setFontSize(7.4);
            slice.forEach((it, si) => {
                const absIdx = tp * rowsPerTablePage + si + 1;
                if (si % 2 === 1) { doc.setFillColor(248, 250, 252); doc.rect(8, ty, W - 16, 6.2, "F"); }
                doc.setTextColor(15, 23, 42);
                doc.text(String(absIdx).padStart(2, "0"), cols[0] + 1.5, ty + 4.3);
                doc.text(it.name.slice(0, 26), cols[1], ty + 4.3);
                doc.text(it.crop.slice(0, 17), cols[2], ty + 4.3);
                doc.text(it.dateDe.slice(0, 10), cols[3], ty + 4.3);
                doc.text(it.productLabel.slice(0, 20), cols[4], ty + 4.3);
                doc.text(`${window.AppGeo.fmtDe(it.areaHa || it.workedHa, 2)} ha`, cols[5], ty + 4.3);
                doc.text(it.avgSoll !== null ? `${window.AppGeo.fmtDe(it.avgSoll, 1)}` : "–", cols[6], ty + 4.3);
                doc.text(`${window.AppGeo.fmtDe(it.avgArPts, 1)}`, cols[7], ty + 4.3);
                doc.text(it.diffPct !== null ? `${it.diffPct > 0 ? "+" : ""}${window.AppGeo.fmtDe(it.diffPct, 1)}%` : "–", cols[8], ty + 4.3);
                doc.text(window.AppGeo.fmtDe(it.totKg, 0), cols[9], ty + 4.3);
                doc.text(`${window.AppGeo.fmtDe(it.modeWidth, 1)} m`, cols[10], ty + 4.3);
                ty += 6.2;
            });

            doc.setDrawColor(226, 232, 240); doc.line(8, H - 10, W - 8, H - 10);
            doc.setTextColor(100, 116, 139); doc.setFontSize(7.5);
            doc.text(`As-Applied & Soll/Ist-Gesamtbericht  •  ${dataset.farmName}`, 8, H - 5.5);
            doc.text(`Seite ${pageNum} / ${totalPages}`, W - 8, H - 5.5, { align: "right" });
        }

        // Individual Soll-Ist Comparison Pages
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            report(10 + Math.round(((i + 1) / items.length) * 86), `Rendere Soll-Ist-Seite ${i + 1}/${items.length}: ${it.name}…`);
            await new Promise(r => setTimeout(r, 0));
            doc.addPage();
            addFieldComparisonPdfPage(doc, dataset.farmName, it, i + 1, 1 + tablePages + i + 1, totalPages, options);
        }

        report(98, "Speichere PDF…");
        return doc.output("blob");
    }

    return {
        fertCss,
        computeSharedScale,
        renderComparisonMapCanvas,
        renderCropOverviewCanvas,
        generateSingleFieldPdf,
        generateMultiFieldPdf,
    };
})();
