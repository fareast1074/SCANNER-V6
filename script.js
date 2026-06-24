// --- CONFIGURATION ---
const AUTH_PASS = "1234";
const MASTER_PASS = "admin";
const MONTH_ORDER = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// --- STATE MANAGEMENT ---
let scanHistory = []; 
let masterDB = {}; 
let rawMasterRows = []; 
let pendingUploads = JSON.parse(localStorage.getItem('pending_queue')) || [];
let activeLocks = {};

let currentItem = null;
let loggedInUser = "";
let html5QrCode = null;
let currentGaugeValue = 0;
let targetGaugeValue = 0;
let isOnline = false;

let selectedLoc = "CORRECT";
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
    const data = snapshot.val();
    scanHistory = data ? Object.values(data).sort((a, b) => b.id - a.id) : [];
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
                    <td><span class="status-pill ${i.dueRes === 'VALID' ? 'pill-pass' : 'pill-fail'}">${i.dueRes}</span></td>
                    <td>${originalStatus}</td>
                    <td><span class="status-pill ${i.msaRes === 'YES' ? 'pill-pass' : 'pill-fail'}">${i.msaRes}</span></td>
                    <td>${i.remark}</td>
                    <td><button class="btn-delete-row" onclick="deleteRow('${i.cloudId || ''}')">Del</button></td>
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

async function handleScannedCode(barcode) {
    if (!barcode) return;

    const cleanCode = barcode.trim().replace(/[\r\n]/g, ""); 
    const lookupCode = cleanCode.toUpperCase();

    const existing = scanHistory.find(item => {
        return (item.barcode || "").toUpperCase() === lookupCode;
    });

    if (existing) {
        const pPic = document.getElementById('prevPIC');
        const pTime = document.getElementById('prevTime');
        const banner = document.getElementById('alertBanner');

        if (pPic) pPic.innerText = existing.pic;
        if (pTime) pTime.innerText = existing.time;

        if (banner) {
            banner.classList.add('show');
            setTimeout(() => banner.classList.remove('show'), 4000);
        }

        return;
    }

    if (isOnline) {
        const lockKey = btoa(cleanCode).replace(/=/g, "");
        const lock = activeLocks[lockKey];

        if (lock && lock.user !== loggedInUser) {
            alert(`COLLISION: ${lock.user} is currently auditing this!`);
            return;
        }

        await attemptLock(cleanCode);
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

    const modalDataBox = document.getElementById('modalDataBox');

    if (modalDataBox) {
        modalDataBox.innerHTML = `
            <div style="word-break: break-all; margin-bottom:10px;">
                <span style="color:var(--text-muted); font-size:12px;">Scanned Content:</span><br>
                <span style="color:var(--primary); font-weight:bold;">${cleanCode}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin:4px 0;">
                <span style="color:var(--text-muted)">Equipment Name:</span>
                <span style="color:var(--primary); font-weight:bold;">${currentItem.name}</span>
            </div>
            <div style="border-top: 1px solid var(--border-color); margin: 8px 0; padding-top: 8px;"></div>
            <div style="display:flex; justify-content:space-between; margin:2px 0;">
                <span style="color:var(--text-muted)">Reg. Location:</span>
                <span style="color:var(--primary);">${currentItem.loc}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin:2px 0;">
                <span style="color:var(--text-muted)">Reg. Due:</span>
                <span style="color:var(--primary);">${currentItem.due}</span>
            </div>
        `;
    }

    setToggle('Loc', masterInfo ? 'CORRECT' : 'WRONG'); 
    setToggle('Due', masterInfo ? 'VALID' : 'EXPIRED'); 
    setToggle('Msa', masterInfo ? 'YES' : 'NO');

    const modal = document.getElementById('qcModal');
    if (modal) modal.style.display = 'flex';
}

function setToggle(type, val) {
    if (type === 'Loc') {
        selectedLoc = val;

        document.getElementById('btnLocCorrect').className =
            val === 'CORRECT' ? 'option-btn active-pass' : 'option-btn';

        document.getElementById('btnLocWrong').className =
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

// SUBMIT QC: Logic for Date + Time + Failure Rules
function submitQC() {
    if (!currentItem) return;

    const remarkEl = document.getElementById('qcRemark');
    const remarkValue = remarkEl ? remarkEl.value.trim() : "";

    const failed =
        selectedLoc === "WRONG" ||
        selectedDue === "EXPIRED" ||
        currentItem.isUnregistered ||
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
        id: Date.now(),
        time: dateTimeStr,
        barcode: currentItem.barcode,
        name: currentItem.name,
        pic: loggedInUser,
        locRes: selectedLoc,
        dueRes: selectedDue,
        msaRes: selectedMsa,
        remark: remarkValue || "-",
        isFail: failed,
        isUnregistered: currentItem.isUnregistered
    };

    if (isOnline) {
        const newRef = db.ref('audit_history').push();
        auditData.cloudId = newRef.key;
        newRef.set(auditData);
    } else {
        pendingUploads.push(auditData);
        localStorage.setItem('pending_queue', JSON.stringify(pendingUploads));
        scanHistory.unshift(auditData);
        updateDisplay();
    }

    closeModal();
}

function closeModal() {
    if (currentItem) {
        releaseLock(currentItem.barcode);
    }

    const modal = document.getElementById('qcModal');
    const remarkEl = document.getElementById('qcRemark');

    if (modal) modal.style.display = 'none';
    if (remarkEl) remarkEl.value = "";

    currentItem = null;

    updateDisplay();

    setTimeout(() => {
        const barcodeCollector = document.getElementById('barcodeCollector');
        if (barcodeCollector) barcodeCollector.focus();
    }, 100);
}

function checkLogin() {
    const usernameEl = document.getElementById('username');
    const passwordEl = document.getElementById('password');

    const u = usernameEl ? usernameEl.value : "";
    const p = passwordEl ? passwordEl.value : "";

    if (u && p === AUTH_PASS) {
        loggedInUser = u;

        const userDisp = document.getElementById('userDisp');
        const loginOverlay = document.getElementById('loginOverlay');
        const mainApp = document.getElementById('mainApp');

        if (userDisp) userDisp.innerText = u;
        if (loginOverlay) loginOverlay.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';

        initScannerInput();
        updateDisplay();
    } else {
        alert("Invalid Credentials");
    }
}

async function clearAllCloudData() {
    if (!confirm("Clear all cloud audit history and temporary locks?")) return;

    await db.ref('audit_history').remove();
    await db.ref('temporary_locks').remove();

    scanHistory = [];
    activeLocks = {};

    updateDisplay();
}

async function logout() {
    if (confirm("Logout and Reset Scan Session?")) {
        await db.ref('audit_history').remove();
        await db.ref('temporary_locks').remove();

        localStorage.removeItem('pending_queue');

        location.reload();
    }
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

function deleteRow(cloudId) {
    if (confirm("Remove from Cloud?")) {
        if (cloudId) {
            db.ref('audit_history/' + cloudId).remove();
        }
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
