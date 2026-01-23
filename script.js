const AUTH_PASS = "1234";
const MONTH_ORDER = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

let scanHistory = JSON.parse(localStorage.getItem('audit_history')) || []; 
let masterDB = JSON.parse(localStorage.getItem('master_db')) || {}; 
let rawMasterRows = JSON.parse(localStorage.getItem('raw_rows')) || []; 

let currentItem = null;
let loggedInUser = "";
let html5QrCode = null;
let currentGaugeValue = 0;
let targetGaugeValue = 0;

let selectedLoc = "CORRECT";
let selectedDue = "VALID";
let selectedMsa = "YES";

// --- CLOUD LISTENERS ---
db.ref('audit_history').on('value', (snapshot) => {
    const data = snapshot.val();
    scanHistory = data ? Object.values(data).sort((a, b) => b.id - a.id) : [];
    localStorage.setItem('audit_history', JSON.stringify(scanHistory));
    updateDisplay();
});

db.ref('master_list').on('value', (snapshot) => {
    const data = snapshot.val();
    if (data) {
        masterDB = data.masterDB;
        rawMasterRows = data.rawMasterRows;
        localStorage.setItem('master_db', JSON.stringify(masterDB));
        localStorage.setItem('raw_rows', JSON.stringify(rawMasterRows));
        rebuildFilters();
        updateDisplay();
    }
});

function checkLogin() {
    const u = document.getElementById('username').value;
    if (u && document.getElementById('password').value === AUTH_PASS) {
        loggedInUser = u;
        document.getElementById('userDisp').innerText = u;
        document.getElementById('loginOverlay').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
        initScannerInput();
        if (Object.keys(masterDB).length > 0) { rebuildFilters(); updateDisplay(); } else { drawGauge(0); }
    } else { alert("Invalid Credentials"); }
}

function logout() {
    if(confirm("Logging out will clear local cache. Continue?")) {
        localStorage.clear();
        location.reload();
    }
}

function loadMasterData(input) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const rows = e.target.result.split(/\r?\n/).filter(row => row.trim() !== "");
        let newMasterDB = {}; 
        let newRawRows = [];
        rows.forEach((row, i) => {
            const columns = row.split(',').map(s => s.trim());
            if (i === 0) { newRawRows.push(columns); return; }
            if (!columns[0]) return; 
            const fullLoc = columns[2] || "N/A";
            const locParts = fullLoc.split("-");
            let dateCol = columns[3] || ""; 
            let m = "N/A", y = "N/A";
            if(dateCol.includes("-")) {
                const parts = dateCol.split("-");
                m = parts[0].toUpperCase();
                let yearPart = parts[1].length === 4 ? parts[1].slice(-2) : parts[1];
                dateCol = m + "-" + yearPart;
                y = parts[1].length === 2 ? "20" + parts[1] : parts[1];
            }
            columns[3] = dateCol;
            newRawRows.push(columns);
            newMasterDB[columns[0].toUpperCase()] = { 
                name: columns[1]||"UNKNOWN", loc: fullLoc, 
                bldg: (locParts[0] || "N/A").trim(), prod: (locParts[1] || "N/A").trim(), 
                due: dateCol, msa: columns[4]||"N/A", month: m, year: y
            };
        });
        db.ref('master_list').set({ masterDB: newMasterDB, rawMasterRows: newRawRows });
    };
    reader.readAsText(input.files[0]);
}

function rebuildFilters() {
    let bldgSet = new Set(), prodSet = new Set(), monthSet = new Set(), yearSet = new Set();
    Object.values(masterDB).forEach(item => {
        if(item.bldg !== "N/A") bldgSet.add(item.bldg);
        if(item.prod !== "N/A") prodSet.add(item.prod);
        if(item.month !== "N/A") monthSet.add(item.month);
        if(item.year !== "N/A") yearSet.add(item.year);
    });
    const b = document.getElementById('filterBuilding'), p = document.getElementById('filterProduction'),
          m = document.getElementById('filterMonth'), y = document.getElementById('filterYear');
    b.innerHTML = '<option value="">All Buildings</option>';
    p.innerHTML = '<option value="">All Production</option>';
    m.innerHTML = '<option value="">All Months</option>';
    y.innerHTML = '<option value="">All Years</option>';
    Array.from(bldgSet).sort().forEach(x => b.innerHTML += `<option value="${x}">${x}</option>`);
    Array.from(prodSet).sort().forEach(x => p.innerHTML += `<option value="${x}">${x}</option>`);
    Array.from(monthSet).sort((a,b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b)).forEach(x => m.innerHTML += `<option value="${x}">${x}</option>`);
    Array.from(yearSet).sort().forEach(x => y.innerHTML += `<option value="${x}">${x}</option>`);
}

function updateDisplay() {
    const s = document.getElementById('globalSearch').value.toUpperCase();
    const bf = document.getElementById('filterBuilding').value;
    const pf = document.getElementById('filterProduction').value;
    const mf = document.getElementById('filterMonth').value;
    const yf = document.getElementById('filterYear').value;
    
    const allCodes = Object.keys(masterDB);
    const filteredTargetList = allCodes.filter(code => {
        const item = masterDB[code];
        return (!bf || item.bldg === bf) && (!pf || item.prod === pf) && (!mf || item.month === mf) && (!yf || item.year === yf);
    });

    const successScanned = scanHistory.filter(h => {
        const m = masterDB[h.barcode] || {};
        return !h.isFail && (!bf || m.bldg === bf) && (!pf || m.prod === pf) && (!mf || m.month === mf) && (!yf || m.year === yf);
    }).length;

    let per = filteredTargetList.length > 0 ? Math.min(100, Math.round((successScanned / filteredTargetList.length) * 100)) : 0;
    document.getElementById('progressSubLabel').innerText = `Success: ${successScanned} / ${filteredTargetList.length}`;
    drawGauge(per);

    const filteredScans = scanHistory.filter(h => {
        const m = masterDB[h.barcode] || {};
        return (h.barcode.includes(s) || h.name.toUpperCase().includes(s)) && (!bf || m.bldg === bf) && (!pf || m.prod === pf) && (!mf || m.month === mf) && (!yf || m.year === yf);
    });

    document.getElementById('totalScans').innerText = filteredScans.length;
    document.getElementById('totalFails').innerText = filteredScans.filter(x => x.isFail).length;

    document.getElementById('inventoryBody').innerHTML = filteredScans.map(i => `<tr class="${i.isFail ? 'row-fail' : ''}">
        <td>${i.time}</td><td>${i.barcode}</td><td>${i.name}</td><td style="color:var(--primary)">${i.pic}</td>
        <td><span class="status-pill ${i.locRes==='CORRECT'?'pill-pass':'pill-fail'}">${i.locRes}</span></td>
        <td><span class="status-pill ${i.dueRes==='VALID'?'pill-pass':'pill-fail'}">${i.dueRes}</span></td>
        <td><span class="status-pill ${i.msaRes==='YES'?'pill-pass':'pill-fail'}">${i.msaRes}</span></td>
        <td>${i.remark}</td><td><button class="btn-delete-row" onclick="deleteRow('${i.cloudId}')">Del</button></td></tr>`).join('');

    const scannedIds = new Set(scanHistory.map(x => x.barcode));
    document.getElementById('pendingBody').innerHTML = filteredTargetList.filter(c => {
        const item = masterDB[c];
        return !scannedIds.has(c) && (c.includes(s) || item.name.toUpperCase().includes(s));
    }).map(c => `<tr><td>${c}</td><td>${masterDB[c].name}</td><td>${masterDB[c].loc}</td><td>${masterDB[c].due}</td><td>${masterDB[c].msa}</td></tr>`).join('');
}

function drawGauge(percent) { targetGaugeValue = percent; animateGauge(); }

function animateGauge() {
    const diff = targetGaugeValue - currentGaugeValue;
    if (Math.abs(diff) < 0.1) { currentGaugeValue = targetGaugeValue; } else { currentGaugeValue += diff * 0.1; requestAnimationFrame(animateGauge); }
    const canvas = document.getElementById('gaugeCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d'), centerX = 50, centerY = 50, radius = 42;
    ctx.clearRect(0, 0, 100, 100);
    ctx.beginPath(); ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI); ctx.strokeStyle = '#0a192f'; ctx.lineWidth = 10; ctx.stroke();
    const startAngle = -0.5 * Math.PI;
    const endAngle = (currentGaugeValue / 100) * (2 * Math.PI) + startAngle;
    let color = getComputedStyle(document.documentElement).getPropertyValue('--success').trim();
    if (currentGaugeValue < 70) color = getComputedStyle(document.documentElement).getPropertyValue('--warning').trim();
    if (currentGaugeValue < 30) color = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
    ctx.beginPath(); ctx.arc(centerX, centerY, radius, startAngle, endAngle); ctx.strokeStyle = color; ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.stroke();
    document.getElementById('progressPercent').innerText = Math.round(currentGaugeValue) + "%";
    document.getElementById('progressPercent').style.color = color;
}

function handleScannedCode(barcode) {
    if (!barcode) return;
    const existing = scanHistory.find(item => item.barcode === barcode);
    if (existing) {
        document.getElementById('prevPIC').innerText = existing.pic;
        document.getElementById('prevTime').innerText = existing.time;
        document.getElementById('alertBanner').classList.add('show');
        setTimeout(() => document.getElementById('alertBanner').classList.remove('show'), 4000);
        return;
    }
    const data = masterDB[barcode] || { name: "NOT IN DATABASE", loc: "N/A", due: "N/A", msa: "N/A" };
    currentItem = { barcode, ...data };
    document.getElementById('modalDataBox').innerHTML = `
        <div style="display:flex; justify-content:space-between; margin:8px 0;"><span style="color:var(--primary)">Code:</span> <span style="color:white; font-weight:bold;">${currentItem.barcode}</span></div>
        <div style="display:flex; justify-content:space-between; margin:4px 0;"><span style="color:var(--primary)">Name:</span> <span style="color:white; font-weight:bold;">${currentItem.name}</span></div>
        <div style="border-top: 1px solid #233554; margin: 8px 0; padding-top: 8px;"></div>
        <div style="display:flex; justify-content:space-between; margin:2px 0;"><span style="color:var(--primary)">Reg. Location:</span> <span style="color:white;">${currentItem.loc}</span></div>
        <div style="display:flex; justify-content:space-between; margin:2px 0;"><span style="color:var(--primary)">Reg. Due:</span> <span style="color:white;">${currentItem.due}</span></div>
    `;
    setToggle('Loc', 'CORRECT'); setToggle('Due', 'VALID'); setToggle('Msa', 'YES');
    document.getElementById('qcModal').style.display = 'flex';
    setTimeout(() => document.getElementById('qcModal').focus(), 50);
}

function setToggle(type, val) {
    if(type === 'Loc') {
        selectedLoc = val;
        document.getElementById('btnLocCorrect').className = (val === 'CORRECT' ? 'option-btn active-pass' : 'option-btn');
        document.getElementById('btnLocWrong').className = (val === 'WRONG' ? 'option-btn active-fail' : 'option-btn');
    } else if(type === 'Due') {
        selectedDue = val;
        document.getElementById('btnDueValid').className = (val === 'VALID' ? 'option-btn active-pass' : 'option-btn');
        document.getElementById('btnDueExpired').className = (val === 'EXPIRED' ? 'option-btn active-fail' : 'option-btn');
    } else if(type === 'Msa') {
        selectedMsa = val;
        document.getElementById('btnMsaYes').className = (val === 'YES' ? 'option-btn active-pass' : 'option-btn');
        document.getElementById('btnMsaNo').className = (val === 'NO' ? 'option-btn active-fail' : 'option-btn');
    }
}

function submitQC() {
    if(!currentItem) return;
    const failed = (selectedLoc === "WRONG" || selectedDue === "EXPIRED" || selectedMsa === "" || currentItem.name === "NOT IN DATABASE");
    const newRef = db.ref('audit_history').push();
    const auditData = {
        id: Date.now(), cloudId: newRef.key, time: new Date().toLocaleTimeString(), 
        barcode: currentItem.barcode, name: currentItem.name, pic: loggedInUser, 
        locRes: selectedLoc, dueRes: selectedDue, msaRes: selectedMsa, 
        remark: document.getElementById('qcRemark').value || "-", isFail: failed
    };
    newRef.set(auditData);
    closeModal();
}

function closeModal() {
    document.getElementById('qcModal').style.display = 'none';
    document.getElementById('qcRemark').value = "";
    currentItem = null; updateDisplay();
    setTimeout(() => { document.getElementById('barcodeCollector').focus(); }, 100);
}

function initScannerInput() {
    const col = document.getElementById('barcodeCollector');
    document.addEventListener('mousedown', (e) => { 
        if (!e.target.closest('.filter-panel') && !e.target.closest('.modal-content') && e.target.tagName !== 'INPUT') { 
            setTimeout(() => col.focus(), 50); 
        }
    });
    col.addEventListener('keypress', (e) => { if (e.key === 'Enter') { handleScannedCode(col.value.trim().toUpperCase()); col.value = ""; } });
    col.focus();
}

function resetFilters() {
    document.getElementById('globalSearch').value = "";
    document.getElementById('filterBuilding').value = "";
    document.getElementById('filterProduction').value = "";
    document.getElementById('filterMonth').value = "";
    document.getElementById('filterYear').value = "";
    updateDisplay();
}

function deleteRow(cloudId) { 
    if(confirm("Remove this entry from Cloud and all devices?")) {
        if(cloudId) db.ref('audit_history/' + cloudId).remove();
    }
}

function clearAllCloudData() {
    const masterPass = "F4IZ"; 
    const inputPass = prompt("Enter ADMIN PASSWORD to wipe Cloud Database:");
    if (inputPass === masterPass) {
        const confirmDelete = prompt("WARNING: This wipes ALL data for ALL users. Type 'YES' to execute:");
        if (confirmDelete === "YES") {
            db.ref('audit_history').remove();
            db.ref('master_list').remove();
            localStorage.clear();
            alert("Database Wiped. App reloading.");
            location.reload();
        } else { alert("Incorrect confirmation text. Action aborted."); }
    } else { alert("Unauthorized! Invalid Admin Password."); }
}

function exportToExcel() {
    if (!rawMasterRows.length) return alert("Load Master first");
    const now = new Date();
    const timestamp = now.toISOString().split('T')[0] + "_" + now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
    const dataRows = rawMasterRows.map((r, idx) => {
        if (idx === 0) return [...r, "Status", "Time", "Auditor", "Loc_Audit", "Due_Audit", "MSA_Audit", "Remark"];
        const s = scanHistory.find(h => h.barcode === r[0].toUpperCase());
        return s ? [...r, "SCANNED", s.time, s.pic, s.locRes, s.dueRes, s.msaRes, s.remark] : [...r, "PENDING", "", "", "", "", "", ""];
    });
    const ws = XLSX.utils.aoa_to_sheet(dataRows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Audit Report");
    XLSX.writeFile(wb, `Full_Audit_${timestamp}.xlsx`);
}

function exportFilteredOnly() {
    const bf = document.getElementById('filterBuilding').value;
    const pf = document.getElementById('filterProduction').value;
    const mf = document.getElementById('filterMonth').value;
    const yf = document.getElementById('filterYear').value;
    if (!rawMasterRows.length) return alert("Load Master first");
    const now = new Date();
    const timestamp = now.toISOString().split('T')[0] + "_" + now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
    let dataRows = [[...rawMasterRows[0], "Status", "Time", "Auditor", "Loc_Audit", "Due_Audit", "MSA_Audit", "Remark"]];
    rawMasterRows.slice(1).forEach(r => {
        const item = masterDB[r[0].toUpperCase()];
        if (item && (!bf || item.bldg === bf) && (!pf || item.prod === pf) && (!mf || item.month === mf) && (!yf || item.year === yf)) {
            const s = scanHistory.find(h => h.barcode === r[0].toUpperCase());
            dataRows.push(s ? [...r, "SCANNED", s.time, s.pic, s.locRes, s.dueRes, s.msaRes, s.remark] : [...r, "PENDING", "", "", "", "", "", ""]);
        }
    });
    const ws = XLSX.utils.aoa_to_sheet(dataRows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Filtered Audit");
    const filterName = (bf || pf) ? `${bf}_${pf}` : "Filtered";
    XLSX.writeFile(wb, `${filterName}_Audit_${timestamp}.xlsx`);
}

async function toggleCamera() {
    const r = document.getElementById('reader');
    if (!html5QrCode) {
        r.style.display = "block";
        html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start({ facingMode: "environment" }, { fps: 15, qrbox: 250 }, (text) => {
            html5QrCode.stop().then(() => { html5QrCode = null; r.style.display = "none"; handleScannedCode(text.toUpperCase()); });
        });
    } else { html5QrCode.stop().then(() => { html5QrCode = null; r.style.display = "none"; }); }

}
