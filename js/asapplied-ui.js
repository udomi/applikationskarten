/**
 * asapplied-ui.js — UI controller for top-level mode switcher & Tab 2 (Soll/Ist & As-Applied Auswertung).
 */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const aaState = {
        dataset: null,
        filtered: [],
        activeUid: null,
        subTab: "compare", // "compare" | "overview" | "table"
        sollTf: null,
        istTf: null,
        overviewHits: [],
    };

    // ==================== TOP-LEVEL MODE SWITCHER ====================
    function switchTopMode(mode) {
        document.querySelectorAll(".mode-tab-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.mode === mode);
        });
        $("viewCreate").classList.toggle("hidden", mode !== "create");
        $("viewAsApplied").classList.toggle("hidden", mode !== "asapplied");

        // Trigger crisp canvas redraw after becoming visible
        if (mode === "asapplied") {
            setTimeout(() => renderAaCurrentTab(), 20);
        } else {
            window.dispatchEvent(new Event("resize"));
        }
    }

    document.querySelectorAll(".mode-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => switchTopMode(btn.dataset.mode));
    });

    // ==================== ELEMENTS ====================
    const elBtnFolder = $("aaBtnFolder");
    const elFolderInput = $("aaFolderInput");
    const elDropzone = $("aaDropzone");
    const elZipInput = $("aaZipInput");
    const elProgressWrap = $("aaProgressWrap");
    const elProgressFill = $("aaProgressFill");
    const elProgressText = $("aaProgressText");
    const elError = $("aaUploadError");
    const elSummary = $("aaFileSummary");
    const elFilterWrap = $("aaFilterWrap");

    const elCard1 = $("aaCardStep1");
    const elCard2 = $("aaCardStep2");
    const elCard3 = $("aaCardStep3");

    const elCropFilter = $("aaCropFilter");
    const elSearchInput = $("aaSearchInput");
    const elOnlyGrd = $("aaOnlyGrd");

    const elUseOffset = $("aaUseOffset");
    const elSharedScale = $("aaSharedScale");
    const elShowTracks = $("aaShowTracks");

    const elBtnSinglePdf = $("aaBtnSinglePdf");
    const elBtnAllPdf = $("aaBtnAllPdf");
    const elBtnCsv = $("aaBtnCsv");
    const elExportStatus = $("aaExportStatus");

    const elEmptyState = $("aaEmptyState");
    const elTabCompare = $("aaTabCompare");
    const elTabOverview = $("aaTabOverview");
    const elTabTable = $("aaTabTable");

    const elFieldSelector = $("aaFieldSelector");
    const elMetaBadges = $("aaFieldMetaBadges");
    const elSollCanvas = $("aaSollCanvas");
    const elIstCanvas = $("aaIstCanvas");
    const elSollTooltip = $("aaSollTooltip");
    const elIstTooltip = $("aaIstTooltip");
    const elOverviewCanvas = $("aaOverviewCanvas");

    function escapeHtml(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function getOptions() {
        return {
            useOffset: elUseOffset.checked,
            sharedScale: elSharedScale.checked,
            showTracks: elShowTracks.checked,
        };
    }

    function showError(msg) {
        if (!msg) {
            elError.classList.add("hidden");
            elError.textContent = "";
        } else {
            elError.classList.remove("hidden");
            elError.textContent = msg;
        }
    }

    // ==================== STEP 1: LOAD TASKDATA ====================
    async function handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        showError("");
        elExportStatus.classList.add("hidden");
        elProgressWrap.classList.remove("hidden");
        elProgressFill.style.width = "5%";
        elProgressText.textContent = "Lese TASKDATA-Dateien…";

        try {
            const ds = await window.AppAsApplied.parseTaskdataDataset(fileList, (pct, msg) => {
                elProgressFill.style.width = `${Math.max(3, Math.min(100, pct))}%`;
                elProgressText.textContent = msg;
            });
            aaState.dataset = ds;

            // Populate crop filter
            elCropFilter.innerHTML = `<option value="all">Alle Kulturen (${ds.activeFields.length})</option>`;
            ds.cropsList.forEach(c => {
                const cnt = ds.activeFields.filter(f => f.crop === c).length;
                const opt = document.createElement("option");
                opt.value = c;
                opt.textContent = `${c} (${cnt})`;
                elCropFilter.appendChild(opt);
            });
            elSearchInput.value = "";
            elOnlyGrd.checked = false;

            const withGrd = ds.activeFields.filter(f => f.sollGrd).length;
            $("aaFarmNameLabel").textContent = ds.farmName;
            $("aaFieldCountLabel").textContent = `${ds.activeFields.length} Schläge`;
            const tractorHint = ds.deviceInfo.tractorName ? ` • ${ds.deviceInfo.tractorName}` : "";
            $("aaFileMetaLabel").textContent = `${ds.dateRangeDe} • ${withGrd} mit Soll-Karte (GRD)${tractorHint}`;
            elSummary.classList.remove("hidden");
            elFilterWrap.classList.remove("hidden");

            elCard1.classList.add("is-done");
            elCard2.classList.remove("is-disabled");
            elCard3.classList.remove("is-disabled");

            applyFilterAndRender();
        } catch (err) {
            showError(err.message || String(err));
            elProgressText.textContent = "Fehler beim Einlesen.";
        }
    }

    function applyFilterAndRender() {
        if (!aaState.dataset) return;
        const cropVal = elCropFilter.value;
        const q = (elSearchInput.value || "").trim().toLowerCase();
        const onlyGrd = elOnlyGrd.checked;

        aaState.filtered = aaState.dataset.activeFields.filter(it => {
            if (cropVal !== "all" && it.crop !== cropVal) return false;
            if (onlyGrd && !it.sollGrd) return false;
            if (q && !it.name.toLowerCase().includes(q) && !it.productLabel.toLowerCase().includes(q)) return false;
            return true;
        });

        if (aaState.filtered.length > 0 && !aaState.filtered.some(f => f.uid === aaState.activeUid)) {
            aaState.activeUid = aaState.filtered[0].uid;
        } else if (aaState.filtered.length === 0) {
            aaState.activeUid = null;
        }

        const hasItems = aaState.filtered.length > 0;
        elBtnSinglePdf.disabled = !hasItems;
        elBtnAllPdf.disabled = !hasItems;
        elBtnCsv.disabled = !hasItems;

        updateKpis();
        populateFieldSelector();
        showSubTab(aaState.subTab);
    }

    function updateKpis() {
        const items = aaState.filtered;
        if (!aaState.dataset) {
            $("aaKpiFields").textContent = "–";
            $("aaKpiFieldsSub").textContent = "Noch keine TASKDATA geladen";
            $("aaKpiArea").textContent = "–";
            $("aaKpiAreaSub").textContent = "Hektar (ha)";
            $("aaKpiTotal").textContent = "–";
            $("aaKpiTotalSub").textContent = "–";
            $("aaKpiAvg").textContent = "–";
            $("aaKpiAvgSub").textContent = "Soll vs. Ist";
            return;
        }

        const withGrd = items.filter(f => f.sollGrd).length;
        const totWorked = items.reduce((s, f) => s + (f.workedHa > 0.01 ? f.workedHa : f.areaHa), 0);
        const totFieldHa = items.reduce((s, f) => s + f.areaHa, 0);
        const totKg = items.reduce((s, f) => s + f.totKg, 0);
        const avgIst = totWorked > 0.05 ? totKg / totWorked : 0;

        // Weighted average Soll across fields with Soll
        let sollKgSum = 0, sollAreaSum = 0;
        for (const f of items) {
            if (f.avgSoll !== null) {
                const a = f.areaHa > 0.01 ? f.areaHa : f.workedHa;
                sollKgSum += f.avgSoll * a;
                sollAreaSum += a;
            }
        }
        const avgSoll = sollAreaSum > 0.05 ? sollKgSum / sollAreaSum : null;

        $("aaKpiFields").textContent = `${items.length}`;
        $("aaKpiFieldsSub").textContent = `davon ${withGrd} mit Soll-Karte (GRD)`;
        $("aaKpiArea").textContent = `${window.AppGeo.fmtDe(totWorked, 2)} ha`;
        $("aaKpiAreaSub").textContent = `Schlagfläche: ${window.AppGeo.fmtDe(totFieldHa, 2)} ha`;
        $("aaKpiTotal").textContent = `${window.AppGeo.fmtDe(totKg / 1000.0, 2)} t`;
        $("aaKpiTotalSub").textContent = `${window.AppGeo.fmtDe(totKg, 0)} kg ausgebracht`;
        $("aaKpiAvg").textContent = `${window.AppGeo.fmtDe(avgIst, 1)} kg/ha`;
        if (avgSoll !== null) {
            const diff = ((avgIst - avgSoll) / avgSoll) * 100.0;
            const sign = diff > 0 ? "+" : "";
            $("aaKpiAvgSub").textContent = `Soll Ø ${window.AppGeo.fmtDe(avgSoll, 1)} kg/ha (${sign}${window.AppGeo.fmtDe(diff, 1)} %)`;
        } else {
            $("aaKpiAvgSub").textContent = "Ist-Durchschnitt";
        }
    }

    function populateFieldSelector() {
        elFieldSelector.innerHTML = "";
        aaState.filtered.forEach((it, idx) => {
            const opt = document.createElement("option");
            opt.value = it.uid;
            const grdMark = it.sollGrd ? "✓" : "○";
            opt.textContent = `${String(idx + 1).padStart(2, "0")}. ${it.name} – ${it.crop} (${window.AppGeo.fmtDe(it.areaHa || it.workedHa, 2)} ha) ${grdMark}`;
            if (it.uid === aaState.activeUid) opt.selected = true;
            elFieldSelector.appendChild(opt);
        });
    }

    // ==================== SUB-TABS ====================
    function showSubTab(tabName) {
        aaState.subTab = tabName;
        document.querySelectorAll(".aa-tab-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.aatab === tabName);
        });

        if (!aaState.dataset) {
            elEmptyState.classList.remove("hidden");
            elTabCompare.classList.add("hidden");
            elTabOverview.classList.add("hidden");
            elTabTable.classList.add("hidden");
            return;
        }

        elEmptyState.classList.add("hidden");
        elTabCompare.classList.toggle("hidden", tabName !== "compare");
        elTabOverview.classList.toggle("hidden", tabName !== "overview");
        elTabTable.classList.toggle("hidden", tabName !== "table");

        renderAaCurrentTab();
    }

    function renderAaCurrentTab() {
        if (!aaState.dataset) return;
        if (aaState.subTab === "compare") renderCompareTab();
        else if (aaState.subTab === "overview") renderOverviewTab();
        else if (aaState.subTab === "table") renderTableTab();
    }

    function renderCompareTab() {
        if (aaState.filtered.length === 0) {
            $("aaCompareBody").classList.add("hidden");
            $("aaNoFilterMatch").classList.remove("hidden");
            return;
        }
        $("aaCompareBody").classList.remove("hidden");
        $("aaNoFilterMatch").classList.add("hidden");

        const item = aaState.filtered.find(f => f.uid === aaState.activeUid) || aaState.filtered[0];
        aaState.activeUid = item.uid;
        elFieldSelector.value = item.uid;

        const opts = getOptions();
        const raster = window.AppAsApplied.rasterizeAsAppliedField(item, opts.useOffset);

        // Badges
        const offsetBadge = opts.useOffset && item.avgShiftM < -0.5
            ? `<span class="meta-badge">Wurfweite ${window.AppGeo.fmtDe(item.avgShiftM, 1)} m</span>`
            : "";
        elMetaBadges.innerHTML = `
            <span class="meta-badge">${escapeHtml(item.crop)}</span>
            <span class="meta-badge">${escapeHtml(item.dateDe)} (${escapeHtml(item.timeSpan)})</span>
            <span class="meta-badge">${escapeHtml(item.productLabel)}</span>
            <span class="meta-badge">${window.AppGeo.fmtDe(item.modeWidth, 1)} m Breite</span>
            ${offsetBadge}
        `;

        // Titles
        $("aaSollTitle").textContent = item.sollGrd
            ? `Soll-Applikationskarte (${item.sollGrd.grdName}.BIN)`
            : "Soll-Vorgabe (TLG DDI 0006)";
        $("aaSollSub").textContent = item.sollStats
            ? `${item.sollGrd.nCols}×${item.sollGrd.nRows} (${window.AppGeo.fmtDe(item.sollStats.cellW_m, 1)} m)`
            : (item.avgTrTlg ? "aus Protokoll" : "keine GRD");

        $("aaIstTitle").textContent = `Ist-Ausbringung (As-Applied)`;
        $("aaIstSub").textContent = `${item.tlgNames[0] || "TLG"} • ${item.activePts.length} Punkte`;

        // Color scales
        const sharedRange = window.AppAsAppliedRenderer.computeSharedScale(item);
        let sollRange = sharedRange;
        let istRange = sharedRange;
        if (!opts.sharedScale) {
            if (item.sollStats && item.sollStats.maxRate > item.sollStats.minRate + 5) {
                sollRange = [Math.floor(item.sollStats.minRate - 5), Math.ceil(item.sollStats.maxRate + 5)];
            }
            if (item.maxAr > item.minAr + 5) {
                istRange = [Math.floor(item.minAr - 5), Math.ceil(item.maxAr + 5)];
            }
        }

        const wSoll = Math.max(280, Math.floor($("aaSollCanvasWrap").clientWidth || 440));
        const wIst = Math.max(280, Math.floor($("aaIstCanvasWrap").clientWidth || 440));
        const mapH = Math.round(Math.min(400, Math.max(280, wSoll * 0.78)));

        aaState.sollTf = window.AppAsAppliedRenderer.renderComparisonMapCanvas(
            elSollCanvas, item, raster, "soll", sollRange, opts, wSoll, mapH
        );
        aaState.istTf = window.AppAsAppliedRenderer.renderComparisonMapCanvas(
            elIstCanvas, item, raster, "ist", istRange, opts, wIst, mapH
        );

        // Colorbar labels
        $("aaSollMin").textContent = `${window.AppGeo.fmtDe(sollRange[0], 0)} kg/ha`;
        $("aaSollMid").textContent = `${window.AppGeo.fmtDe(0.5 * (sollRange[0] + sollRange[1]), 0)} kg/ha`;
        $("aaSollMax").textContent = `${window.AppGeo.fmtDe(sollRange[1], 0)} kg/ha`;

        $("aaIstMin").textContent = `${window.AppGeo.fmtDe(istRange[0], 0)} kg/ha`;
        $("aaIstMid").textContent = `${window.AppGeo.fmtDe(0.5 * (istRange[0] + istRange[1]), 0)} kg/ha`;
        $("aaIstMax").textContent = `${window.AppGeo.fmtDe(istRange[1], 0)} kg/ha`;

        // Soll-vs-Ist comparison table
        const fmtDiff = (v) => {
            if (v === null || Number.isNaN(v)) return "–";
            const sign = v > 0 ? "+" : "";
            const cls = Math.abs(v) <= 5 ? "diff-ok" : (Math.abs(v) <= 12 ? "diff-warn" : "diff-high");
            return `<span class="${cls}">${sign}${window.AppGeo.fmtDe(v, 1)} %</span>`;
        };
        const kgDiff = (item.sollTotalKg && item.sollTotalKg > 0)
            ? ((item.totKg - item.sollTotalKg) / item.sollTotalKg) * 100.0
            : null;
        const areaDiff = item.areaHa > 0.01 ? ((item.workedHa - item.areaHa) / item.areaHa) * 100.0 : null;

        let matchRowHtml = "";
        if (item.matchStats.grdMatchShiftedPct !== null) {
            const activePct = opts.useOffset ? item.matchStats.grdMatchShiftedPct : item.matchStats.grdMatchRawPct;
            matchRowHtml = `
                <tr>
                    <td><strong>Zonen-Deckung (Lage)</strong></td>
                    <td colspan="2" class="num">${opts.useOffset ? "Mit Wurfweiten-Korrektur" : "Roh-GPS ohne Korrektur"}</td>
                    <td class="num"><strong>${window.AppGeo.fmtDe(activePct, 1)} %</strong></td>
                </tr>
            `;
        }
        let binRowHtml = "";
        if (item.binDeltaKg) {
            binRowHtml = `
                <tr>
                    <td><strong>Waagen-Kontrolle (004B)</strong></td>
                    <td colspan="2" class="num">Behältergewicht-Abnahme</td>
                    <td class="num"><strong>${window.AppGeo.fmtDe(item.binDeltaKg, 0)} kg</strong></td>
                </tr>
            `;
        }

        $("aaCmpTableBody").innerHTML = `
            <tr>
                <td><strong>Ø Streumenge</strong></td>
                <td class="num">${item.avgSoll !== null ? window.AppGeo.fmtDe(item.avgSoll, 1) + " kg/ha" : "–"}</td>
                <td class="num"><strong>${window.AppGeo.fmtDe(item.avgArPts, 1)} kg/ha</strong></td>
                <td class="num">${fmtDiff(item.diffPct)}</td>
            </tr>
            <tr>
                <td><strong>Gesamtmenge</strong></td>
                <td class="num">${item.sollTotalKg !== null ? window.AppGeo.fmtDe(item.sollTotalKg, 0) + " kg" : "–"}</td>
                <td class="num"><strong>${window.AppGeo.fmtDe(item.totKg, 0)} kg</strong></td>
                <td class="num">${fmtDiff(kgDiff)}</td>
            </tr>
            <tr>
                <td><strong>Fläche</strong></td>
                <td class="num">${window.AppGeo.fmtDe(item.areaHa, 2)} ha</td>
                <td class="num"><strong>${window.AppGeo.fmtDe(item.workedHa, 2)} ha</strong></td>
                <td class="num">${fmtDiff(areaDiff)}</td>
            </tr>
            <tr>
                <td><strong>Min – Max Rate</strong></td>
                <td class="num">${item.sollStats ? `${window.AppGeo.fmtDe(item.sollStats.minRate, 0)}–${window.AppGeo.fmtDe(item.sollStats.maxRate, 0)}` : "–"}</td>
                <td class="num">${window.AppGeo.fmtDe(item.minAr, 0)}–${window.AppGeo.fmtDe(item.maxAr, 0)} kg/ha</td>
                <td class="num">${item.distinctWidths.map(w => window.AppGeo.fmtDe(w, 1) + "m").join(" / ")}</td>
            </tr>
            ${matchRowHtml}
            ${binRowHtml}
        `;

        // Soll zones breakdown
        const zWrap = $("aaSollZones");
        if (item.sollStats && item.sollStats.zones.length > 0 && item.sollStats.zones.length <= 10) {
            $("aaSollZonesTitle").textContent = `Soll-Zonenverteilung (${item.sollGrd.grdName}.BIN)`;
            zWrap.innerHTML = item.sollStats.zones.map(z => {
                const col = window.AppAsAppliedRenderer.fertCss(z.rate, sollRange[0], sollRange[1]);
                const haZ = (item.areaHa || item.workedHa) * (z.pct / 100.0);
                return `
                    <div class="zone-bar-row">
                        <span class="zone-bar-label">${window.AppGeo.fmtDe(z.rate, 1)} kg/ha</span>
                        <div class="zone-bar-track">
                            <div class="zone-bar-fill" style="width:${z.pct.toFixed(1)}%;background:${col};"></div>
                        </div>
                        <span class="zone-bar-val">${window.AppGeo.fmtDe(z.pct, 1)} % (${window.AppGeo.fmtDe(haZ, 2)} ha)</span>
                    </div>
                `;
            }).join("");
        } else {
            $("aaSollZonesTitle").textContent = "Ist-Ratenverteilung (TLG-Messpunkte)";
            // Build 5-bin histogram of Ist rates
            const bMin = item.minAr, bMax = Math.max(item.minAr + 1, item.maxAr);
            const nBins = 5;
            const counts = new Array(nBins).fill(0);
            for (const p of item.activePts) {
                let bi = Math.floor(((p.ar - bMin) / (bMax - bMin)) * nBins);
                if (bi >= nBins) bi = nBins - 1;
                if (bi < 0) bi = 0;
                counts[bi]++;
            }
            zWrap.innerHTML = counts.map((cnt, bi) => {
                const lo = bMin + (bi / nBins) * (bMax - bMin);
                const hi = bMin + ((bi + 1) / nBins) * (bMax - bMin);
                const pct = (cnt / Math.max(1, item.activePts.length)) * 100.0;
                const col = window.AppAsAppliedRenderer.fertCss(0.5 * (lo + hi), istRange[0], istRange[1]);
                return `
                    <div class="zone-bar-row">
                        <span class="zone-bar-label">${Math.round(lo)}–${Math.round(hi)}</span>
                        <div class="zone-bar-track">
                            <div class="zone-bar-fill" style="width:${pct.toFixed(1)}%;background:${col};"></div>
                        </div>
                        <span class="zone-bar-val">${window.AppGeo.fmtDe(pct, 1)} % (${cnt} Pkt.)</span>
                    </div>
                `;
            }).join("");
        }
    }

    function renderOverviewTab() {
        const wrap = elOverviewCanvas.parentElement;
        const w = Math.max(360, Math.floor(wrap.clientWidth || 860));
        const h = Math.round(Math.min(560, Math.max(360, w * 0.58)));
        aaState.overviewHits = window.AppAsAppliedRenderer.renderCropOverviewCanvas(
            elOverviewCanvas, aaState.filtered, aaState.activeUid, w, h
        );
    }

    function renderTableTab() {
        const tbody = $("aaSummaryBody");
        const tfoot = $("aaSummaryFoot");
        const items = aaState.filtered;

        tbody.innerHTML = items.map((it, i) => {
            const diffStr = it.diffPct !== null
                ? `${it.diffPct > 0 ? "+" : ""}${window.AppGeo.fmtDe(it.diffPct, 1)} %`
                : "–";
            return `
                <tr data-uid="${it.uid}">
                    <td>${i + 1}</td>
                    <td><strong>${escapeHtml(it.name)}</strong></td>
                    <td><span class="crop-dot" style="background:${window.AppAsApplied.getCropColor(it.crop)};"></span>${escapeHtml(it.crop)}</td>
                    <td>${escapeHtml(it.dateDe.slice(0, 10))}</td>
                    <td>${escapeHtml(it.productLabel)}</td>
                    <td class="num">${window.AppGeo.fmtDe(it.areaHa || it.workedHa, 2)}</td>
                    <td class="num">${it.avgSoll !== null ? window.AppGeo.fmtDe(it.avgSoll, 1) : "–"}</td>
                    <td class="num"><strong>${window.AppGeo.fmtDe(it.avgArPts, 1)}</strong></td>
                    <td class="num">${diffStr}</td>
                    <td class="num">${window.AppGeo.fmtDe(it.totKg, 0)}</td>
                    <td class="num">${window.AppGeo.fmtDe(it.modeWidth, 1)} m</td>
                </tr>
            `;
        }).join("");

        const totArea = items.reduce((s, it) => s + (it.areaHa || it.workedHa), 0);
        const totKg = items.reduce((s, it) => s + it.totKg, 0);
        const avgIst = totArea > 0 ? totKg / totArea : 0;
        tfoot.innerHTML = `
            <tr>
                <td></td>
                <td colspan="4">GESAMT (${items.length} Schläge)</td>
                <td class="num">${window.AppGeo.fmtDe(totArea, 2)} ha</td>
                <td></td>
                <td class="num">${window.AppGeo.fmtDe(avgIst, 1)}</td>
                <td></td>
                <td class="num">${window.AppGeo.fmtDe(totKg, 0)} kg (${window.AppGeo.fmtDe(totKg / 1000, 2)} t)</td>
                <td></td>
            </tr>
        `;

        tbody.querySelectorAll("tr").forEach(tr => {
            tr.addEventListener("click", () => {
                aaState.activeUid = tr.dataset.uid;
                showSubTab("compare");
            });
        });
    }

    // ==================== INTERACTIVE HOVER ====================
    function attachHover(canvas, tooltip, getTf) {
        canvas.addEventListener("mousemove", (ev) => {
            const tf = getTf();
            if (!tf || !aaState.activeUid) return;
            const item = aaState.filtered.find(f => f.uid === aaState.activeUid);
            if (!item) return;

            const opts = getOptions();
            const raster = window.AppAsApplied.rasterizeAsAppliedField(item, opts.useOffset);
            const rect = canvas.getBoundingClientRect();
            const px = ev.clientX - rect.left;
            const py = ev.clientY - rect.top;
            const xm = tf.fromX(px);
            const ym = tf.fromY(py);

            // Sample Soll
            let sollVal = NaN;
            if (item.sollGrd && raster.sollExtentM) {
                const g = item.sollGrd;
                const [gx0, gx1, gy0, gy1] = raster.sollExtentM;
                const gc = Math.floor(((xm - gx0) / (gx1 - gx0)) * g.nCols);
                const gr = Math.floor(((ym - gy0) / (gy1 - gy0)) * g.nRows);
                if (gr >= 0 && gr < g.nRows && gc >= 0 && gc < g.nCols) {
                    const v = g.rates[gr * g.nCols + gc];
                    if (v > 0) sollVal = v;
                }
            }
            // Sample Ist (and fallback Soll) from swath raster
            let istVal = NaN;
            const cx = Math.floor((xm - raster.xmin) / raster.res);
            const ry = Math.floor((ym - raster.ymin) / raster.res);
            if (ry >= 0 && ry < raster.ny && cx >= 0 && cx < raster.nx) {
                const idx = ry * raster.nx + cx;
                istVal = raster.rateGrid[idx];
                if (Number.isNaN(sollVal)) sollVal = raster.targetGrid[idx];
            }

            if (!Number.isNaN(sollVal) || !Number.isNaN(istVal)) {
                const parts = [];
                if (!Number.isNaN(sollVal)) parts.push(`Soll: ${window.AppGeo.fmtDe(sollVal, 1)}`);
                if (!Number.isNaN(istVal)) parts.push(`Ist: ${window.AppGeo.fmtDe(istVal, 1)}`);
                if (!Number.isNaN(sollVal) && !Number.isNaN(istVal) && sollVal > 0) {
                    const d = ((istVal - sollVal) / sollVal) * 100.0;
                    parts.push(`(${d > 0 ? "+" : ""}${window.AppGeo.fmtDe(d, 1)} %)`);
                }
                tooltip.textContent = parts.join(" • ") + " kg/ha";
                tooltip.style.left = `${Math.min(rect.width - 210, Math.max(8, px + 12))}px`;
                tooltip.style.top = `${Math.max(8, py - 30)}px`;
                tooltip.classList.remove("hidden");
                return;
            }
            tooltip.classList.add("hidden");
        });
        canvas.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
    }

    // ==================== DOWNLOADS ====================
    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
    }

    function downloadSinglePdf() {
        const item = aaState.filtered.find(f => f.uid === aaState.activeUid);
        if (!item || !aaState.dataset) return;
        const blob = window.AppAsAppliedRenderer.generateSingleFieldPdf(aaState.dataset, item, getOptions());
        const fname = `Soll_Ist_Vergleich_${window.AppGeo.slugify(item.name)}.pdf`;
        triggerDownload(blob, fname);
        elExportStatus.className = "alert alert-info";
        elExportStatus.innerHTML = `<strong>📄 Einzel-PDF erstellt:</strong> <code>${escapeHtml(fname)}</code>`;
        elExportStatus.classList.remove("hidden");
        elCard3.classList.add("is-done");
    }

    async function downloadAllPdf() {
        if (!aaState.dataset || aaState.filtered.length === 0) return;
        elBtnAllPdf.disabled = true;
        const origHtml = elBtnAllPdf.innerHTML;
        try {
            const blob = await window.AppAsAppliedRenderer.generateMultiFieldPdf(
                aaState.dataset,
                aaState.filtered,
                getOptions(),
                (pct) => {
                    elBtnAllPdf.innerHTML = `<span>⏳</span><span>Gesamt-PDF wird erstellt (${pct} %)…</span>`;
                }
            );
            const dateTag = new Date().toISOString().slice(0, 10);
            const fname = `Soll_Ist_Gesamtbericht_${aaState.filtered.length}_Schlaege_${dateTag}.pdf`;
            triggerDownload(blob, fname);
            elExportStatus.className = "alert alert-info";
            elExportStatus.innerHTML = `<strong>📚 Gesamt-PDF erstellt:</strong> <code>${escapeHtml(fname)}</code> (${aaState.filtered.length} Schläge).`;
            elExportStatus.classList.remove("hidden");
            elCard3.classList.add("is-done");
        } catch (err) {
            elExportStatus.className = "alert alert-err";
            elExportStatus.textContent = `Fehler beim PDF-Export: ${err.message || err}`;
            elExportStatus.classList.remove("hidden");
        } finally {
            elBtnAllPdf.innerHTML = origHtml;
            elBtnAllPdf.disabled = false;
        }
    }

    function downloadCsv() {
        if (aaState.filtered.length === 0) return;
        const csv = window.AppAsApplied.buildAsAppliedCsv(aaState.filtered);
        const dateTag = new Date().toISOString().slice(0, 10);
        const fname = `Zusammenfassung_Soll_Ist_${dateTag}.csv`;
        triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), fname);
        elExportStatus.className = "alert alert-info";
        elExportStatus.innerHTML = `<strong>📊 Excel-Tabelle heruntergeladen:</strong> <code>${escapeHtml(fname)}</code> (${aaState.filtered.length} Schläge).`;
        elExportStatus.classList.remove("hidden");
    }

    // ==================== EVENT WIRING ====================
    elBtnFolder.addEventListener("click", () => elFolderInput.click());
    elFolderInput.addEventListener("change", () => {
        if (elFolderInput.files?.length) handleFiles(elFolderInput.files);
        elFolderInput.value = "";
    });

    elDropzone.addEventListener("click", () => elZipInput.click());
    elDropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); elZipInput.click(); }
    });
    elDropzone.addEventListener("dragover", (e) => { e.preventDefault(); elDropzone.classList.add("drag-over"); });
    elDropzone.addEventListener("dragleave", () => elDropzone.classList.remove("drag-over"));
    elDropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        elDropzone.classList.remove("drag-over");
        if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    });
    elZipInput.addEventListener("change", () => {
        if (elZipInput.files?.length) handleFiles(elZipInput.files);
        elZipInput.value = "";
    });

    elCropFilter.addEventListener("change", applyFilterAndRender);
    elSearchInput.addEventListener("input", applyFilterAndRender);
    elOnlyGrd.addEventListener("change", applyFilterAndRender);

    [elUseOffset, elSharedScale, elShowTracks].forEach(el => {
        el.addEventListener("change", () => renderAaCurrentTab());
    });

    elFieldSelector.addEventListener("change", () => {
        aaState.activeUid = elFieldSelector.value;
        renderCompareTab();
    });
    $("aaBtnPrev").addEventListener("click", () => {
        const idx = aaState.filtered.findIndex(f => f.uid === aaState.activeUid);
        if (idx > 0) { aaState.activeUid = aaState.filtered[idx - 1].uid; renderCompareTab(); }
    });
    $("aaBtnNext").addEventListener("click", () => {
        const idx = aaState.filtered.findIndex(f => f.uid === aaState.activeUid);
        if (idx >= 0 && idx < aaState.filtered.length - 1) { aaState.activeUid = aaState.filtered[idx + 1].uid; renderCompareTab(); }
    });

    document.querySelectorAll(".aa-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => showSubTab(btn.dataset.aatab));
    });

    elOverviewCanvas.addEventListener("click", (ev) => {
        const rect = elOverviewCanvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
        let bestUid = null, bestDist = 42;
        for (const h of aaState.overviewHits) {
            const d = Math.hypot(h.cx - mx, h.cy - my);
            if (d < bestDist) { bestDist = d; bestUid = h.uid; }
        }
        if (bestUid) { aaState.activeUid = bestUid; showSubTab("compare"); }
    });

    elBtnSinglePdf.addEventListener("click", downloadSinglePdf);
    elBtnAllPdf.addEventListener("click", downloadAllPdf);
    elBtnCsv.addEventListener("click", downloadCsv);

    attachHover(elSollCanvas, elSollTooltip, () => aaState.sollTf);
    attachHover(elIstCanvas, elIstTooltip, () => aaState.istTf);

    let resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (!$("viewAsApplied").classList.contains("hidden")) renderAaCurrentTab();
        }, 120);
    });
})();
