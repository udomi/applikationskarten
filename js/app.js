/**
 * app.js — Main UI controller for Applikationskarten-Generator.
 */
(function () {
    "use strict";

    const state = {
        farmMeta: null,       // { sourceName, farmName, ctrAttrs, frmAttrs, fields }
        scenes: [],           // Downloaded Sentinel-2 scene windows
        biomassCache: new Map(), // field.uid -> bio object (recomputed only on scenes/cellSize/edgeFilter change)
        results: [],          // Computed prescription results for currently selected fields
        activeTab: "detail",
        activeFieldUid: null,
        bioTransform: null,
        rxTransform: null,
        overviewHits: [],
        abortController: null,
    };

    const $ = (id) => document.getElementById(id);

    // Elements
    const elDropzone = $("dropzone");
    const elFileInput = $("fileInput");
    const elUploadError = $("uploadError");
    const elFileSummary = $("fileSummary");
    const elFarmName = $("farmNameLabel");
    const elFieldCount = $("fieldCountLabel");
    const elFileMeta = $("fileMetaLabel");
    const elFieldListWrap = $("fieldListWrap");
    const elFieldChecklist = $("fieldChecklist");

    const elCard1 = $("cardStep1");
    const elCard2 = $("cardStep2");
    const elCard3 = $("cardStep3");
    const elCard4 = $("cardStep4");

    const elSatMode = $("satelliteMode");
    const elSingleYearGroup = $("singleYearGroup");
    const elSingleYearInput = $("singleYearInput");
    const elBtnFetch = $("btnFetchSentinel");
    const elProgressWrap = $("progressWrap");
    const elProgressFill = $("progressFill");
    const elProgressText = $("progressText");
    const elSentinelError = $("sentinelError");
    const elSceneList = $("sceneList");

    const elProductPreset = $("productPreset");
    const elCustomProductGroup = $("customProductGroup");
    const elCustomProductName = $("customProductName");
    const elTaskPrefix = $("taskPrefix");
    const elStrategy = $("strategySelect");
    const elMinRate = $("minRate");
    const elTargetRate = $("targetRate");
    const elMaxRate = $("maxRate");
    const elNumZones = $("numZones");
    const elZonePills = $("zonePills");
    const elStartId = $("startId");
    const elCellSizeM = $("cellSizeM");
    const elEdgeFilter = $("edgeFilter");

    const elBtnIsoxml = $("btnDownloadIsoxml");
    const elBtnPdf = $("btnDownloadPdf");
    const elBtnCsv = $("btnDownloadCsv");
    const elExportStatus = $("exportStatus");

    const elEmptyState = $("emptyState");
    const elTabDetail = $("tabDetail");
    const elTabOverview = $("tabOverview");
    const elTabTable = $("tabTable");
    const elDetailPlaceholder = $("detailPlaceholder");
    const elDetailMapsWrap = $("detailMapsWrap");
    const elFieldSelector = $("fieldSelector");
    const elFieldMetaBadges = $("fieldMetaBadges");

    const elBioCanvas = $("bioCanvas");
    const elRxCanvas = $("rxCanvas");
    const elBioTooltip = $("bioTooltip");
    const elRxTooltip = $("rxTooltip");
    const elOverviewCanvas = $("overviewCanvas");

    function getConfig() {
        let productName = "Kalkammonsalpeter (KAS)";
        if (elProductPreset.value === "custom") {
            productName = (elCustomProductName.value || "Dünger").trim();
        } else {
            productName = elProductPreset.value.split("|")[0];
        }
        return {
            productName,
            taskPrefix: (elTaskPrefix.value || "").trim(),
            strategy: elStrategy.value,
            minRate: Number(elMinRate.value),
            targetRate: Number(elTargetRate.value),
            maxRate: Number(elMaxRate.value),
            numZones: Number(elNumZones.value),
            startId: Math.max(1, parseInt(elStartId.value, 10) || 501),
            cellSizeM: Number(elCellSizeM.value || 10),
            edgeFilter: elEdgeFilter.checked,
        };
    }

    function getSelectedFields() {
        if (!state.farmMeta) return [];
        return state.farmMeta.fields.filter(f => f.selected);
    }

    function updateZonePills() {
        const cfg = getConfig();
        const rates = window.AppPrescription.computeZoneRates(cfg);
        const colors = window.AppRenderer.getRateColors(rates.length);
        elZonePills.innerHTML = "";
        rates.forEach((r, i) => {
            const span = document.createElement("span");
            span.className = "zone-pill";
            span.style.backgroundColor = colors[i];
            span.style.color = i >= Math.floor(rates.length / 2) ? "#ffffff" : "#0f172a";
            span.textContent = `${r} kg/ha`;
            elZonePills.appendChild(span);
        });

        const isUniform = cfg.strategy === "uniform";
        elMinRate.disabled = isUniform;
        elMaxRate.disabled = isUniform;
        elNumZones.disabled = isUniform;
    }

    function showError(el, msg) {
        if (!msg) {
            el.classList.add("hidden");
            el.textContent = "";
        } else {
            el.classList.remove("hidden");
            el.textContent = msg;
        }
    }

    // ==================== STEP 1: FILE UPLOAD ====================
    async function handleFile(file) {
        if (!file) return;
        showError(elUploadError, "");
        showError(elSentinelError, "");
        elExportStatus.classList.add("hidden");

        try {
            const parsed = await window.AppPrescription.parseUploadedFile(file);
            state.farmMeta = parsed;
            state.scenes = [];
            state.biomassCache.clear();
            state.results = [];
            state.activeFieldUid = parsed.fields[0]?.uid || null;

            elCard1.classList.add("is-done");
            elCard2.classList.remove("is-disabled", "is-done");
            elCard3.classList.add("is-disabled");
            elCard4.classList.add("is-disabled");
            elSceneList.classList.add("hidden");
            elProgressWrap.classList.add("hidden");

            renderFileSummary();
            renderFieldChecklist();
            updateKpis();
            showTab(state.activeTab);
        } catch (err) {
            showError(elUploadError, err.message || String(err));
        }
    }

    function renderFileSummary() {
        const fm = state.farmMeta;
        if (!fm) return;
        const totHa = fm.fields.reduce((s, f) => s + f.areaHa, 0);
        elFarmName.textContent = fm.farmName;
        elFieldCount.textContent = `${fm.fields.length} Schläge`;
        elFileMeta.textContent = `${fm.sourceName} • ${window.AppGeo.fmtDe(totHa, 2)} ha gesamt`;
        elFileSummary.classList.remove("hidden");
        elFieldListWrap.classList.remove("hidden");
    }

    function renderFieldChecklist() {
        const fm = state.farmMeta;
        if (!fm) return;
        elFieldChecklist.innerHTML = "";
        fm.fields.forEach((f, idx) => {
            const label = document.createElement("label");
            label.className = "field-check-item";
            label.innerHTML = `
                <span class="field-check-left">
                    <input type="checkbox" ${f.selected ? "checked" : ""} data-uid="${f.uid}">
                    <span class="field-check-name">${idx + 1}. ${escapeHtml(f.name)}</span>
                </span>
                <span class="field-check-ha">${window.AppGeo.fmtDe(f.areaHa, 2)} ha</span>
            `;
            const cb = label.querySelector("input");
            cb.addEventListener("change", () => {
                f.selected = cb.checked;
                onFieldSelectionChanged();
            });
            elFieldChecklist.appendChild(label);
        });
    }

    function onFieldSelectionChanged() {
        const sel = getSelectedFields();
        if (sel.length > 0 && !sel.some(f => f.uid === state.activeFieldUid)) {
            state.activeFieldUid = sel[0].uid;
        }
        if (state.scenes.length > 0) {
            recomputeAllPrescriptions(false);
        } else {
            updateKpis();
            renderCurrentTab();
        }
    }

    // ==================== STEP 2: FETCH SENTINEL-2 ====================
    async function runFetchSentinel() {
        if (!state.farmMeta) return;
        const selFields = getSelectedFields();
        if (selFields.length === 0) {
            showError(elSentinelError, "Bitte mindestens einen Schlag auswählen.");
            return;
        }

        if (state.abortController) {
            state.abortController.abort();
        }
        state.abortController = new AbortController();
        showError(elSentinelError, "");
        elExportStatus.classList.add("hidden");

        elBtnFetch.disabled = true;
        elBtnFetch.innerHTML = "<span>⏳</span><span>Lade Satellitendaten…</span>";
        elProgressWrap.classList.remove("hidden");
        elProgressFill.style.width = "3%";
        elProgressText.textContent = "Verbinde mit Copernicus Sentinel-2 Katalog…";

        try {
            const scenes = await window.AppSentinel.fetchScenesForFields(
                state.farmMeta.fields,
                {
                    mode: elSatMode.value,
                    singleYear: elSingleYearInput.value,
                },
                (pct, msg) => {
                    elProgressFill.style.width = `${Math.max(2, Math.min(100, pct))}%`;
                    elProgressText.textContent = msg;
                },
                state.abortController.signal
            );

            if (scenes.length === 0) {
                throw new Error("Keine ausreichend wolkenfreien Sentinel-2-Szenen im gewählten Zeitraum gefunden. Bitte einen anderen Zeitraum testen.");
            }

            state.scenes = scenes;
            state.biomassCache.clear();

            elProgressFill.style.width = "98%";
            elProgressText.textContent = "Berechne Biomasse- und Düngezonen…";
            await new Promise(r => setTimeout(r, 15));

            recomputeAllPrescriptions(true);

            elProgressFill.style.width = "100%";
            elProgressText.textContent = `Fertig! ${scenes.length} wolkenfreie Sentinel-2-Szenen verarbeitet.`;

            // Render scene tags
            elSceneList.innerHTML = "";
            scenes.forEach(sc => {
                const tag = document.createElement("span");
                tag.className = "scene-tag";
                tag.title = `${sc.id} • Wolkenfrei: ${window.AppGeo.fmtDe(sc.validPct, 1)} % • NDVI-Median: ${window.AppGeo.fmtDe(sc.ndviMedian, 2)}`;
                tag.textContent = `${window.AppGeo.fmtDateDe(sc.date)} (${Math.round(sc.validPct)}%)`;
                elSceneList.appendChild(tag);
            });
            elSceneList.classList.remove("hidden");

            elCard2.classList.add("is-done");
            elCard3.classList.remove("is-disabled");
            elCard4.classList.remove("is-disabled");
        } catch (err) {
            if (err.name !== "AbortError") {
                showError(elSentinelError, err.message || String(err));
                elProgressText.textContent = "Fehler beim Laden der Satellitendaten.";
            }
        } finally {
            elBtnFetch.disabled = false;
            elBtnFetch.innerHTML = "<span>🔄</span><span>Satellitendaten neu laden</span>";
        }
    }

    // ==================== STEP 3: LIVE RECALCULATION ====================
    function recomputeAllPrescriptions(forceBiomassRebuild = false) {
        if (!state.farmMeta || state.scenes.length === 0) return;
        const cfg = getConfig();
        const selFields = getSelectedFields();

        if (forceBiomassRebuild) {
            state.biomassCache.clear();
        }

        const results = [];
        for (let i = 0; i < selFields.length; i++) {
            const f = selFields[i];
            const cacheKey = `${f.uid}|${cfg.cellSizeM}|${cfg.edgeFilter}`;
            let bio = state.biomassCache.get(cacheKey);
            if (!bio) {
                bio = window.AppPrescription.computeFieldBiomass(f, state.scenes, {
                    cellSizeM: cfg.cellSizeM,
                    edgeFilter: cfg.edgeFilter,
                });
                state.biomassCache.set(cacheKey, bio);
            }
            const res = window.AppPrescription.applyStrategyToField(bio, cfg, i + 1);
            results.push(res);
        }

        state.results = results;
        if (results.length > 0 && !results.some(r => r.field.uid === state.activeFieldUid)) {
            state.activeFieldUid = results[0].field.uid;
        }

        elBtnIsoxml.disabled = results.length === 0;
        elBtnPdf.disabled = results.length === 0;
        elBtnCsv.disabled = results.length === 0;

        updateKpis();
        populateFieldSelector();
        renderCurrentTab();

        $("liveUpdateBadge").textContent = results.length
            ? `Live aktualisiert (${results[0].tskId}–${results[results.length - 1].tskId})`
            : "";
    }

    function updateKpis() {
        const cfg = getConfig();
        const selFields = getSelectedFields();
        const totFields = state.farmMeta ? state.farmMeta.fields.length : 0;

        if (!state.farmMeta) {
            $("kpiFields").textContent = "–";
            $("kpiFieldsSub").textContent = "Noch keine Datei geladen";
            $("kpiArea").textContent = "–";
            $("kpiAvgRate").textContent = "–";
            $("kpiTotalTons").textContent = "–";
            $("kpiTotalKg").textContent = "–";
            return;
        }

        const totArea = selFields.reduce((s, f) => s + f.areaHa, 0);
        $("kpiFields").textContent = `${selFields.length} / ${totFields}`;
        $("kpiFieldsSub").textContent = state.farmMeta.farmName;
        $("kpiArea").textContent = `${window.AppGeo.fmtDe(totArea, 2)} ha`;

        if (state.results.length > 0) {
            const totKg = state.results.reduce((s, r) => s + r.totalKg, 0);
            const avgRate = totArea > 0 ? totKg / totArea : 0;
            $("kpiAvgRate").textContent = `${window.AppGeo.fmtDe(avgRate, 1)} kg/ha`;
            $("kpiProductSub").textContent = cfg.productName;
            $("kpiTotalTons").textContent = `${window.AppGeo.fmtDe(totKg / 1000.0, 2)} t`;
            $("kpiTotalKg").textContent = `${window.AppGeo.fmtDe(totKg, 0)} kg gesamt`;
        } else {
            $("kpiAvgRate").textContent = "–";
            $("kpiProductSub").textContent = "Nach Schritt 2 verfügbar";
            $("kpiTotalTons").textContent = "–";
            $("kpiTotalKg").textContent = "Satellitendaten noch nicht geladen";
        }
    }

    function populateFieldSelector() {
        const list = state.results.length > 0
            ? state.results.map(r => r.field)
            : getSelectedFields();

        elFieldSelector.innerHTML = "";
        list.forEach((f, idx) => {
            const opt = document.createElement("option");
            opt.value = f.uid;
            opt.textContent = `${String(idx + 1).padStart(2, "0")}. ${f.name} (${window.AppGeo.fmtDe(f.areaHa, 2)} ha)`;
            if (f.uid === state.activeFieldUid) opt.selected = true;
            elFieldSelector.appendChild(opt);
        });
    }

    // ==================== TABS & RENDERING ====================
    function showTab(tabName) {
        state.activeTab = tabName;
        document.querySelectorAll(".tab-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.tab === tabName);
        });

        if (!state.farmMeta) {
            elEmptyState.classList.remove("hidden");
            elTabDetail.classList.add("hidden");
            elTabOverview.classList.add("hidden");
            elTabTable.classList.add("hidden");
            return;
        }

        elEmptyState.classList.add("hidden");
        elTabDetail.classList.toggle("hidden", tabName !== "detail");
        elTabOverview.classList.toggle("hidden", tabName !== "overview");
        elTabTable.classList.toggle("hidden", tabName !== "table");

        renderCurrentTab();
    }

    function renderCurrentTab() {
        if (!state.farmMeta) return;
        if (state.activeTab === "detail") renderDetailTab();
        else if (state.activeTab === "overview") renderOverviewTab();
        else if (state.activeTab === "table") renderTableTab();
    }

    function renderDetailTab() {
        populateFieldSelector();
        if (state.results.length === 0) {
            elDetailPlaceholder.classList.remove("hidden");
            elDetailMapsWrap.classList.add("hidden");
            elFieldMetaBadges.innerHTML = "";
            return;
        }

        elDetailPlaceholder.classList.add("hidden");
        elDetailMapsWrap.classList.remove("hidden");

        const res = state.results.find(r => r.field.uid === state.activeFieldUid) || state.results[0];
        state.activeFieldUid = res.field.uid;
        elFieldSelector.value = res.field.uid;

        const bio = res.bio;
        const cfg = getConfig();

        // Badges
        elFieldMetaBadges.innerHTML = `
            <span class="meta-badge">${window.AppGeo.fmtDe(res.field.areaHa, 2)} ha</span>
            <span class="meta-badge">Ø ${window.AppGeo.fmtDe(res.avgRate, 1)} kg/ha</span>
            <span class="meta-badge">${window.AppGeo.fmtDe(res.totalKg, 0)} kg (${window.AppGeo.fmtDe(res.totalKg / 1000, 2)} t)</span>
            <span class="meta-badge">${res.tskId}</span>
        `;

        const yrsStr = bio.yearsUsed.length ? bio.yearsUsed.join("/") : "–";
        $("bioScenesLabel").textContent = `${bio.usedScenes.length} Szenen (${yrsStr})`;
        $("rxMapTitle").textContent = `Applikationskarte (${cfg.taskPrefix || cfg.productName})`;
        $("rxGrdLabel").textContent = `${res.grdName}.BIN • ${bio.nCols}×${bio.nRows} (${bio.cellSizeM} m)`;

        // Responsive canvas sizing
        const bioW = Math.max(280, Math.floor($("bioCanvasWrap").clientWidth || 440));
        const rxW = Math.max(280, Math.floor($("rxCanvasWrap").clientWidth || 440));
        const mapH = Math.round(Math.min(400, Math.max(280, bioW * 0.78)));

        state.bioTransform = window.AppRenderer.renderFieldMapCanvas(elBioCanvas, res, "biomass", bioW, mapH);
        state.rxTransform = window.AppRenderer.renderFieldMapCanvas(elRxCanvas, res, "prescription", rxW, mapH);

        // Prescription legend
        const rates = res.zoneRates;
        const colors = window.AppRenderer.getRateColors(rates.length);
        const legBar = $("rxLegendBar");
        const legLbl = $("rxLegendLabels");
        legBar.innerHTML = "";
        legLbl.innerHTML = "";
        rates.forEach((r, i) => {
            const seg = document.createElement("div");
            seg.className = "rx-legend-seg";
            seg.style.backgroundColor = colors[i];
            legBar.appendChild(seg);

            const sp = document.createElement("span");
            sp.textContent = `${r}`;
            legLbl.appendChild(sp);
        });

        // Zone distribution bars
        const zoneBars = $("zoneBars");
        zoneBars.innerHTML = "";
        rates.forEach((r, i) => {
            const cnt = res.zoneCounts.get(r) || 0;
            const pct = res.totIn > 0 ? (cnt / res.totIn) * 100.0 : 0;
            const areaZ = res.field.areaHa * (pct / 100.0);
            const row = document.createElement("div");
            row.className = "zone-bar-row";
            row.innerHTML = `
                <span class="zone-bar-label">${r} kg/ha</span>
                <div class="zone-bar-track">
                    <div class="zone-bar-fill" style="width:${pct.toFixed(1)}%;background:${colors[i]};"></div>
                </div>
                <span class="zone-bar-val">${window.AppGeo.fmtDe(pct, 1)} % (${window.AppGeo.fmtDe(areaZ, 2)} ha)</span>
            `;
            zoneBars.appendChild(row);
        });
    }

    function renderOverviewTab() {
        const wrap = elOverviewCanvas.parentElement;
        const w = Math.max(360, Math.floor(wrap.clientWidth || 860));
        const h = Math.round(Math.min(560, Math.max(360, w * 0.58)));
        state.overviewHits = window.AppRenderer.renderOverviewMapCanvas(
            elOverviewCanvas,
            state.farmMeta.fields,
            state.activeFieldUid,
            w,
            h
        );
    }

    function renderTableTab() {
        const thead = $("summaryHead");
        const tbody = $("summaryBody");
        const tfoot = $("summaryFoot");

        if (state.results.length === 0) {
            thead.innerHTML = "<tr><th>Nr</th><th>Schlagname</th><th class='num'>Fläche (ha)</th><th>Status</th></tr>";
            tbody.innerHTML = state.farmMeta.fields.map((f, i) => `
                <tr data-uid="${f.uid}">
                    <td>${i + 1}</td>
                    <td>${escapeHtml(f.name)}</td>
                    <td class="num">${window.AppGeo.fmtDe(f.areaHa, 2)}</td>
                    <td>${f.selected ? "Ausgewählt – warte auf Sentinel-2" : "Abgewählt"}</td>
                </tr>
            `).join("");
            tfoot.innerHTML = "";
            return;
        }

        const rates = state.results[0].zoneRates;
        thead.innerHTML = `
            <tr>
                <th>Nr</th>
                <th>Schlagname</th>
                <th>GRD-Datei</th>
                <th class="num">Fläche (ha)</th>
                <th class="num">Szenen</th>
                <th class="num">Ø kg/ha</th>
                <th class="num">Gesamt (kg)</th>
                ${rates.map(r => `<th class="num">${r} kg/ha</th>`).join("")}
            </tr>
        `;

        tbody.innerHTML = state.results.map((res, i) => `
            <tr data-uid="${res.field.uid}">
                <td>${i + 1}</td>
                <td><strong>${escapeHtml(res.field.name)}</strong></td>
                <td><code>${res.grdName}.BIN</code></td>
                <td class="num">${window.AppGeo.fmtDe(res.field.areaHa, 2)}</td>
                <td class="num">${res.bio.usedScenes.length}</td>
                <td class="num">${window.AppGeo.fmtDe(res.avgRate, 1)}</td>
                <td class="num">${window.AppGeo.fmtDe(res.totalKg, 0)}</td>
                ${rates.map(r => {
                    const pct = res.totIn > 0 ? ((res.zoneCounts.get(r) || 0) / res.totIn) * 100.0 : 0;
                    return `<td class="num">${window.AppGeo.fmtDe(pct, 1)} %</td>`;
                }).join("")}
            </tr>
        `).join("");

        const totArea = state.results.reduce((s, r) => s + r.field.areaHa, 0);
        const totKg = state.results.reduce((s, r) => s + r.totalKg, 0);
        const avgAll = totArea > 0 ? totKg / totArea : 0;
        tfoot.innerHTML = `
            <tr>
                <td></td>
                <td>GESAMT (${state.results.length} Schläge)</td>
                <td></td>
                <td class="num">${window.AppGeo.fmtDe(totArea, 2)}</td>
                <td></td>
                <td class="num">${window.AppGeo.fmtDe(avgAll, 1)}</td>
                <td class="num">${window.AppGeo.fmtDe(totKg, 0)} kg (${window.AppGeo.fmtDe(totKg / 1000, 2)} t)</td>
                ${rates.map(() => "<td></td>").join("")}
            </tr>
        `;

        tbody.querySelectorAll("tr").forEach(tr => {
            tr.addEventListener("click", () => {
                state.activeFieldUid = tr.dataset.uid;
                showTab("detail");
            });
        });
    }

    // ==================== INTERACTIVE MAP HOVER ====================
    function attachHover(canvas, tooltip, getTf) {
        canvas.addEventListener("mousemove", (ev) => {
            const tf = getTf();
            if (!tf || state.results.length === 0) return;
            const res = state.results.find(r => r.field.uid === state.activeFieldUid);
            if (!res) return;

            const rect = canvas.getBoundingClientRect();
            const px = ev.clientX - rect.left;
            const py = ev.clientY - rect.top;
            const xm = tf.fromX(px);
            const ym = tf.fromY(py);

            const b = res.bio;
            const [gx0, gx1, gy0, gy1] = b.extentM;
            const c = Math.floor(((xm - gx0) / (gx1 - gx0)) * b.nCols);
            const r = Math.floor(((ym - gy0) / (gy1 - gy0)) * b.nRows);

            if (r >= 0 && r < b.nRows && c >= 0 && c < b.nCols) {
                const idx = r * b.nCols + c;
                if (b.insideMask[idx]) {
                    const rate = res.rateGrid[idx];
                    const relBio = 100.0 + (Number.isNaN(b.smoothZ[idx]) ? 0 : b.smoothZ[idx]) * 10.0;
                    tooltip.textContent = `Soll: ${rate} kg/ha  •  Biomasse: ${Math.round(relBio)} %`;
                    tooltip.style.left = `${Math.min(rect.width - 175, Math.max(8, px + 12))}px`;
                    tooltip.style.top = `${Math.max(8, py - 30)}px`;
                    tooltip.classList.remove("hidden");
                    return;
                }
            }
            tooltip.classList.add("hidden");
        });
        canvas.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
    }

    // ==================== STEP 4: DOWNLOADS ====================
    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 500);
    }

    async function downloadIsoxmlZip() {
        if (state.results.length === 0) return;
        const cfg = getConfig();
        elBtnIsoxml.disabled = true;
        try {
            const pkg = await window.AppPrescription.buildIsoxmlZip(state.farmMeta, state.results, cfg);
            const prefixSlug = window.AppGeo.slugify(cfg.taskPrefix || cfg.productName || "Duenger");
            const dateTag = new Date().toISOString().slice(0, 10);
            const fname = `TASKDATA_${prefixSlug}_${dateTag}.zip`;
            triggerDownload(pkg.zipBlob, fname);

            elExportStatus.className = "alert alert-info";
            elExportStatus.innerHTML = `<strong>✅ Geprüft &amp; heruntergeladen:</strong> <code>${escapeHtml(fname)}</code> (${pkg.taskCount} Aufträge, ${pkg.firstId}–${pkg.lastId}, alle GRD-Binärdateien verifiziert).`;
            elExportStatus.classList.remove("hidden");
            elCard4.classList.add("is-done");
        } catch (err) {
            elExportStatus.className = "alert alert-err";
            elExportStatus.textContent = `Fehler beim ISOXML-Export: ${err.message || err}`;
            elExportStatus.classList.remove("hidden");
        } finally {
            elBtnIsoxml.disabled = false;
        }
    }

    async function downloadControlPdf() {
        if (state.results.length === 0) return;
        const cfg = getConfig();
        elBtnPdf.disabled = true;
        const origHtml = elBtnPdf.innerHTML;
        try {
            const pdfBlob = await window.AppRenderer.generateControlReportPdf(
                state.farmMeta,
                state.results,
                state.scenes,
                cfg,
                (pct, msg) => {
                    elBtnPdf.innerHTML = `<span>⏳</span><span>PDF wird erstellt (${pct} %)…</span>`;
                }
            );
            const prefixSlug = window.AppGeo.slugify(cfg.taskPrefix || cfg.productName || "Duenger");
            const dateTag = new Date().toISOString().slice(0, 10);
            const fname = `Kontrollbericht_Applikationskarten_${prefixSlug}_${dateTag}.pdf`;
            triggerDownload(pdfBlob, fname);

            elExportStatus.className = "alert alert-info";
            elExportStatus.innerHTML = `<strong>📄 Kontroll-PDF erstellt:</strong> <code>${escapeHtml(fname)}</code> (${state.results.length + 2} Seiten, A4 Querformat).`;
            elExportStatus.classList.remove("hidden");
        } catch (err) {
            elExportStatus.className = "alert alert-err";
            elExportStatus.textContent = `Fehler beim PDF-Export: ${err.message || err}`;
            elExportStatus.classList.remove("hidden");
        } finally {
            elBtnPdf.innerHTML = origHtml;
            elBtnPdf.disabled = false;
        }
    }

    function downloadSummaryCsv() {
        if (state.results.length === 0) return;
        const cfg = getConfig();
        const csvText = window.AppPrescription.buildSummaryCsv(state.results, cfg);
        const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
        const prefixSlug = window.AppGeo.slugify(cfg.taskPrefix || cfg.productName || "Duenger");
        const dateTag = new Date().toISOString().slice(0, 10);
        const fname = `Uebersicht_Applikationskarten_${prefixSlug}_${dateTag}.csv`;
        triggerDownload(blob, fname);

        elExportStatus.className = "alert alert-info";
        elExportStatus.innerHTML = `<strong>📊 Excel-Tabelle heruntergeladen:</strong> <code>${escapeHtml(fname)}</code> (${state.results.length} Schläge).`;
        elExportStatus.classList.remove("hidden");
    }

    function escapeHtml(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ==================== EVENT WIRING ====================
    elDropzone.addEventListener("click", () => elFileInput.click());
    elDropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); elFileInput.click(); }
    });
    elDropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        elDropzone.classList.add("drag-over");
    });
    elDropzone.addEventListener("dragleave", () => elDropzone.classList.remove("drag-over"));
    elDropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        elDropzone.classList.remove("drag-over");
        if (e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0]);
    });
    elFileInput.addEventListener("change", () => {
        if (elFileInput.files?.[0]) handleFile(elFileInput.files[0]);
        elFileInput.value = "";
    });

    $("btnSelectAll").addEventListener("click", () => {
        if (!state.farmMeta) return;
        state.farmMeta.fields.forEach(f => { f.selected = true; });
        renderFieldChecklist();
        onFieldSelectionChanged();
    });
    $("btnSelectNone").addEventListener("click", () => {
        if (!state.farmMeta) return;
        state.farmMeta.fields.forEach(f => { f.selected = false; });
        renderFieldChecklist();
        onFieldSelectionChanged();
    });

    elSatMode.addEventListener("change", () => {
        elSingleYearGroup.classList.toggle("hidden", elSatMode.value !== "singleyear");
    });
    elBtnFetch.addEventListener("click", runFetchSentinel);

    elProductPreset.addEventListener("change", () => {
        const isCustom = elProductPreset.value === "custom";
        elCustomProductGroup.classList.toggle("hidden", !isCustom);
        if (!isCustom) {
            const parts = elProductPreset.value.split("|");
            elTaskPrefix.value = parts[1] || "Düng";
        }
        recomputeAllPrescriptions(false);
    });

    // Live recalculation inputs
    [elCustomProductName, elTaskPrefix, elStrategy, elMinRate, elTargetRate, elMaxRate, elNumZones, elStartId].forEach(el => {
        el.addEventListener("input", () => {
            updateZonePills();
            recomputeAllPrescriptions(false);
        });
        el.addEventListener("change", () => {
            updateZonePills();
            recomputeAllPrescriptions(false);
        });
    });

    // Inputs that affect biomass grid require biomass cache rebuild
    [elCellSizeM, elEdgeFilter].forEach(el => {
        el.addEventListener("change", () => recomputeAllPrescriptions(true));
    });

    // Field navigator
    elFieldSelector.addEventListener("change", () => {
        state.activeFieldUid = elFieldSelector.value;
        renderDetailTab();
    });
    $("btnPrevField").addEventListener("click", () => {
        const list = state.results.length ? state.results.map(r => r.field) : getSelectedFields();
        const idx = list.findIndex(f => f.uid === state.activeFieldUid);
        if (idx > 0) {
            state.activeFieldUid = list[idx - 1].uid;
            renderDetailTab();
        }
    });
    $("btnNextField").addEventListener("click", () => {
        const list = state.results.length ? state.results.map(r => r.field) : getSelectedFields();
        const idx = list.findIndex(f => f.uid === state.activeFieldUid);
        if (idx >= 0 && idx < list.length - 1) {
            state.activeFieldUid = list[idx + 1].uid;
            renderDetailTab();
        }
    });

    // Tabs
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => showTab(btn.dataset.tab));
    });

    // Overview map click-to-field
    elOverviewCanvas.addEventListener("click", (ev) => {
        const rect = elOverviewCanvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        // Check nearest field centroid within 45px or inside polygon
        let bestUid = null;
        let bestDist = 48;
        for (const h of state.overviewHits) {
            const d = Math.hypot(h.cx - mx, h.cy - my);
            if (d < bestDist) {
                bestDist = d;
                bestUid = h.uid;
            }
        }
        if (bestUid) {
            state.activeFieldUid = bestUid;
            showTab("detail");
        }
    });

    // Downloads
    elBtnIsoxml.addEventListener("click", downloadIsoxmlZip);
    elBtnPdf.addEventListener("click", downloadControlPdf);
    elBtnCsv.addEventListener("click", downloadSummaryCsv);

    // Hover tooltips
    attachHover(elBioCanvas, elBioTooltip, () => state.bioTransform);
    attachHover(elRxCanvas, elRxTooltip, () => state.rxTransform);

    // Responsive redraw on window resize
    let resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => renderCurrentTab(), 120);
    });

    // Init
    updateZonePills();
})();
