// --- CONFIGURATION ---
const USER_PASS = "1234";
const DEVELOPER_PASS = "1074";
const ACCESS_MODE_USER = "user";
const ACCESS_MODE_DEVELOPER = "developer";
const MONTH_ORDER = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// --- STATE MANAGEMENT ---
let scanHistory = []; 
let masterDB = {}; 
let rawMasterRows = []; 
let pendingUploads = JSON.parse(localStorage.getItem('pending_queue')) || [];
let activeLocks = {};

let currentItem = null;
let currentAuditEditId = null;
let currentAuditEditRecord = null;
let currentLockOwned = false;
let loggedInUser = "";
let currentAccessMode = "";
let html5QrCode = null;
let currentGaugeValue = 0;
let targetGaugeValue = 0;
let isOnline = false;

let selectedLoc = "CORRECT";
let selectedStickerLoc = "CORRECT";
let selectedDue = "VALID";
let selectedMsa = "NO";

let failureChartInstance = null;

// --- CONNECTION HEARTBEAT & SYNC ---
db.ref(".info/connected").on("value", (snap) => {
    isOnline = snap.val() === true;
    const syncIcon = document.getElementById('syncStatus');
    if (syncIcon) {
        if (isOnline) {
            syncIcon.style.background = "#2e7d32"; 
            syncIcon.style.boxShadow = "0 0 10px rgba(46, 125, 50, 0.4)";
            processOfflineQueue();
        } else {
            syncIcon.style.background = "#d32f2f"; 
            syncIcon.style.boxShadow = "0 0 10px rgba(211, 47, 47, 0.4)";
        }
    }
});

async function processOfflineQueue() {
    if (pendingUploads.length > 0 && isOnline) {
        const historyRef = db.ref('audit_history');
        const total = pendingUploads.length;
        const progressCont = document.getElementById('syncProgressContainer');
        const progressBar = document.getElementById('syncProgressBar');

        if (progressCont) progressCont.style.display = 'block';

        for (let i = 0; i < total; i++) {
            const data = pendingUploads[i];

            if (progressBar) {
                progressBar.style.width = ((i + 1) / total * 100) + "%";
            }

            const snapshot = await historyRef.orderByChild('barcode').equalTo(data.barcode).once('value');

            if (!snapshot.exists()) {
                const newRef = historyRef.push();
                data.cloudId = newRef.key;
                await newRef.set(data);
            }
        }

        setTimeout(() => {
            if (progressCont) progressCont.style.display = 'none';
            if (progressBar) progressBar.style.width = '0%';
        }, 1200);

        pendingUploads = [];
        localStorage.removeItem('pending_queue');
        updateDisplay();
    }
}

// --- REAL-TIME LISTENERS ---
db.ref('audit_history').on('value', (snapshot) => {
    const rows = [];

    snapshot.forEach(child => {
        const value = child.val() || {};
        rows.push({
            ...value,
            cloudId: value.cloudId || child.key
        });
    });

    scanHistory = rows.sort((a, b) => (b.id || 0) - (a.id || 0));
    updateDisplay();
});

db.ref('master_list').on('value', (snapshot) => {
    const data = snapshot.val();
    if (data) {
        masterDB = data.masterDB || {};
        rawMasterRows = data.rawMasterRows || [];
        rebuildFilters();
        updateDisplay();
    }
});

db.ref('temporary_locks').on('value', (snap) => {
    activeLocks = snap.val() || {};
    updateDisplay();
});

// --- LOCKING LOGIC ---
function attemptLock(barcode) {
    const lockKey = btoa(barcode).replace(/=/g, "");
    const lockRef = db.ref('temporary_locks/' + lockKey);

    return lockRef.transaction((currentData) => {
        if (currentData === null || (Date.now() - currentData.time > 300000)) {
            return {
                user: loggedInUser,
                time: Date.now()
            };
        }

        return;
    });
}

function releaseLock(barcode) {
    if (barcode && isOnline) {
        db.ref('temporary_locks/' + btoa(barcode).replace(/=/g, "")).remove();
    }
}

// --- MASTER DATA LOADING ---
function loadMasterData(input) {
    if (!input.files || !input.files[0]) return;

    const reader = new FileReader();

    reader.onload = function(e) {
        const rows = e.target.result.split(/\r?\n/).filter(row => row.trim() !== "");
        let newMasterDB = {}; 
        let newRawRows = [];

        rows.forEach((row, i) => {
            const columns = row.split(',').map(s => s.trim());

            if (i === 0) {
                newRawRows.push(columns);
                return;
            }

            if (!columns[0]) return;

            const fullLoc = columns[2] || "N/A";
            const locParts = fullLoc.split("-");

            let rawDate = columns[3] || "";
            let m = "N/A";
            let y = "N/A";
            let displayDate = rawDate;

            if (rawDate.includes("/")) {
                const parts = rawDate.split("/");
                const monthIdx = parseInt(parts[0], 10) - 1;

                if (monthIdx >= 0 && monthIdx < 12) {
                    m = MONTH_ORDER[monthIdx];
                }

                y = parts[2]
                    ? (parts[2].length === 2 ? "20" + parts[2] : parts[2])
                    : "N/A";

                displayDate = `${m}-${y.slice(-2)}`;
            } else if (rawDate.includes("-")) {
                const parts = rawDate.split("-");
                m = parts[0].toUpperCase();
                y = parts[1] && parts[1].length === 2 ? "20" + parts[1] : parts[1];
                displayDate = m + "-" + y.slice(-2);
            }

            columns[3] = displayDate;
            newRawRows.push(columns);

            newMasterDB[columns[0].toUpperCase()] = {
                name: columns[1] || "UNKNOWN",
                loc: fullLoc,
                bldg: (locParts[0] || "N/A").trim(),
                prod: (locParts[1] || "N/A").trim(),
                due: displayDate,
                status: columns[4] || "N/A",
                msa: columns[5] || "N/A",
                month: m,
                year: y
            };
        });

        db.ref('master_list').set({
            masterDB: newMasterDB,
            rawMasterRows: newRawRows
        });
    };

    reader.readAsText(input.files[0]);
}

// --- UI & FILTERING ---
function getMultiSelectValues(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return [];

    return Array.from(el.selectedOptions)
        .map(option => option.value)
        .filter(value => value !== "");
}

function getSelectedFilterState() {
    return {
        building: document.getElementById('filterBuilding')?.value || "",
        productions: getMultiSelectValues('filterProduction'),
        month: document.getElementById('filterMonth')?.value || "",
        year: document.getElementById('filterYear')?.value || "",
        statuses: getMultiSelectValues('filterStatus')
    };
}

function setSingleSelectOptions(selectEl, values, defaultText, selectedValue = "") {
    if (!selectEl) return;

    selectEl.innerHTML = `<option value="">${defaultText}</option>`;

    values.forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;

        if (value === selectedValue) {
            option.selected = true;
        }

        selectEl.appendChild(option);
    });
}

function setMultiSelectOptions(selectEl, values, selectedValues = []) {
    if (!selectEl) return;

    const selectedSet = new Set(selectedValues);
    selectEl.innerHTML = "";

    values.forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;

        if (selectedSet.has(value)) {
            option.selected = true;
        }

        selectEl.appendChild(option);
    });
}

function getAvailableProductionsForBuilding(building) {
    const prodSet = new Set();

    Object.values(masterDB).forEach(item => {
        if (!item || item.prod === "N/A") return;

        if (!building || item.bldg === building) {
            prodSet.add(item.prod);
        }
    });

    return Array.from(prodSet).sort();
}

function rebuildProductionFilter(selectedProductions = []) {
    const building = document.getElementById('filterBuilding')?.value || "";
    const availableProductions = getAvailableProductionsForBuilding(building);
    const validSelections = selectedProductions.filter(prod => availableProductions.includes(prod));

    setMultiSelectOptions(
        document.getElementById('filterProduction'),
        availableProductions,
        validSelections
    );
}

function onBuildingFilterChange() {
    rebuildProductionFilter([]);
    updateDisplay();
}

function rebuildFilters() {
    const current = getSelectedFilterState();

    const bldgSet = new Set();
    const monthSet = new Set();
    const yearSet = new Set();
    const statusSet = new Set();

    Object.values(masterDB).forEach(item => {
        if (!item) return;

        if (item.bldg && item.bldg !== "N/A") bldgSet.add(item.bldg);
        if (item.month && item.month !== "N/A") monthSet.add(item.month);
        if (item.year && item.year !== "N/A") yearSet.add(item.year);
        if (item.status && item.status !== "N/A") statusSet.add(item.status);
    });

    const buildings = Array.from(bldgSet).sort();
    const months = Array.from(monthSet).sort((a, b) => {
        return MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b);
    });
    const years = Array.from(yearSet).sort((a, b) => {
        return parseInt(a, 10) - parseInt(b, 10);
    });
    const statuses = Array.from(statusSet).sort();

    const selectedBuilding = buildings.includes(current.building) ? current.building : "";

    setSingleSelectOptions(
        document.getElementById('filterBuilding'),
        buildings,
        'All Buildings',
        selectedBuilding
    );

    setSingleSelectOptions(
        document.getElementById('filterMonth'),
        months,
        'All Months',
        months.includes(current.month) ? current.month : ""
    );

    setSingleSelectOptions(
        document.getElementById('filterYear'),
        years,
        'All Years',
        years.includes(current.year) ? current.year : ""
    );

    setMultiSelectOptions(
        document.getElementById('filterStatus'),
        statuses,
        current.statuses.filter(status => statuses.includes(status))
    );

    rebuildProductionFilter(current.productions);
}

function itemMatchesFilters(item, filters) {
    if (!item) return false;

    const matchesProduction =
        filters.productions.length === 0 ||
        filters.productions.includes(item.prod);

    const matchesStatus =
        filters.statuses.length === 0 ||
        filters.statuses.includes(item.status);

    return (!filters.building || item.bldg === filters.building) &&
           matchesProduction &&
           (!filters.month || item.month === filters.month) &&
           (!filters.year || item.year === filters.year) &&
           matchesStatus;
}

function updateDisplay() {
    const searchEl = document.getElementById('globalSearch');
    const s = searchEl ? searchEl.value.toUpperCase() : "";
    const filters = getSelectedFilterState();

    const allCodes = Object.keys(masterDB);

    const filteredTargetList = allCodes.filter(code => {
        return itemMatchesFilters(masterDB[code], filters);
    });

    const currentAuditResults = scanHistory.filter(h => {
        const m = masterDB[(h.barcode || "").toUpperCase()];
        return itemMatchesFilters(m, filters);
    });

    const scannedCodesInTarget = new Set(
        currentAuditResults.map(h => (h.barcode || "").toUpperCase())
    );

    const scannedInTarget = scannedCodesInTarget.size;

    const per = filteredTargetList.length > 0
        ? Math.min(100, Math.round((scannedInTarget / filteredTargetList.length) * 100))
        : 0;

    const progressSubLabel = document.getElementById('progressSubLabel');
    if (progressSubLabel) {
        progressSubLabel.innerText = `Scanned: ${scannedInTarget} / ${filteredTargetList.length}`;
    }

    drawGauge(per);
    updateFailureChart(currentAuditResults.filter(h => h.isFail));

    const totalScans = document.getElementById('totalScans');
    const totalFails = document.getElementById('totalFails');
    const totalNotScanned = document.getElementById('totalNotScanned');

    if (totalScans) totalScans.innerText = currentAuditResults.length;
    if (totalFails) totalFails.innerText = currentAuditResults.filter(x => x.isFail).length;
    if (totalNotScanned) {
        totalNotScanned.innerText = Math.max(filteredTargetList.length - scannedInTarget, 0);
    }

    const inventoryBody = document.getElementById('inventoryBody');

    if (inventoryBody) {
        inventoryBody.innerHTML = currentAuditResults
            .filter(h => {
                return (h.barcode || "").toUpperCase().includes(s) ||
                       (h.name || "").toUpperCase().includes(s);
            })
            .map(i => {
                const originalStatus =
                    (masterDB[(i.barcode || "").toUpperCase()] || {}).status || "N/A";

                return `<tr class="${i.isFail ? 'row-fail' : ''}">
                    <td>${i.time}</td>
                    <td style="word-break:break-all; font-size:10px;">${i.barcode}</td>
                    <td>${i.name}</td>
                    <td style="color:var(--primary)">${i.pic}</td>
                    <td><span class="status-pill ${i.locRes === 'CORRECT' ? 'pill-pass' : 'pill-fail'}">${i.locRes}</span></td>
                    <td><span class="status-pill ${i.stickerLocRes === 'CORRECT' ? 'pill-pass' : (i.stickerLocRes === 'WRONG' ? 'pill-fail' : 'pill-neutral')}">${i.stickerLocRes || 'N/A'}</span></td>
                    <td><span class="status-pill ${i.dueRes === 'VALID' ? 'pill-pass' : 'pill-fail'}">${i.dueRes}</span></td>
                    <td>${originalStatus}</td>
                    <td><span class="status-pill ${i.msaRes === 'YES' ? 'pill-pass' : 'pill-fail'}">${i.msaRes}</span></td>
                    <td>${escapeHtml(i.remark)}</td>
                    <td>
                        <div class="row-action-group">
                            <button class="btn-detail-row" onclick="openAuditDetail('${encodeActionValue(i.cloudId || i.id || i.barcode || '')}')">Detail</button>
                            ${canDeleteAuditRecords() ? `<button class="btn-delete-row" onclick="deleteRow('${encodeActionValue(i.cloudId || i.id || i.barcode || '')}')">Del</button>` : ""}
                        </div>
                    </td>
                </tr>`;
            })
            .join('');
    }

    const pendingBody = document.getElementById('pendingBody');

    if (pendingBody) {
        const scannedIds = new Set(
            scanHistory.map(x => (x.barcode || "").toUpperCase())
        );

        pendingBody.innerHTML = filteredTargetList
            .filter(c => {
                const item = masterDB[c];

                return !scannedIds.has(c) &&
                    (
                        c.includes(s) ||
                        (item.name || "").toUpperCase().includes(s)
                    );
            })
            .map(c => {
                const lock = activeLocks[btoa(c).replace(/=/g, "")];

                const lockStyle = lock
                    ? 'style="background: rgba(121, 85, 72, 0.1); border-left: 3px solid #795548;"'
                    : '';

                const lockTag = lock
                    ? `<span style="color:#795548; font-size:10px;">🔒 ${lock.user}</span>`
                    : '';

                return `<tr ${lockStyle}>
                    <td>${c} ${lockTag}</td>
                    <td>${masterDB[c].name}</td>
                    <td>${masterDB[c].loc}</td>
                    <td>${masterDB[c].due}</td>
                    <td>${masterDB[c].status}</td>
                    <td>${masterDB[c].msa}</td>
                </tr>`;
            })
            .join('');
    }
}

function exportFilteredOnly() {
    const filters = getSelectedFilterState();

    const auditHeader = [
        "EQUIPMENT CODE",
        "EQUIPMENT NAME",
        "LOCATION",
        "DUE DATE",
        "STATUS",
        "MSA",
        "Audit Status",
        "Date/Time",
        "Auditor",
        "Loc_Audit",
        "Sticker_Loc_Audit",
        "Due_Audit",
        "MSA_Audit",
        "Remark"
    ];

    let auditData = [auditHeader];

    rawMasterRows.slice(1).forEach(r => {
        const code = (r[0] || "").toUpperCase();
        const item = masterDB[code];

        if (!item || !itemMatchesFilters(item, filters)) return;

        const baseRow = r.slice(0, 6);
        const s = scanHistory.find(h => (h.barcode || "").toUpperCase() === code);

        if (s) {
            const statusLabel = s.isFail ? "FAIL (AUDIT)" : "SCANNED";

            auditData.push([
                ...baseRow,
                statusLabel,
                s.time,
                s.pic,
                s.locRes,
                s.stickerLocRes || "",
                s.dueRes,
                s.msaRes,
                s.remark
            ]);
        } else {
            auditData.push([
                ...baseRow,
                "PENDING",
                "",
                "",
                "",
                "",
                "",
                "",
                ""
            ]);
        }
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(auditData), "Filtered Audit");
    XLSX.writeFile(wb, `Audit_Report_Filtered.xlsx`);
}

function resetFilters() {
    const searchEl = document.getElementById('globalSearch');
    if (searchEl) searchEl.value = "";

    const buildingEl = document.getElementById('filterBuilding');
    const monthEl = document.getElementById('filterMonth');
    const yearEl = document.getElementById('filterYear');

    if (buildingEl) buildingEl.value = "";
    if (monthEl) monthEl.value = "";
    if (yearEl) yearEl.value = "";

    rebuildProductionFilter([]);

    const statusEl = document.getElementById('filterStatus');

    if (statusEl) {
        Array.from(statusEl.options).forEach(opt => {
            opt.selected = false;
        });
    }

    updateDisplay();
}

function updateFailureChart(failedItems) {
    const validRemarks = [
        "Missing due date sticker", 
        "Damaged Label", 
        "Found from missing", 
        "System not tally", 
        "Location not match", 
        "Location on sticker not match",
        "Wrong due date"
    ];

    const counts = {};
    validRemarks.forEach(r => counts[r] = 0);
    counts["Others"] = 0;

    failedItems.forEach(item => {
        const r = item.remark ? item.remark.trim() : "";

        if (validRemarks.includes(r)) {
            counts[r]++;
        } else if (r !== "-" && r !== "") {
            counts["Others"]++;
        }
    });

    const labels = Object.keys(counts).filter(k => counts[k] > 0);
    const data = labels.map(k => counts[k]);

    const chartEl = document.getElementById('failureChart');
    const legendEl = document.getElementById('failureLegend');

    if (!chartEl) return;

    const ctx = chartEl.getContext('2d');

    if (failureChartInstance) {
        failureChartInstance.destroy();
    }

    if (labels.length === 0) {
        if (legendEl) legendEl.innerHTML = "No failures detected.";
        return;
    }

    const colors = [
        '#ff1744',
        '#ff9100',
        '#ffd600',
        '#2979ff',
        '#00e676',
        '#d500f9',
        '#8892b0'
    ];

    failureChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Failures',
                data: data,
                backgroundColor: colors.slice(0, labels.length),
                borderWidth: 0,
                borderRadius: 6,
                barThickness: 16
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: {
                        precision: 0
                    }
                },
                y: {
                    ticks: {
                        font: {
                            size: 10
                        }
                    }
                }
            }
        }
    });

    if (legendEl) {
        legendEl.innerHTML = labels.map((l, i) => {
            return `<div><span style="color:${colors[i]}">●</span> ${l}: <strong>${data[i]}</strong></div>`;
        }).join('');
    }
}

function drawGauge(percent) {
    targetGaugeValue = percent;
    animateGauge();
}

function animateGauge() {
    const diff = targetGaugeValue - currentGaugeValue;

    if (Math.abs(diff) < 0.1) {
        currentGaugeValue = targetGaugeValue;
    } else {
        currentGaugeValue += diff * 0.1;
        requestAnimationFrame(animateGauge);
    }

    const canvas = document.getElementById('gaugeCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, 100, 100);

    ctx.beginPath();
    ctx.arc(50, 50, 42, 0, 2 * Math.PI);
    ctx.strokeStyle = '#efebe9';
    ctx.lineWidth = 10;
    ctx.stroke();

    const startAngle = -0.5 * Math.PI;
    const endAngle = (currentGaugeValue / 100) * (2 * Math.PI) + startAngle;

    ctx.beginPath();
    ctx.arc(50, 50, 42, startAngle, endAngle);
    ctx.strokeStyle = '#2e7d32';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.stroke();

    const pText = document.getElementById('progressPercent');

    if (pText) {
        pText.innerText = Math.round(currentGaugeValue) + "%";
        pText.style.color = '#2e7d32';
    }
}


function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function encodeActionValue(value) {
    return encodeURIComponent(String(value ?? ""));
}

function decodeActionValue(value) {
    try {
        return decodeURIComponent(String(value ?? ""));
    } catch (error) {
        return String(value ?? "");
    }
}

function findAuditRecordByKey(encodedKey) {
    const key = decodeActionValue(encodedKey);
    const keyUpper = key.toUpperCase();

    return scanHistory.find(record => {
        const recordCloudId = String(record.cloudId || "");
        const recordId = String(record.id || "");
        const recordBarcode = String(record.barcode || "").toUpperCase();

        return recordCloudId === key ||
               recordId === key ||
               recordBarcode === keyUpper;
    });
}

function setModalMode(isEditMode) {
    const titleEl = document.getElementById('qcModalTitle');
    const saveButton = document.getElementById('btnSubmitQC');

    if (titleEl) {
        titleEl.textContent = isEditMode ? 'SCANNED ITEM DETAIL' : 'VERIFICATION';
    }

    if (saveButton) {
        saveButton.textContent = isEditMode ? 'UPDATE AUDIT RECORD' : 'SAVE AUDIT RECORD';
    }
}

function buildCurrentItemFromAudit(auditRecord) {
    const barcode = auditRecord?.barcode || "";
    const lookupCode = barcode.toUpperCase();
    const isUrl = barcode.toLowerCase().startsWith('http');
    const masterInfo = masterDB[lookupCode];

    const data = masterInfo || {
        name: auditRecord?.name || (isUrl ? "EXTERNAL URL" : "UNREGISTERED"),
        loc: auditRecord?.updatedLocation || "N/A",
        due: auditRecord?.updatedDue || "N/A",
        status: auditRecord?.updatedStatus || "N/A",
        msa: "N/A"
    };

    return {
        barcode,
        ...data,
        isUnregistered: !masterInfo
    };
}

function renderQCModal(auditRecord = null) {
    const modalDataBox = document.getElementById('modalDataBox');
    const remarkEl = document.getElementById('qcRemark');
    const isEditMode = !!auditRecord;

    setModalMode(isEditMode);

    if (modalDataBox && currentItem) {
        const safeCode = escapeHtml(currentItem.barcode);
        const safeName = escapeHtml(currentItem.name);
        const safeLoc = escapeHtml(currentItem.loc);
        const safeDue = escapeHtml(currentItem.due);
        const safeStatus = escapeHtml(currentItem.status || "N/A");
        const safeMsa = escapeHtml(currentItem.msa || "N/A");
        const editDisabled = currentItem.isUnregistered ? "disabled" : "";
        const editTitle = currentItem.isUnregistered
            ? "Unregistered items cannot overwrite the master database."
            : "Press EDIT, change the value, press OK, then SAVE AUDIT RECORD to update Firebase master_list.";
        const detailMeta = isEditMode ? `
            <div class="scan-detail-meta">
                <div><span>Scanned Time</span><strong>${escapeHtml(auditRecord.time || "-")}</strong></div>
                <div><span>Scanned By</span><strong>${escapeHtml(auditRecord.pic || "-")}</strong></div>
                <div><span>Status</span><strong>${escapeHtml(auditRecord.isFail ? "FAIL" : "PASS")}</strong></div>
                <div><span>Equipment Status</span><strong>${safeStatus}</strong></div>
            </div>
        ` : "";

        modalDataBox.innerHTML = `
            <div style="word-break: break-all; margin-bottom:10px;">
                <span style="color:var(--text-muted); font-size:12px;">Scanned Content:</span><br>
                <span style="color:var(--primary); font-weight:bold;">${safeCode}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin:4px 0; gap:12px;">
                <span style="color:var(--text-muted)">Equipment Name:</span>
                <span style="color:var(--primary); font-weight:bold; text-align:right;">${safeName}</span>
            </div>
            ${detailMeta}
            <div style="border-top: 1px solid var(--border-color); margin: 8px 0; padding-top: 8px;"></div>

            <div class="master-edit-row">
                <span style="color:var(--text-muted)">Reg. Location:</span>
                <div class="master-edit-control">
                    <span id="qcLocationDisplay" class="master-edit-value">${safeLoc}</span>
                    <input type="text" id="qcLocationInput" class="master-edit-input" value="${safeLoc}" data-original-value="${safeLoc}"
                           onkeydown="if(event.key === 'Enter'){ toggleMasterFieldEdit('loc'); }" ${editDisabled}>
                    <button type="button" id="btnEditLocation" class="btn-inline-edit" onclick="toggleMasterFieldEdit('loc')" title="${editTitle}" ${editDisabled}>EDIT</button>
                </div>
            </div>

            <div class="master-edit-row">
                <span style="color:var(--text-muted)">Reg. Due:</span>
                <div class="master-edit-control">
                    <span id="qcDueDisplay" class="master-edit-value">${safeDue}</span>
                    <input type="text" id="qcDueInput" class="master-edit-input" value="${safeDue}" data-original-value="${safeDue}"
                           placeholder="APR-27 or 04/2027"
                           onkeydown="if(event.key === 'Enter'){ toggleMasterFieldEdit('due'); }" ${editDisabled}>
                    <button type="button" id="btnEditDue" class="btn-inline-edit" onclick="toggleMasterFieldEdit('due')" title="${editTitle}" ${editDisabled}>EDIT</button>
                </div>
            </div>

            <div class="master-edit-row">
                <span style="color:var(--text-muted)">Equipment Status:</span>
                <div class="master-edit-control">
                    <span id="qcStatusDisplay" class="master-edit-value">${safeStatus}</span>
                    <input type="text" id="qcStatusInput" class="master-edit-input" value="${safeStatus}" data-original-value="${safeStatus}"
                           list="qcStatusSuggestions" maxlength="60" autocapitalize="characters"
                           onkeydown="if(event.key === 'Enter'){ toggleMasterFieldEdit('status'); }" ${editDisabled}>
                    <button type="button" id="btnEditStatus" class="btn-inline-edit" onclick="toggleMasterFieldEdit('status')" title="${editTitle}" ${editDisabled}>EDIT</button>
                    <datalist id="qcStatusSuggestions">
                        <option value="ACTIVE"></option>
                        <option value="INACTIVE"></option>
                        <option value="UNDER REPAIR"></option>
                        <option value="OUT OF SERVICE"></option>
                        <option value="MISSING"></option>
                        <option value="DISPOSED"></option>
                    </datalist>
                </div>
            </div>

            <div class="master-edit-row">
                <span style="color:var(--text-muted)">Registered MSA:</span>
                <div class="master-edit-control">
                    <span class="master-edit-value">${safeMsa}</span>
                </div>
            </div>

           
        `;
    }

    if (remarkEl) {
        const existingRemark = auditRecord ? (auditRecord.remark || "") : "";
        remarkEl.value = existingRemark === "-" ? "" : existingRemark;
    }

    setToggle('Loc', auditRecord ? (auditRecord.locRes || 'CORRECT') : (currentItem?.isUnregistered ? 'WRONG' : 'CORRECT'));
    setToggle('StickerLoc', auditRecord ? (auditRecord.stickerLocRes || 'CORRECT') : (currentItem?.isUnregistered ? 'WRONG' : 'CORRECT'));
    setToggle('Due', auditRecord ? (auditRecord.dueRes || 'VALID') : (currentItem?.isUnregistered ? 'EXPIRED' : 'VALID'));
    setToggle('Msa', auditRecord ? (auditRecord.msaRes || 'NO') : (currentItem?.isUnregistered ? 'NO' : 'YES'));

    const modal = document.getElementById('qcModal');
    if (modal) modal.style.display = 'flex';
}

async function openAuditDetail(encodedKey) {
    const auditRecord = findAuditRecordByKey(encodedKey);

    if (!auditRecord) {
        alert("Audit record not found.");
        return;
    }

    currentAuditEditId = auditRecord.cloudId || String(auditRecord.id || auditRecord.barcode || "");
    currentAuditEditRecord = auditRecord;
    currentLockOwned = false;
    currentItem = buildCurrentItemFromAudit(auditRecord);

    renderQCModal(auditRecord);
}

function parseLocationParts(locationValue) {
    const safeLocation = (locationValue || "").trim() || "N/A";
    const locParts = safeLocation.split("-");

    return {
        loc: safeLocation,
        bldg: (locParts[0] || "N/A").trim(),
        prod: (locParts[1] || "N/A").trim()
    };
}

function normalizeEquipmentStatus(statusValue) {
    return String(statusValue || "")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase();
}

function getMonthNameFromValue(value) {
    const cleaned = String(value || "").trim().toUpperCase();
    const monthNumber = parseInt(cleaned, 10);

    if (!Number.isNaN(monthNumber) && monthNumber >= 1 && monthNumber <= 12) {
        return MONTH_ORDER[monthNumber - 1];
    }

    const threeLetterMonth = cleaned.slice(0, 3);
    return MONTH_ORDER.includes(threeLetterMonth) ? threeLetterMonth : cleaned;
}

function normalizeYearValue(yearValue) {
    const cleaned = String(yearValue || "").trim();

    if (!cleaned) return "N/A";
    if (cleaned.length === 2 && /^\d{2}$/.test(cleaned)) return "20" + cleaned;

    return cleaned;
}

function buildDisplayDue(monthValue, yearValue) {
    const safeMonth = monthValue || "N/A";
    const safeYear = yearValue || "N/A";

    if (safeMonth === "N/A" || safeYear === "N/A") return "N/A";

    return `${safeMonth}-${safeYear.slice(-2)}`;
}

function parseDueParts(dueValue) {
    const cleanedDue = String(dueValue ?? "").trim().toUpperCase();

    if (!cleanedDue) return null;
    if (cleanedDue === "N/A") {
        return {
            due: "N/A",
            month: "N/A",
            year: "N/A"
        };
    }

    let month = "N/A";
    let year = "N/A";
    let displayDue = cleanedDue;

    if (cleanedDue.includes("/")) {
        const parts = cleanedDue.split("/").map(part => part.trim()).filter(Boolean);
        month = getMonthNameFromValue(parts[0]);
        year = normalizeYearValue(parts.length >= 3 ? parts[2] : parts[1]);
        displayDue = buildDisplayDue(month, year);
    } else if (cleanedDue.includes("-")) {
        const parts = cleanedDue.split("-").map(part => part.trim());
        month = getMonthNameFromValue(parts[0]);
        year = normalizeYearValue(parts[1]);
        displayDue = buildDisplayDue(month, year);
    }

    return {
        due: displayDue,
        month,
        year
    };
}

function updateRawMasterFields(lookupCode, newLocation, newDue, newStatus) {
    const rowIndex = rawMasterRows.findIndex((row, index) => {
        return index > 0 && ((row[0] || "").toUpperCase() === lookupCode);
    });

    if (rowIndex === -1) return;

    while (rawMasterRows[rowIndex].length < 6) {
        rawMasterRows[rowIndex].push("");
    }

    if (newLocation !== null && newLocation !== undefined) {
        rawMasterRows[rowIndex][2] = newLocation;
    }

    if (newDue !== null && newDue !== undefined) {
        rawMasterRows[rowIndex][3] = newDue;
    }

    if (newStatus !== null && newStatus !== undefined) {
        rawMasterRows[rowIndex][4] = newStatus;
    }
}

function toggleMasterFieldEdit(field) {
    if (!currentItem) return;

    if (currentItem.isUnregistered) {
        alert("Unregistered items cannot overwrite the master database.");
        return;
    }

    const fields = {
        loc: {
            inputId: 'qcLocationInput',
            displayId: 'qcLocationDisplay',
            buttonId: 'btnEditLocation',
            emptyMessage: 'Location cannot be blank.',
            auditToggle: () => setToggle('Loc', 'WRONG')
        },
        due: {
            inputId: 'qcDueInput',
            displayId: 'qcDueDisplay',
            buttonId: 'btnEditDue',
            emptyMessage: 'Due date cannot be blank.'
        },
        status: {
            inputId: 'qcStatusInput',
            displayId: 'qcStatusDisplay',
            buttonId: 'btnEditStatus',
            emptyMessage: 'Equipment status cannot be blank.'
        }
    };

    const config = fields[field];
    if (!config) return;

    const inputEl = document.getElementById(config.inputId);
    const displayEl = document.getElementById(config.displayId);
    const buttonEl = document.getElementById(config.buttonId);

    if (!inputEl || !displayEl || !buttonEl) return;

    const isEditing = inputEl.style.display === 'block';

    if (!isEditing) {
        displayEl.style.display = 'none';
        inputEl.style.display = 'block';
        buttonEl.innerText = 'OK';
        buttonEl.classList.add('active');
        inputEl.focus();
        inputEl.select();
        return;
    }

    const rawValue = inputEl.value.trim();

    if (!rawValue) {
        alert(config.emptyMessage);
        inputEl.focus();
        return;
    }

    let displayValue = rawValue;

    if (field === 'due') {
        const dueParts = parseDueParts(rawValue);

        if (!dueParts || !dueParts.due) {
            alert('Due date cannot be blank.');
            inputEl.focus();
            return;
        }

        displayValue = dueParts.due;
        inputEl.value = displayValue;
    } else if (field === 'status') {
        displayValue = normalizeEquipmentStatus(rawValue);
        inputEl.value = displayValue;
    }

    displayEl.textContent = displayValue;
    displayEl.style.display = 'inline';
    inputEl.style.display = 'none';
    buttonEl.innerText = 'EDIT';
    buttonEl.classList.remove('active');

    if (config.auditToggle && displayValue !== (inputEl.dataset.originalValue || "")) {
        config.auditToggle();
    }
}

async function overwriteMasterFieldsIfChanged(newLocation, newDueValue, newStatusValue) {
    const result = {
        locationUpdated: false,
        dueUpdated: false,
        statusUpdated: false
    };

    if (!currentItem || currentItem.isUnregistered) return result;

    const lookupCode = (currentItem.barcode || "").toUpperCase();
    const currentMaster = masterDB[lookupCode];

    if (!currentMaster) return result;

    const cleanedLocation = (newLocation || "").trim();
    const cleanedDue = (newDueValue || "").trim();
    const cleanedStatus = normalizeEquipmentStatus(newStatusValue);

    if (!cleanedLocation) {
        alert("Location cannot be blank.");
        return null;
    }

    if (!cleanedDue) {
        alert("Due date cannot be blank.");
        return null;
    }

    if (!cleanedStatus) {
        alert("Equipment status cannot be blank.");
        return null;
    }

    const locationParts = parseLocationParts(cleanedLocation);
    const dueParts = parseDueParts(cleanedDue);

    if (!dueParts) {
        alert("Due date cannot be blank.");
        return null;
    }

    const locationChanged = locationParts.loc !== (currentMaster.loc || "");
    const dueChanged = dueParts.due !== (currentMaster.due || "");
    const statusChanged = cleanedStatus !== normalizeEquipmentStatus(currentMaster.status || "N/A");

    if (!locationChanged && !dueChanged && !statusChanged) return result;

    if (!isOnline) {
        alert("Cannot overwrite the master database while offline. Please reconnect and save again.");
        return null;
    }

    const updatedMaster = {
        ...currentMaster
    };

    if (locationChanged) {
        updatedMaster.loc = locationParts.loc;
        updatedMaster.bldg = locationParts.bldg;
        updatedMaster.prod = locationParts.prod;
        result.locationUpdated = true;
    }

    if (dueChanged) {
        updatedMaster.due = dueParts.due;
        updatedMaster.month = dueParts.month;
        updatedMaster.year = dueParts.year;
        result.dueUpdated = true;
    }

    if (statusChanged) {
        updatedMaster.status = cleanedStatus;
        result.statusUpdated = true;
    }

    masterDB[lookupCode] = updatedMaster;
    updateRawMasterFields(
        lookupCode,
        locationChanged ? locationParts.loc : null,
        dueChanged ? dueParts.due : null,
        statusChanged ? cleanedStatus : null
    );

    await db.ref('master_list').set({
        masterDB,
        rawMasterRows
    });

    currentItem = {
        ...currentItem,
        ...updatedMaster
    };

    rebuildFilters();
    updateDisplay();

    return result;
}
async function handleScannedCode(barcode) {
    if (!barcode) return;

    const cleanCode = barcode.trim().replace(/[\r\n]/g, "");
    const lookupCode = cleanCode.toUpperCase();

    currentAuditEditId = null;
    currentAuditEditRecord = null;
    currentLockOwned = false;

    const existing = scanHistory.find(item => {
        return (item.barcode || "").toUpperCase() === lookupCode;
    });

    if (existing) {
        const pPic = document.getElementById('prevPIC');
        const pTime = document.getElementById('prevTime');
        const banner = document.getElementById('alertBanner');

        if (pPic) pPic.innerText = existing.pic || "-";
        if (pTime) pTime.innerText = existing.time || "-";

        if (banner) {
            banner.classList.add('show');
            setTimeout(() => banner.classList.remove('show'), 4000);
        }

        openAuditDetail(encodeActionValue(existing.cloudId || existing.id || existing.barcode || ""));
        return;
    }

    if (isOnline) {
        const lockKey = btoa(cleanCode).replace(/=/g, "");
        const lock = activeLocks[lockKey];

        if (lock && lock.user !== loggedInUser) {
            alert(`COLLISION: ${lock.user} is currently auditing this!`);
            return;
        }

        const lockResult = await attemptLock(cleanCode);

        if (lockResult && lockResult.committed === false) {
            alert("This item is currently being audited by another user.");
            return;
        }

        currentLockOwned = true;
    }

    const isUrl = cleanCode.toLowerCase().startsWith('http');
    const masterInfo = masterDB[lookupCode];

    const data = masterInfo || {
        name: isUrl ? "EXTERNAL URL" : "UNREGISTERED",
        loc: "N/A",
        due: "N/A",
        status: "N/A",
        msa: "N/A"
    };

    currentItem = {
        barcode: cleanCode,
        ...data,
        isUnregistered: !masterInfo
    };

    renderQCModal(null);
}
function setToggle(type, val) {
    if (type === 'Loc') {
        selectedLoc = val;

        document.getElementById('btnLocCorrect').className =
            val === 'CORRECT' ? 'option-btn active-pass' : 'option-btn';

        document.getElementById('btnLocWrong').className =
            val === 'WRONG' ? 'option-btn active-fail' : 'option-btn';

    } else if (type === 'StickerLoc') {
        selectedStickerLoc = val;

        document.getElementById('btnStickerLocCorrect').className =
            val === 'CORRECT' ? 'option-btn active-pass' : 'option-btn';

        document.getElementById('btnStickerLocWrong').className =
            val === 'WRONG' ? 'option-btn active-fail' : 'option-btn';

    } else if (type === 'Due') {
        selectedDue = val;

        document.getElementById('btnDueValid').className =
            val === 'VALID' ? 'option-btn active-pass' : 'option-btn';

        document.getElementById('btnDueExpired').className =
            val === 'EXPIRED' ? 'option-btn active-fail' : 'option-btn';

    } else if (type === 'Msa') {
        selectedMsa = val;

        document.getElementById('btnMsaYes').className =
            val === 'YES' ? 'option-btn active-pass' : 'option-btn';

        document.getElementById('btnMsaNo').className =
            val === 'NO' ? 'option-btn active-fail' : 'option-btn';
    }
}

function auditRecordsMatch(a, b) {
    if (!a || !b) return false;

    const aCloud = String(a.cloudId || "");
    const bCloud = String(b.cloudId || "");

    if (aCloud && bCloud && aCloud === bCloud) return true;

    const aId = String(a.id || "");
    const bId = String(b.id || "");

    if (aId && bId && aId === bId) return true;

    const aBarcode = String(a.barcode || "").toUpperCase();
    const bBarcode = String(b.barcode || "").toUpperCase();

    return !!aBarcode && aBarcode === bBarcode;
}

function updateLocalAuditRecord(updatedRecord) {
    scanHistory = scanHistory.map(record => {
        return auditRecordsMatch(record, updatedRecord) ? { ...record, ...updatedRecord } : record;
    });

    pendingUploads = pendingUploads.map(record => {
        return auditRecordsMatch(record, updatedRecord) ? { ...record, ...updatedRecord } : record;
    });

    localStorage.setItem('pending_queue', JSON.stringify(pendingUploads));
    updateDisplay();
}

async function saveEditedAuditRecord(updatedRecord) {
    if (isOnline && updatedRecord.cloudId) {
        await db.ref('audit_history/' + updatedRecord.cloudId).update(updatedRecord);
        return;
    }

    updateLocalAuditRecord(updatedRecord);
}

// SUBMIT QC: Logic for Date + Time + Failure Rules
async function submitQC() {
    if (!currentItem) return;

    const remarkEl = document.getElementById('qcRemark');
    const locationEl = document.getElementById('qcLocationInput');
    const dueEl = document.getElementById('qcDueInput');
    const statusEl = document.getElementById('qcStatusInput');
    const remarkValue = remarkEl ? remarkEl.value.trim() : "";
    const editedLocation = locationEl ? locationEl.value.trim() : currentItem.loc;
    const editedDue = dueEl ? dueEl.value.trim() : currentItem.due;
    const editedStatus = statusEl ? statusEl.value.trim() : currentItem.status;
    const isEditMode = !!currentAuditEditRecord;
    const existingRecord = currentAuditEditRecord || {};

    const masterUpdateResult = await overwriteMasterFieldsIfChanged(editedLocation, editedDue, editedStatus);

    if (masterUpdateResult === null) {
        return;
    }

    const masterLocationUpdated = masterUpdateResult.locationUpdated;
    const masterDueUpdated = masterUpdateResult.dueUpdated;
    const masterStatusUpdated = masterUpdateResult.statusUpdated;
    const savedMasterLocationUpdated = Boolean(existingRecord.masterLocationUpdated || masterLocationUpdated);
    const savedMasterDueUpdated = Boolean(existingRecord.masterDueUpdated || masterDueUpdated);
    const savedMasterStatusUpdated = Boolean(existingRecord.masterStatusUpdated || masterStatusUpdated);

    if (masterLocationUpdated) {
        selectedLoc = "WRONG";
    }

    const updateRemarks = [];

    if (savedMasterLocationUpdated) updateRemarks.push("Location overwritten in master database");
    if (savedMasterDueUpdated) updateRemarks.push("Due date overwritten in master database");
    if (savedMasterStatusUpdated) updateRemarks.push("Equipment status overwritten in master database");

    const finalRemark = remarkValue || (updateRemarks.length ? updateRemarks.join("; ") : "-");

    const failed =
        selectedLoc === "WRONG" ||
        selectedStickerLoc === "WRONG" ||
        selectedDue === "EXPIRED" ||
        currentItem.isUnregistered ||
        savedMasterLocationUpdated ||
        savedMasterDueUpdated ||
        savedMasterStatusUpdated ||
        remarkValue.length > 0;

    const now = new Date();

    const dateTimeStr =
        now.toLocaleDateString('en-GB') +
        " " +
        now.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

    const auditData = {
        id: isEditMode ? (existingRecord.id || Date.now()) : Date.now(),
        time: isEditMode ? (existingRecord.time || dateTimeStr) : dateTimeStr,
        barcode: isEditMode ? (existingRecord.barcode || currentItem.barcode) : currentItem.barcode,
        name: currentItem.name,
        pic: isEditMode ? (existingRecord.pic || loggedInUser) : loggedInUser,
        locRes: selectedLoc,
        stickerLocRes: selectedStickerLoc,
        dueRes: selectedDue,
        msaRes: selectedMsa,
        updatedLocation: currentItem.loc,
        updatedDue: currentItem.due,
        updatedStatus: currentItem.status,
        masterLocationUpdated: savedMasterLocationUpdated,
        masterDueUpdated: savedMasterDueUpdated,
        masterStatusUpdated: savedMasterStatusUpdated,
        remark: finalRemark,
        isFail: failed,
        isUnregistered: currentItem.isUnregistered
    };

    if (isEditMode) {
        if (existingRecord.cloudId) {
            auditData.cloudId = existingRecord.cloudId;
        }

        auditData.editedBy = loggedInUser;
        auditData.editedAt = dateTimeStr;

        await saveEditedAuditRecord(auditData);
        closeModal();
        return;
    }

    if (isOnline) {
        const newRef = db.ref('audit_history').push();
        auditData.cloudId = newRef.key;
        await newRef.set(auditData);
    } else {
        pendingUploads.push(auditData);
        localStorage.setItem('pending_queue', JSON.stringify(pendingUploads));
        scanHistory.unshift(auditData);
        updateDisplay();
    }

    closeModal();
}
function closeModal() {
    if (currentItem && currentLockOwned) {
        releaseLock(currentItem.barcode);
    }

    const modal = document.getElementById('qcModal');
    const remarkEl = document.getElementById('qcRemark');

    if (modal) modal.style.display = 'none';
    if (remarkEl) remarkEl.value = "";

    currentItem = null;
    currentAuditEditId = null;
    currentAuditEditRecord = null;
    currentLockOwned = false;
    setModalMode(false);

    updateDisplay();

    setTimeout(() => {
        const barcodeCollector = document.getElementById('barcodeCollector');
        if (barcodeCollector) barcodeCollector.focus();
    }, 100);
}

function getAccessModeForPassword(password) {
    if (password === USER_PASS) return ACCESS_MODE_USER;
    if (password === DEVELOPER_PASS) return ACCESS_MODE_DEVELOPER;
    return "";
}

function isDeveloperMode() {
    return currentAccessMode === ACCESS_MODE_DEVELOPER;
}

function canDeleteAuditRecords() {
    return currentAccessMode === ACCESS_MODE_USER ||
           currentAccessMode === ACCESS_MODE_DEVELOPER;
}

function showAccessDenied(actionLabel) {
    const message = `${actionLabel} is available in Developer Mode only.`;

    if (typeof showToast === "function") {
        showToast(message, "error");
    } else {
        alert(message);
    }
}

function applyAccessMode(mode) {
    currentAccessMode = mode === ACCESS_MODE_DEVELOPER
        ? ACCESS_MODE_DEVELOPER
        : ACCESS_MODE_USER;

    const developerMode = isDeveloperMode();
    document.body.dataset.accessMode = currentAccessMode;

    const badge = document.getElementById('accessModeBadge');
    if (badge) {
        badge.textContent = developerMode ? "DEVELOPER MODE" : "USER MODE";
        badge.classList.toggle('developer', developerMode);
        badge.classList.toggle('user', !developerMode);
    }

    const clearCloudButton = document.getElementById('clearCloudButton');
    if (clearCloudButton) {
        clearCloudButton.hidden = !developerMode;
        clearCloudButton.setAttribute('aria-hidden', String(!developerMode));
    }

    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
        logoutButton.textContent = developerMode ? "Logout & Clear" : "Logout";
        logoutButton.title = developerMode
            ? "Logout and clear cloud audit history"
            : "Logout without deleting scan history or cloud data";
        logoutButton.classList.toggle('logout-clear-mode', developerMode);
    }
}

function checkLogin() {
    const usernameEl = document.getElementById('username');
    const passwordEl = document.getElementById('password');

    const u = usernameEl ? usernameEl.value.trim() : "";
    const p = passwordEl ? passwordEl.value : "";
    const accessMode = getAccessModeForPassword(p);

    if (u && accessMode) {
        loggedInUser = u;
        applyAccessMode(accessMode);

        const userDisp = document.getElementById('userDisp');
        const loginOverlay = document.getElementById('loginOverlay');
        const mainApp = document.getElementById('mainApp');

        if (userDisp) userDisp.innerText = u;
        if (loginOverlay) loginOverlay.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';

        initScannerInput();
        updateDisplay();
    } else {
        alert("Invalid name or password");
    }
}

async function clearAllCloudData() {
    if (!isDeveloperMode()) {
        showAccessDenied("Clear Cloud");
        return;
    }

    if (!confirm("Clear all cloud audit history and temporary locks? This cannot be undone.")) return;

    await Promise.all([
        db.ref('audit_history').remove(),
        db.ref('temporary_locks').remove()
    ]);

    scanHistory = [];
    activeLocks = {};

    updateDisplay();
}

async function logout() {
    const developerMode = isDeveloperMode();
    const message = developerMode
        ? "Logout and clear all cloud audit history, temporary locks, and this device's pending scan queue? This cannot be undone."
        : "Logout from User Mode? Scan history and cloud data will remain unchanged.";

    if (!confirm(message)) return;

    if (developerMode) {
        await Promise.all([
            db.ref('audit_history').remove(),
            db.ref('temporary_locks').remove()
        ]);

        pendingUploads = [];
        localStorage.removeItem('pending_queue');
    }

    currentAccessMode = "";
    document.body.removeAttribute('data-access-mode');
    location.reload();
}

function initScannerInput() {
    const col = document.getElementById('barcodeCollector');
    if (!col) return;

    document.addEventListener('mousedown', (e) => {
        const modal = document.getElementById('qcModal');
        const isModalVisible = modal && modal.style.display === 'flex';

        const isInteractive = [
            'INPUT',
            'SELECT',
            'BUTTON',
            'A',
            'TEXTAREA'
        ].includes(e.target.tagName);

        if (!isModalVisible && !isInteractive) {
            setTimeout(() => col.focus(), 50);
        }
    });

    col.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            handleScannedCode(col.value);
            col.value = "";
        }
    });

    col.focus();
}

function submitManualEntry() {
    const input = document.getElementById('manualBarcode');
    if (!input) return;

    const barcode = input.value.trim();

    if (barcode) {
        handleScannedCode(barcode);
        input.value = "";
    }
}

function exportToExcel() {
    if (!rawMasterRows.length && scanHistory.length === 0) {
        alert("No data to export");
        return;
    }

    const auditHeader = [
        "EQUIPMENT CODE",
        "EQUIPMENT NAME",
        "LOCATION",
        "DUE DATE",
        "STATUS",
        "MSA",
        "Audit Status",
        "Date/Time",
        "Auditor",
        "Loc_Audit",
        "Sticker_Loc_Audit",
        "Due_Audit",
        "MSA_Audit",
        "Remark"
    ];

    let auditData = [auditHeader];
    let unregisteredData = [auditHeader];

    rawMasterRows.slice(1).forEach(r => {
        const code = (r[0] || "").toUpperCase();
        const baseRow = r.slice(0, 6);

        const s = scanHistory.find(h => {
            return (h.barcode || "").toUpperCase() === code;
        });

        if (s) {
            const statusLabel = s.isFail ? "FAIL (AUDIT)" : "SCANNED";

            auditData.push([
                ...baseRow,
                statusLabel,
                s.time,
                s.pic,
                s.locRes,
                s.stickerLocRes || "",
                s.dueRes,
                s.msaRes,
                s.remark
            ]);
        } else {
            auditData.push([
                ...baseRow,
                "PENDING",
                "",
                "",
                "",
                "",
                "",
                "",
                ""
            ]);
        }
    });

    scanHistory.forEach(s => {
        if (!masterDB[(s.barcode || "").toUpperCase()]) {
            unregisteredData.push([
                s.barcode,
                s.name,
                "N/A",
                "N/A",
                "UNREGISTERED",
                "N/A",
                "FAIL (UNREGISTERED)",
                s.time,
                s.pic,
                s.locRes,
                s.stickerLocRes || "",
                s.dueRes,
                s.msaRes,
                s.remark
            ]);
        }
    });

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet(auditData),
        "Audit Report"
    );

    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet(unregisteredData),
        "Unregistered Items"
    );

    XLSX.writeFile(wb, `Audit_Report_Full.xlsx`);
}

function deleteRow(encodedKey) {
    if (!canDeleteAuditRecords()) {
        const message = "Please log in before deleting an audit record.";

        if (typeof showToast === "function") {
            showToast(message, "error");
        } else {
            alert(message);
        }
        return;
    }

    const record = findAuditRecordByKey(encodedKey);
    const cloudId = record?.cloudId || decodeActionValue(encodedKey);

    if (!confirm("Delete this audit record only? This cannot be undone.")) return;

    if (cloudId && isOnline) {
        db.ref('audit_history/' + cloudId).remove();
        return;
    }

    if (record) {
        scanHistory = scanHistory.filter(item => !auditRecordsMatch(item, record));
        pendingUploads = pendingUploads.filter(item => !auditRecordsMatch(item, record));
        localStorage.setItem('pending_queue', JSON.stringify(pendingUploads));
        updateDisplay();
    }
}

async function toggleCamera() {
    const r = document.getElementById('reader');
    if (!r) return;

    if (!html5QrCode) {
        r.style.display = "block";
        html5QrCode = new Html5Qrcode("reader");

        const config = {
            fps: 30,
            qrbox: {
                width: 280,
                height: 200
            }
        };

        html5QrCode.start(
            { facingMode: "environment" },
            config,
            (text) => {
                html5QrCode.stop().then(() => {
                    html5QrCode = null;
                    r.style.display = "none";
                    handleScannedCode(text);
                });
            }
        ).catch(() => {
            alert("Camera Error.");
        });
    } else {
        html5QrCode.stop().then(() => {
            html5QrCode = null;
            r.style.display = "none";
        });
    }
}
