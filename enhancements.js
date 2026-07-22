/*
 * GRID Calibration Inventory System - V2.2 experience layer
 *
 * This file intentionally keeps the existing Firebase Realtime Database paths
 * and record shape used by script.js. It upgrades the scanning workflow,
 * verification UI, import validation, reporting, responsiveness, and feedback.
 */

let v2QuickView = "all";
let v2AuditLimit = 200;
let v2SearchTimer = null;
let v2GaugeAnimationFrame = null;
let v2CameraStarting = false;
let v2CameraPaused = false;
let v2ResumeCameraAfterModal = false;
let v2TorchOn = false;
let v2LastDecodeText = "";
let v2LastDecodeTime = 0;
let v2ProcessingCode = false;
let v2CurrentScanSource = "hardware";
let v2DueSuggestion = null;
let v2RemarkSuggestion = "";
let v2PendingMasterImport = null;
let v2SyncInProgress = false;
let v2IsSubmitting = false;
let v2ScannerInputInitialized = false;
let v2AudioContext = null;

function v2El(id) {
    return document.getElementById(id);
}

function v2SetText(id, value) {
    const element = v2El(id);
    if (element) element.textContent = String(value ?? "");
}

function v2SafeActionValue(value) {
    return encodeActionValue(value).replace(/'/g, "%27");
}

function v2FormatClock(date = new Date()) {
    return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function v2TimestampForFilename(date = new Date()) {
    const pad = value => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join("") + "_" + [pad(date.getHours()), pad(date.getMinutes())].join("");
}

function v2Slug(value) {
    return String(value || "all")
        .trim()
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "all";
}

function showToast(message, type = "info", duration = 3600) {
    const region = v2El("toastRegion");
    if (!region) return;

    const iconMap = {
        success: "OK",
        error: "!",
        warning: "!",
        info: "i"
    };

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${iconMap[type] || "i"}</span>
        <span>${escapeHtml(message)}</span>
    `;

    region.appendChild(toast);

    window.setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(8px)";
        window.setTimeout(() => toast.remove(), 220);
    }, duration);
}

function v2GetAudioContext() {
    if (v2AudioContext) return v2AudioContext;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
        v2AudioContext = new AudioContextClass();
        return v2AudioContext;
    } catch (error) {
        return null;
    }
}

function v2Tone(frequency, duration = 0.09, startDelay = 0, volume = 0.045) {
    const context = v2GetAudioContext();
    if (!context) return;

    try {
        if (context.state === "suspended") {
            context.resume().catch(() => {});
        }

        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startAt = context.currentTime + startDelay;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + duration + 0.02);
    } catch (error) {
        // Audio feedback is optional and must not interrupt scanning.
    }
}

function v2Feedback(kind) {
    if (kind === "pass") {
        v2Tone(720, 0.08, 0);
        v2Tone(980, 0.1, 0.09);
        navigator.vibrate?.(60);
        return;
    }

    if (kind === "fail") {
        v2Tone(260, 0.14, 0);
        v2Tone(190, 0.18, 0.13);
        navigator.vibrate?.([90, 60, 120]);
        return;
    }

    if (kind === "duplicate") {
        v2Tone(430, 0.08, 0);
        v2Tone(430, 0.08, 0.11);
        navigator.vibrate?.([50, 45, 50]);
        return;
    }

    v2Tone(520, 0.08, 0);
    navigator.vibrate?.(35);
}

function v2SetScannerStatus(text, state = "ready") {
    v2SetText("scannerStatusText", text);

    const dot = v2El("scannerStateDot");
    if (dot) {
        dot.className = `scanner-state-dot ${state}`;
    }
}

function v2SetLastScan(code, result) {
    v2SetText("lastScanCode", code || "None");
    v2SetText("lastScanResult", result || "Waiting");
}

function v2UpdatePendingBadge() {
    v2SetText("pendingSyncBadge", `${pendingUploads.length} pending`);
}

function v2UpdateConnectionUI() {
    const dot = v2El("syncStatus");
    const label = v2El("syncStatusText");

    if (dot) {
        dot.style.background = "";
        dot.style.boxShadow = "";
        dot.className = `connection-dot ${isOnline ? "online" : "offline"}`;
    }

    if (label) {
        label.textContent = isOnline ? "Cloud connected" : "Offline mode";
    }

    v2UpdatePendingBadge();
}

function v2FilterHasStructuredSelection(filters) {
    return Boolean(
        (filters.buildings || []).length ||
        (filters.productions || []).length ||
        (filters.months || []).length ||
        (filters.years || []).length ||
        (filters.statuses || []).length
    );
}

function v2IsModalOpen() {
    return Boolean(v2El("qcModal")?.classList.contains("is-open"));
}

function v2IsImportModalOpen() {
    return Boolean(v2El("importModal")?.classList.contains("is-open"));
}

function v2FocusScannerCollector() {
    if (v2IsModalOpen() || v2IsImportModalOpen()) return;
    window.setTimeout(() => v2El("barcodeCollector")?.focus(), 60);
}

/* -------------------------------------------------------------------------- */
/* Connection and offline queue                                                */
/* -------------------------------------------------------------------------- */

async function processOfflineQueue() {
    if (v2SyncInProgress || !isOnline || pendingUploads.length === 0) {
        v2UpdatePendingBadge();
        return;
    }

    v2SyncInProgress = true;

    const progressContainer = v2El("syncProgressContainer");
    const progressBar = v2El("syncProgressBar");
    const queue = [...pendingUploads];
    const remaining = [];
    let syncedCount = 0;
    let duplicateCount = 0;

    if (progressContainer) {
        progressContainer.hidden = false;
        progressContainer.style.display = "block";
    }

    try {
        const historyRef = db.ref("audit_history");

        for (let index = 0; index < queue.length; index += 1) {
            const data = queue[index];

            try {
                const snapshot = await historyRef
                    .orderByChild("barcode")
                    .equalTo(data.barcode)
                    .once("value");

                if (snapshot.exists()) {
                    duplicateCount += 1;
                } else {
                    const newRef = historyRef.push();
                    data.cloudId = newRef.key;
                    await newRef.set(data);
                    syncedCount += 1;
                }
            } catch (error) {
                remaining.push(data);
            }

            if (progressBar) {
                progressBar.style.width = `${Math.round(((index + 1) / queue.length) * 100)}%`;
            }
        }

        pendingUploads = remaining;

        if (remaining.length > 0) {
            localStorage.setItem("pending_queue", JSON.stringify(remaining));
        } else {
            localStorage.removeItem("pending_queue");
        }

        v2SetText("lastSyncTime", v2FormatClock());
        v2UpdatePendingBadge();
        updateDisplay();

        if (syncedCount > 0) {
            showToast(`${syncedCount} offline record${syncedCount === 1 ? "" : "s"} synchronized.`, "success");
        }

        if (duplicateCount > 0) {
            showToast(`${duplicateCount} queued duplicate${duplicateCount === 1 ? " was" : "s were"} skipped.`, "warning");
        }

        if (remaining.length > 0) {
            showToast(`${remaining.length} record${remaining.length === 1 ? "" : "s"} could not be synchronized yet.`, "warning");
        }
    } finally {
        window.setTimeout(() => {
            if (progressContainer) {
                progressContainer.hidden = true;
                progressContainer.style.display = "none";
            }
            if (progressBar) progressBar.style.width = "0%";
        }, 700);

        v2SyncInProgress = false;
    }
}

/* -------------------------------------------------------------------------- */
/* Login and scanner input                                                     */
/* -------------------------------------------------------------------------- */

function checkLogin() {
    const usernameElement = v2El("username");
    const passwordElement = v2El("password");
    const username = usernameElement?.value.trim() || "";
    const password = passwordElement?.value || "";

    if (!username || password !== AUTH_PASS) {
        showToast("Invalid name or password.", "error");
        v2Feedback("fail");
        passwordElement?.focus();
        return;
    }

    loggedInUser = username;
    localStorage.setItem("grid_last_user", username);

    v2SetText("userDisp", username);

    const overlay = v2El("loginOverlay");
    const main = v2El("mainApp");

    if (overlay) overlay.style.display = "none";
    if (main) {
        main.hidden = false;
        main.style.display = "block";
    }

    initScannerInput();
    v2SetScannerStatus("Scanner ready", "ready");
    updateDisplay();
    v2FocusScannerCollector();
    v2Feedback("pass");
    showToast(`Welcome, ${username}. Scanner input is ready.`, "success");
}

function initScannerInput() {
    if (v2ScannerInputInitialized) {
        v2FocusScannerCollector();
        return;
    }

    const collector = v2El("barcodeCollector");
    if (!collector) return;

    v2ScannerInputInitialized = true;

    document.addEventListener("pointerdown", event => {
        const target = event.target;
        const interactive = target?.closest?.("input, select, button, a, textarea, [contenteditable='true']");

        if (!v2IsModalOpen() && !v2IsImportModalOpen() && !interactive) {
            v2FocusScannerCollector();
        }
    });

    collector.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;

        event.preventDefault();
        const code = collector.value.trim();
        collector.value = "";

        if (code) {
            v2CurrentScanSource = "hardware";
            handleScannedCode(code);
        }
    });

    collector.focus();
}

function submitManualEntry() {
    const input = v2El("manualBarcode");
    const barcode = input?.value.trim() || "";

    if (!barcode) {
        showToast("Enter a barcode before processing.", "warning");
        input?.focus();
        return;
    }

    v2CurrentScanSource = "manual";
    input.value = "";
    handleScannedCode(barcode);
}

/* -------------------------------------------------------------------------- */
/* Checkbox multi-select filters and quick views                               */
/* -------------------------------------------------------------------------- */

const V2_MULTI_FILTER_IDS = [
    "filterBuilding",
    "filterProduction",
    "filterMonth",
    "filterYear",
    "filterStatus"
];

const V2_MULTI_FILTER_DEFAULTS = {
    filterBuilding: "All Buildings",
    filterProduction: "All Production",
    filterMonth: "All Months",
    filterYear: "All Years",
    filterStatus: "All Statuses"
};

function v2GetFilterValues(elementId) {
    const select = v2El(elementId);
    if (!select) return [];

    return Array.from(select.options)
        .filter(option => option.selected && option.value !== "")
        .map(option => option.value);
}

function getSelectedFilterState() {
    const buildings = v2GetFilterValues("filterBuilding");
    const productions = v2GetFilterValues("filterProduction");
    const months = v2GetFilterValues("filterMonth");
    const years = v2GetFilterValues("filterYear");
    const statuses = v2GetFilterValues("filterStatus");

    return {
        buildings,
        productions,
        months,
        years,
        statuses,
        // Scalar aliases retain compatibility with older helper functions.
        building: buildings.length === 1 ? buildings[0] : "",
        month: months.length === 1 ? months[0] : "",
        year: years.length === 1 ? years[0] : ""
    };
}

function v2GetMultiFilterParts(elementId) {
    return {
        select: v2El(elementId),
        widget: v2El(`${elementId}Widget`),
        trigger: v2El(`${elementId}Trigger`),
        summary: v2El(`${elementId}Summary`),
        count: v2El(`${elementId}Count`),
        menu: v2El(`${elementId}Menu`),
        search: v2El(`${elementId}OptionSearch`),
        options: v2El(`${elementId}Options`),
        empty: v2El(`${elementId}Empty`)
    };
}

function v2UpdateMultiFilterSummary(elementId) {
    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.select || !parts.summary || !parts.trigger) return;

    const selectedValues = v2GetFilterValues(elementId);
    const totalOptions = parts.select.options.length;
    const defaultText = parts.widget?.dataset.defaultLabel ||
        V2_MULTI_FILTER_DEFAULTS[elementId] || "All";

    let summaryText = defaultText;

    if (selectedValues.length === 1) {
        summaryText = selectedValues[0];
    } else if (selectedValues.length > 1) {
        summaryText = selectedValues.length === totalOptions && totalOptions > 0
            ? `All selected`
            : `${selectedValues[0]} +${selectedValues.length - 1}`;
    }

    parts.summary.textContent = summaryText;
    parts.trigger.title = selectedValues.length
        ? selectedValues.join(", ")
        : defaultText;
    parts.trigger.classList.toggle("has-selection", selectedValues.length > 0);

    if (parts.count) {
        parts.count.hidden = selectedValues.length === 0;
        parts.count.textContent = String(selectedValues.length);
    }
}

function filterMultiFilterOptions(elementId, query = "") {
    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.options) return;

    const normalizedQuery = String(query || "").trim().toUpperCase();
    let visibleCount = 0;

    parts.options.querySelectorAll(".multi-select-option").forEach(optionRow => {
        const matches = !normalizedQuery ||
            String(optionRow.dataset.searchText || "").includes(normalizedQuery);
        optionRow.hidden = !matches;
        if (matches) visibleCount += 1;
    });

    if (parts.empty) {
        parts.empty.hidden = visibleCount !== 0;
    }
}

function v2HandleMultiFilterChange(elementId) {
    v2AuditLimit = 200;
    v2UpdateMultiFilterSummary(elementId);

    if (elementId === "filterBuilding") {
        const selectedProductions = v2GetFilterValues("filterProduction");
        rebuildProductionFilter(selectedProductions);
    }

    updateDisplay();
}

function v2RenderMultiFilterOptions(elementId) {
    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.select || !parts.options) return;

    parts.options.innerHTML = "";

    Array.from(parts.select.options).forEach((option, index) => {
        const optionRow = document.createElement("label");
        optionRow.className = "multi-select-option";
        optionRow.dataset.value = option.value;
        optionRow.dataset.searchText = String(option.textContent || option.value).toUpperCase();

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = option.selected;
        checkbox.value = option.value;
        checkbox.id = `${elementId}Checkbox${index}`;

        const checkmark = document.createElement("span");
        checkmark.className = "multi-select-checkmark";
        checkmark.setAttribute("aria-hidden", "true");

        const text = document.createElement("span");
        text.className = "multi-select-option-text";
        text.textContent = option.textContent || option.value;

        checkbox.addEventListener("change", () => {
            option.selected = checkbox.checked;
            v2HandleMultiFilterChange(elementId);
        });

        optionRow.append(checkbox, checkmark, text);
        parts.options.appendChild(optionRow);
    });

    if (parts.trigger) {
        parts.trigger.disabled = parts.select.options.length === 0;
    }

    v2UpdateMultiFilterSummary(elementId);
    filterMultiFilterOptions(elementId, parts.search?.value || "");
}

function setMultiSelectOptions(selectElement, values, selectedValues = []) {
    if (!selectElement) return;

    const normalizedValues = Array.from(new Set(
        values
            .map(value => String(value ?? "").trim())
            .filter(Boolean)
    ));
    const selectedSet = new Set(
        selectedValues
            .map(value => String(value ?? "").trim())
            .filter(value => normalizedValues.includes(value))
    );

    selectElement.multiple = true;
    selectElement.innerHTML = "";

    normalizedValues.forEach(value => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = selectedSet.has(value);
        selectElement.appendChild(option);
    });

    v2RenderMultiFilterOptions(selectElement.id);
}

function v2CloseMultiFilter(elementId) {
    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.menu || !parts.trigger || !parts.widget) return;

    parts.menu.hidden = true;
    parts.trigger.setAttribute("aria-expanded", "false");
    parts.widget.classList.remove("open");
}

function closeAllMultiFilters(exceptId = "") {
    V2_MULTI_FILTER_IDS.forEach(elementId => {
        if (elementId !== exceptId) v2CloseMultiFilter(elementId);
    });
}

function v2PositionMultiFilterMenu(elementId) {
    if (window.innerWidth <= 720) return;

    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.menu) return;

    parts.menu.style.left = "";
    parts.menu.style.right = "";

    const rect = parts.menu.getBoundingClientRect();

    if (rect.right > window.innerWidth - 12) {
        parts.menu.style.left = "auto";
        parts.menu.style.right = "0";
    } else if (rect.left < 12) {
        parts.menu.style.left = "0";
        parts.menu.style.right = "auto";
    }
}

function toggleMultiFilter(elementId, forceOpen = null) {
    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.menu || !parts.trigger || !parts.widget || parts.trigger.disabled) return;

    const shouldOpen = forceOpen === null ? parts.menu.hidden : Boolean(forceOpen);

    if (!shouldOpen) {
        v2CloseMultiFilter(elementId);
        return;
    }

    closeAllMultiFilters(elementId);
    parts.menu.hidden = false;
    parts.trigger.setAttribute("aria-expanded", "true");
    parts.widget.classList.add("open");

    window.requestAnimationFrame(() => {
        v2PositionMultiFilterMenu(elementId);
        parts.search?.focus();
        parts.search?.select();
    });
}

function selectAllMultiFilter(elementId) {
    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.select || !parts.options) return;

    const visibleValues = new Set(
        Array.from(parts.options.querySelectorAll(".multi-select-option:not([hidden])"))
            .map(row => row.dataset.value)
    );

    Array.from(parts.select.options).forEach(option => {
        if (visibleValues.has(option.value)) option.selected = true;
    });

    v2RenderMultiFilterOptions(elementId);
    v2HandleMultiFilterChange(elementId);
}

function clearMultiFilter(elementId) {
    const parts = v2GetMultiFilterParts(elementId);
    if (!parts.select) return;

    Array.from(parts.select.options).forEach(option => {
        option.selected = false;
    });

    v2RenderMultiFilterOptions(elementId);
    v2HandleMultiFilterChange(elementId);
}

function getAvailableProductionsForBuilding(buildingSelection = null) {
    const selectedBuildings = Array.isArray(buildingSelection)
        ? buildingSelection
        : buildingSelection
            ? [buildingSelection]
            : v2GetFilterValues("filterBuilding");
    const buildingSet = new Set(selectedBuildings);
    const productionSet = new Set();

    Object.values(masterDB).forEach(item => {
        if (!item || !item.prod || item.prod === "N/A") return;

        if (buildingSet.size === 0 || buildingSet.has(item.bldg)) {
            productionSet.add(item.prod);
        }
    });

    return Array.from(productionSet).sort((a, b) => a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base"
    }));
}

function rebuildProductionFilter(selectedProductions = []) {
    const availableProductions = getAvailableProductionsForBuilding();
    const validSelections = selectedProductions.filter(value => availableProductions.includes(value));

    setMultiSelectOptions(
        v2El("filterProduction"),
        availableProductions,
        validSelections
    );
}

function onBuildingFilterChange() {
    const selectedProductions = v2GetFilterValues("filterProduction");
    rebuildProductionFilter(selectedProductions);
    v2AuditLimit = 200;
    updateDisplay();
}

function rebuildFilters() {
    const current = getSelectedFilterState();
    const buildingSet = new Set();
    const monthSet = new Set();
    const yearSet = new Set();
    const statusSet = new Set();

    Object.values(masterDB).forEach(item => {
        if (!item) return;
        if (item.bldg && item.bldg !== "N/A") buildingSet.add(item.bldg);
        if (item.month && item.month !== "N/A") monthSet.add(item.month);
        if (item.year && item.year !== "N/A") yearSet.add(item.year);
        if (item.status && item.status !== "N/A") statusSet.add(item.status);
    });

    const buildings = Array.from(buildingSet).sort((a, b) => a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base"
    }));
    const months = Array.from(monthSet).sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));
    const years = Array.from(yearSet).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const statuses = Array.from(statusSet).sort((a, b) => a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base"
    }));

    setMultiSelectOptions(
        v2El("filterBuilding"),
        buildings,
        current.buildings.filter(value => buildings.includes(value))
    );
    setMultiSelectOptions(
        v2El("filterMonth"),
        months,
        current.months.filter(value => months.includes(value))
    );
    setMultiSelectOptions(
        v2El("filterYear"),
        years,
        current.years.filter(value => years.includes(value))
    );
    setMultiSelectOptions(
        v2El("filterStatus"),
        statuses,
        current.statuses.filter(value => statuses.includes(value))
    );
    rebuildProductionFilter(current.productions);
}

function itemMatchesFilters(item, filters) {
    if (!item) return false;

    const buildings = filters.buildings || (filters.building ? [filters.building] : []);
    const productions = filters.productions || [];
    const months = filters.months || (filters.month ? [filters.month] : []);
    const years = filters.years || (filters.year ? [filters.year] : []);
    const statuses = filters.statuses || [];

    return (buildings.length === 0 || buildings.includes(item.bldg)) &&
        (productions.length === 0 || productions.includes(item.prod)) &&
        (months.length === 0 || months.includes(item.month)) &&
        (years.length === 0 || years.includes(item.year)) &&
        (statuses.length === 0 || statuses.includes(item.status));
}

function setQuickView(view) {
    const allowed = new Set(["all", "abnormal", "passed", "mine", "unregistered", "pending"]);
    v2QuickView = allowed.has(view) ? view : "all";
    v2AuditLimit = 200;

    document.querySelectorAll(".quick-filter").forEach(button => {
        button.classList.toggle("active", button.dataset.view === v2QuickView);
    });

    updateDisplay();

    const targetId = v2QuickView === "pending" ? "pendingSection" : "auditLogsSection";
    v2El(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function loadMoreAuditRows() {
    v2AuditLimit += 200;
    updateDisplay();
}

function resetFilters() {
    const search = v2El("globalSearch");
    if (search) search.value = "";

    V2_MULTI_FILTER_IDS.forEach(elementId => {
        const parts = v2GetMultiFilterParts(elementId);

        if (parts.select) {
            Array.from(parts.select.options).forEach(option => {
                option.selected = false;
            });
        }

        if (parts.search) parts.search.value = "";
        v2CloseMultiFilter(elementId);
    });

    // Clearing buildings restores the full production option list.
    rebuildProductionFilter([]);

    V2_MULTI_FILTER_IDS.forEach(elementId => {
        v2RenderMultiFilterOptions(elementId);
    });

    v2QuickView = "all";
    v2AuditLimit = 200;

    document.querySelectorAll(".quick-filter").forEach(button => {
        button.classList.toggle("active", button.dataset.view === "all");
    });

    updateDisplay();
    showToast("All filters cleared.", "info", 2200);
}

function v2MatchesSearch(auditRecord, masterItem, search) {
    if (!search) return true;

    const values = [
        auditRecord?.barcode,
        auditRecord?.name,
        auditRecord?.pic,
        auditRecord?.remark,
        auditRecord?.locRes,
        auditRecord?.stickerLocRes,
        auditRecord?.dueRes,
        auditRecord?.msaRes,
        auditRecord?.updatedLocation,
        auditRecord?.updatedDue,
        auditRecord?.updatedStatus,
        masterItem?.name,
        masterItem?.loc,
        masterItem?.bldg,
        masterItem?.prod,
        masterItem?.due,
        masterItem?.status,
        masterItem?.msa
    ];

    return values.some(value => String(value || "").toUpperCase().includes(search));
}

function v2MatchesMasterSearch(code, item, search) {
    if (!search) return true;

    return [
        code,
        item?.name,
        item?.loc,
        item?.bldg,
        item?.prod,
        item?.due,
        item?.status,
        item?.msa
    ].some(value => String(value || "").toUpperCase().includes(search));
}

function v2MsaRequired(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return ["YES", "Y", "REQUIRED", "TRUE", "1"].includes(normalized);
}

function v2AuditPassesMsa(record, masterItem) {
    if (!v2MsaRequired(masterItem?.msa)) return true;
    return record?.msaRes === "YES";
}

function v2Pill(value, passValues = [], neutralValues = []) {
    const normalized = String(value || "N/A");
    const cssClass = passValues.includes(normalized)
        ? "pill-pass"
        : neutralValues.includes(normalized)
            ? "pill-neutral"
            : "pill-fail";

    return `<span class="status-pill ${cssClass}">${escapeHtml(normalized)}</span>`;
}

function updateDisplay() {
    const search = (v2El("globalSearch")?.value || "").trim().toUpperCase();
    const filters = getSelectedFilterState();
    const allCodes = Object.keys(masterDB);

    const filteredTargetList = allCodes.filter(code => {
        const item = masterDB[code];
        return itemMatchesFilters(item, filters) && v2MatchesMasterSearch(code, item, search);
    });

    const includeUnregistered = !v2FilterHasStructuredSelection(filters);

    const filteredAuditResults = scanHistory.filter(record => {
        const code = String(record.barcode || "").toUpperCase();
        const masterItem = masterDB[code];

        if (masterItem) {
            return itemMatchesFilters(masterItem, filters) && v2MatchesSearch(record, masterItem, search);
        }

        return includeUnregistered && v2MatchesSearch(record, null, search);
    });

    const targetCodeSet = new Set(filteredTargetList);
    const scannedCodesInTarget = new Set();

    filteredAuditResults.forEach(record => {
        const code = String(record.barcode || "").toUpperCase();
        if (targetCodeSet.has(code)) scannedCodesInTarget.add(code);
    });

    const scannedInTarget = scannedCodesInTarget.size;
    const completion = filteredTargetList.length > 0
        ? Math.min(100, Math.round((scannedInTarget / filteredTargetList.length) * 100))
        : 0;

    v2SetText("progressSubLabel", `Scanned: ${scannedInTarget} / ${filteredTargetList.length}`);
    drawGauge(completion);

    const failedItems = filteredAuditResults.filter(record => record.isFail);
    const passedItems = filteredAuditResults.filter(record => !record.isFail);
    const unregisteredItems = filteredAuditResults.filter(record => {
        return !masterDB[String(record.barcode || "").toUpperCase()];
    });

    updateFailureChart(failedItems);

    v2SetText("totalScans", filteredAuditResults.length);
    v2SetText("totalPassed", passedItems.length);
    v2SetText("totalFails", failedItems.length);
    v2SetText("totalNotScanned", Math.max(filteredTargetList.length - scannedInTarget, 0));
    v2SetText("totalUnregistered", unregisteredItems.length);
    v2UpdatePendingBadge();

    let visibleAuditResults = filteredAuditResults;

    if (v2QuickView === "abnormal") {
        visibleAuditResults = visibleAuditResults.filter(record => record.isFail);
    } else if (v2QuickView === "passed") {
        visibleAuditResults = visibleAuditResults.filter(record => !record.isFail);
    } else if (v2QuickView === "mine") {
        visibleAuditResults = visibleAuditResults.filter(record => record.pic === loggedInUser);
    } else if (v2QuickView === "unregistered") {
        visibleAuditResults = visibleAuditResults.filter(record => {
            return !masterDB[String(record.barcode || "").toUpperCase()];
        });
    } else if (v2QuickView === "pending") {
        visibleAuditResults = [];
    }

    const auditBody = v2El("inventoryBody");
    const auditEmptyState = v2El("auditEmptyState");
    const loadMoreButton = v2El("loadMoreAudits");
    const limitedAudits = visibleAuditResults.slice(0, v2AuditLimit);

    v2SetText(
        "auditResultCount",
        visibleAuditResults.length > v2AuditLimit
            ? `Showing ${v2AuditLimit} of ${visibleAuditResults.length}`
            : `${visibleAuditResults.length} record${visibleAuditResults.length === 1 ? "" : "s"}`
    );

    if (auditBody) {
        auditBody.innerHTML = limitedAudits.map(record => {
            const code = String(record.barcode || "").toUpperCase();
            const masterItem = masterDB[code];
            const originalStatus = masterItem?.status || "N/A";
            const rowClass = !masterItem
                ? "row-unregistered"
                : record.isFail
                    ? "row-fail"
                    : "";
            const key = v2SafeActionValue(record.cloudId || record.id || record.barcode || "");
            const msaPassValues = v2AuditPassesMsa(record, masterItem) ? [record.msaRes] : [];
            const msaNeutralValues = record.msaRes === "N/A" ? ["N/A"] : [];

            return `<tr class="${rowClass}">
                <td data-label="Time">${escapeHtml(record.time || "-")}</td>
                <td data-label="Code"><strong>${escapeHtml(record.barcode || "-")}</strong></td>
                <td data-label="Name">${escapeHtml(record.name || masterItem?.name || "-")}</td>
                <td data-label="PIC"><span style="color:var(--primary);font-weight:800">${escapeHtml(record.pic || "-")}</span></td>
                <td data-label="Physical Location">${v2Pill(record.locRes, ["CORRECT"])}</td>
                <td data-label="Sticker Location">${v2Pill(record.stickerLocRes || "N/A", ["CORRECT"], ["N/A"])}</td>
                <td data-label="Due">${v2Pill(record.dueRes, ["VALID"], ["N/A"])}</td>
                <td data-label="Status">${escapeHtml(originalStatus)}</td>
                <td data-label="MSA">${v2Pill(record.msaRes, msaPassValues, msaNeutralValues)}</td>
                <td data-label="Remark">${escapeHtml(record.remark || "-")}</td>
                <td data-label="Action">
                    <div class="row-action-group">
                        <button class="btn-detail-row" onclick="openAuditDetail('${key}')">Detail</button>
                        <button class="btn-delete-row" onclick="deleteRow('${key}')">Delete</button>
                    </div>
                </td>
            </tr>`;
        }).join("");
    }

    if (auditEmptyState) auditEmptyState.hidden = limitedAudits.length > 0;
    if (loadMoreButton) loadMoreButton.hidden = visibleAuditResults.length <= v2AuditLimit;

    const scannedIds = new Set(scanHistory.map(record => String(record.barcode || "").toUpperCase()));
    const pendingCodes = filteredTargetList.filter(code => !scannedIds.has(code));
    const pendingBody = v2El("pendingBody");
    const pendingEmptyState = v2El("pendingEmptyState");
    const renderedPendingCodes = pendingCodes.slice(0, 500);

    v2SetText(
        "pendingResultCount",
        pendingCodes.length > 500
            ? `Showing 500 of ${pendingCodes.length}`
            : `${pendingCodes.length} item${pendingCodes.length === 1 ? "" : "s"}`
    );

    if (pendingBody) {
        pendingBody.innerHTML = renderedPendingCodes.map(code => {
            const item = masterDB[code];
            let lock = null;

            try {
                lock = activeLocks[btoa(code).replace(/=/g, "")];
            } catch (error) {
                lock = null;
            }

            const lockedByAnother = lock && lock.user !== loggedInUser;
            const lockTag = lock
                ? `<span class="lock-tag">Locked by ${escapeHtml(lock.user || "another auditor")}</span>`
                : "";
            const encodedCode = v2SafeActionValue(code);

            return `<tr${lock ? ' style="border-left-color:#795548"' : ""}>
                <td data-label="Code"><strong>${escapeHtml(code)}</strong>${lockTag}</td>
                <td data-label="Name">${escapeHtml(item.name || "-")}</td>
                <td data-label="Location">${escapeHtml(item.loc || "-")}</td>
                <td data-label="Due">${escapeHtml(item.due || "-")}</td>
                <td data-label="Status">${escapeHtml(item.status || "-")}</td>
                <td data-label="MSA">${escapeHtml(item.msa || "-")}</td>
                <td data-label="Action">
                    <button class="btn-pending-row" onclick="startPendingAudit('${encodedCode}')" ${lockedByAnother ? "disabled" : ""}>
                        Verify
                    </button>
                </td>
            </tr>`;
        }).join("");
    }

    if (pendingEmptyState) pendingEmptyState.hidden = renderedPendingCodes.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Gauge and abnormal chart                                                    */
/* -------------------------------------------------------------------------- */

function drawGauge(percent) {
    targetGaugeValue = Math.max(0, Math.min(100, Number(percent) || 0));

    if (!v2GaugeAnimationFrame) {
        v2GaugeAnimationFrame = requestAnimationFrame(animateGauge);
    }
}

function animateGauge() {
    const difference = targetGaugeValue - currentGaugeValue;

    if (Math.abs(difference) < 0.15) {
        currentGaugeValue = targetGaugeValue;
    } else {
        currentGaugeValue += difference * 0.13;
    }

    const canvas = v2El("gaugeCanvas");
    if (canvas) {
        const context = canvas.getContext("2d");
        const size = canvas.width;
        const center = size / 2;
        const radius = center - 11;
        const startAngle = -0.5 * Math.PI;
        const endAngle = (currentGaugeValue / 100) * (2 * Math.PI) + startAngle;
        const gaugeColor = currentGaugeValue >= 90
            ? "#2e7d32"
            : currentGaugeValue >= 50
                ? "#8d6e63"
                : "#f9a825";

        context.clearRect(0, 0, size, size);
        context.beginPath();
        context.arc(center, center, radius, 0, 2 * Math.PI);
        context.strokeStyle = "#efebe9";
        context.lineWidth = 10;
        context.stroke();

        context.beginPath();
        context.arc(center, center, radius, startAngle, endAngle);
        context.strokeStyle = gaugeColor;
        context.lineWidth = 10;
        context.lineCap = "round";
        context.stroke();

        const text = v2El("progressPercent");
        if (text) {
            text.textContent = `${Math.round(currentGaugeValue)}%`;
            text.style.color = gaugeColor;
        }
    }

    if (Math.abs(targetGaugeValue - currentGaugeValue) >= 0.15) {
        v2GaugeAnimationFrame = requestAnimationFrame(animateGauge);
    } else {
        v2GaugeAnimationFrame = null;
    }
}

function updateFailureChart(failedItems) {
    const counts = {
        "Wrong location": 0,
        "Wrong sticker location": 0,
        "Expired due": 0,
        "Unreadable due": 0,
        "Missing MSA": 0,
        "Status updated": 0,
        "Unregistered": 0,
        "Other": 0
    };

    failedItems.forEach(record => {
        const masterItem = masterDB[String(record.barcode || "").toUpperCase()];
        let categorized = false;

        if (record.locRes === "WRONG") {
            counts["Wrong location"] += 1;
            categorized = true;
        }

        if (record.stickerLocRes === "WRONG") {
            counts["Wrong sticker location"] += 1;
            categorized = true;
        }

        if (record.dueRes === "EXPIRED") {
            counts["Expired due"] += 1;
            categorized = true;
        }

        if (record.dueRes === "UNREADABLE") {
            counts["Unreadable due"] += 1;
            categorized = true;
        }

        if (v2MsaRequired(masterItem?.msa) && record.msaRes !== "YES") {
            counts["Missing MSA"] += 1;
            categorized = true;
        }

        if (record.masterStatusUpdated) {
            counts["Status updated"] += 1;
            categorized = true;
        }

        if (!masterItem || record.isUnregistered) {
            counts["Unregistered"] += 1;
            categorized = true;
        }

        if (!categorized) counts.Other += 1;
    });

    const labels = Object.keys(counts).filter(label => counts[label] > 0);
    const data = labels.map(label => counts[label]);
    const colors = ["#d32f2f", "#c62828", "#f57c00", "#f9a825", "#7b1fa2", "#5d4037", "#1565c0", "#795548"];
    const canvas = v2El("failureChart");
    const legend = v2El("failureLegend");

    if (!canvas) return;

    if (labels.length === 0) {
        if (failureChartInstance) {
            failureChartInstance.destroy();
            failureChartInstance = null;
        }
        canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        if (legend) legend.textContent = "No failures detected.";
        return;
    }

    const chartData = {
        labels,
        datasets: [{
            label: "Issues",
            data,
            backgroundColor: colors.slice(0, labels.length),
            borderWidth: 0,
            borderRadius: 6,
            barThickness: 15
        }]
    };

    if (failureChartInstance) {
        failureChartInstance.data = chartData;
        failureChartInstance.update("none");
    } else {
        failureChartInstance = new Chart(canvas.getContext("2d"), {
            type: "bar",
            data: chartData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { displayColors: false }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: { precision: 0 },
                        grid: { color: "rgba(121,85,72,0.08)" }
                    },
                    y: {
                        ticks: { font: { size: 10 } },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    if (legend) {
        legend.innerHTML = labels.map((label, index) => `
            <div class="failure-legend-row">
                <span class="failure-legend-label">
                    <span class="legend-dot" style="background:${colors[index]}"></span>
                    ${escapeHtml(label)}
                </span>
                <strong>${data[index]}</strong>
            </div>
        `).join("");
    }
}

/* -------------------------------------------------------------------------- */
/* Verification workflow                                                       */
/* -------------------------------------------------------------------------- */

function v2DueStatusSuggestion(dueValue) {
    const normalized = String(dueValue || "").trim().toUpperCase();
    const match = normalized.match(/^([A-Z]{3})-(\d{2}|\d{4})$/);

    if (!match || !MONTH_ORDER.includes(match[1])) return null;

    const monthIndex = MONTH_ORDER.indexOf(match[1]);
    const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
    const endOfDueMonth = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);

    if (Number.isNaN(endOfDueMonth.getTime())) return null;

    return new Date() <= endOfDueMonth ? "VALID" : "EXPIRED";
}

function v2ClearToggleClasses() {
    [
        "btnLocCorrect", "btnLocWrong",
        "btnStickerLocCorrect", "btnStickerLocWrong",
        "btnDueValid", "btnDueExpired", "btnDueUnreadable",
        "btnMsaYes", "btnMsaNo", "btnMsaNa"
    ].forEach(id => {
        const button = v2El(id);
        if (button) button.className = "option-btn";
    });
}

function v2ApplyToggleClasses() {
    v2ClearToggleClasses();

    if (selectedLoc === "CORRECT") v2El("btnLocCorrect")?.classList.add("active-pass");
    if (selectedLoc === "WRONG") v2El("btnLocWrong")?.classList.add("active-fail");

    if (selectedStickerLoc === "CORRECT") v2El("btnStickerLocCorrect")?.classList.add("active-pass");
    if (selectedStickerLoc === "WRONG") v2El("btnStickerLocWrong")?.classList.add("active-fail");

    if (selectedDue === "VALID") v2El("btnDueValid")?.classList.add("active-pass");
    if (selectedDue === "EXPIRED") v2El("btnDueExpired")?.classList.add("active-fail");
    if (selectedDue === "UNREADABLE") v2El("btnDueUnreadable")?.classList.add("active-fail");

    if (selectedMsa === "YES") v2El("btnMsaYes")?.classList.add("active-pass");
    if (selectedMsa === "NO") v2El("btnMsaNo")?.classList.add("active-fail");
    if (selectedMsa === "N/A") v2El("btnMsaNa")?.classList.add("active-neutral");
}

function setToggle(type, value) {
    if (type === "Loc") selectedLoc = value;
    if (type === "StickerLoc") selectedStickerLoc = value;
    if (type === "Due") selectedDue = value;
    if (type === "Msa") selectedMsa = value;

    v2ApplyToggleClasses();
    updateVerificationState();
}

function v2BuildRemarkSuggestion() {
    if (!currentItem) return "";

    const suggestions = [];

    if (currentItem.isUnregistered) suggestions.push("Equipment not registered");
    if (selectedLoc === "WRONG") suggestions.push("Location not match");
    if (selectedStickerLoc === "WRONG") suggestions.push("Location on sticker not match");
    if (selectedDue === "EXPIRED") suggestions.push("Wrong due date");
    if (selectedDue === "UNREADABLE") suggestions.push("Missing due date sticker");
    if (v2MsaRequired(currentItem.msa) && selectedMsa !== "YES") suggestions.push("MSA sticker missing");

    return suggestions.join("; ");
}

function updateVerificationState() {
    const checks = [selectedLoc, selectedStickerLoc, selectedDue, selectedMsa];
    const completed = checks.filter(Boolean).length;
    const isComplete = completed === checks.length;
    const progress = v2El("verificationProgress");
    const saveButton = v2El("btnSubmitQC");
    const editMode = Boolean(currentAuditEditRecord);

    if (progress) {
        progress.classList.toggle("complete", isComplete);
        progress.textContent = isComplete
            ? "All verification checks are complete."
            : `${completed} of 4 verification checks completed.`;
    }

    if (saveButton) {
        saveButton.disabled = !isComplete || v2IsSubmitting;
        saveButton.textContent = v2IsSubmitting
            ? "Saving..."
            : isComplete
                ? (editMode ? "Update audit record" : "Save audit record")
                : "Complete verification";
    }

    v2RemarkSuggestion = v2BuildRemarkSuggestion();

    const suggestionBox = v2El("remarkSuggestion");
    const suggestionText = v2El("remarkSuggestionText");
    const currentRemark = v2El("qcRemark")?.value.trim() || "";

    if (suggestionBox && suggestionText) {
        const shouldShow = Boolean(v2RemarkSuggestion) && currentRemark !== v2RemarkSuggestion;
        suggestionBox.hidden = !shouldShow;
        suggestionText.textContent = v2RemarkSuggestion
            ? `Suggested remark: ${v2RemarkSuggestion}`
            : "";
    }
}

function clearRemark() {
    const input = v2El("qcRemark");
    if (input) input.value = "";
    updateVerificationState();
}

function applyRemarkSuggestion() {
    const input = v2El("qcRemark");
    if (input && v2RemarkSuggestion) {
        input.value = v2RemarkSuggestion;
        updateVerificationState();
    }
}

function applyDueSuggestion() {
    if (!v2DueSuggestion) return;
    setToggle("Due", v2DueSuggestion);
}

function setModalMode(isEditMode) {
    v2SetText("qcModalTitle", isEditMode ? "SCANNED ITEM DETAIL" : "VERIFICATION");
}

function renderQCModal(auditRecord = null) {
    const modalDataBox = v2El("modalDataBox");
    const remarkInput = v2El("qcRemark");
    const isEditMode = Boolean(auditRecord);

    if (!currentItem) return;

    setModalMode(isEditMode);

    const safeCode = escapeHtml(currentItem.barcode || "-");
    const safeName = escapeHtml(currentItem.name || "-");
    const safeLocation = escapeHtml(currentItem.loc || "N/A");
    const safeDue = escapeHtml(currentItem.due || "N/A");
    const safeStatus = escapeHtml(currentItem.status || "N/A");
    const safeMsa = escapeHtml(currentItem.msa || "N/A");
    const editDisabled = currentItem.isUnregistered ? "disabled" : "";

    const detailMeta = isEditMode ? `
        <div class="scan-detail-meta">
            <div><span>Scanned time</span><strong>${escapeHtml(auditRecord.time || "-")}</strong></div>
            <div><span>Scanned by</span><strong>${escapeHtml(auditRecord.pic || "-")}</strong></div>
            <div><span>Audit result</span><strong>${auditRecord.isFail ? "FAIL" : "PASS"}</strong></div>
            <div><span>Recorded equipment status</span><strong>${escapeHtml(auditRecord.updatedStatus || currentItem.status || "N/A")}</strong></div>
        </div>
    ` : "";

    if (modalDataBox) {
        modalDataBox.innerHTML = `
            <span class="eyebrow">Scanned content</span>
            <strong class="scan-code">${safeCode}</strong>
            <div class="equipment-name">
                <span>Equipment name</span>
                <strong>${safeName}</strong>
            </div>
            ${detailMeta}
            <div class="registered-data-grid">
                <div>
                    <span>Registered location</span>
                    <div class="master-edit-control">
                        <strong id="qcLocationDisplay" class="master-edit-value">${safeLocation}</strong>
                        <input type="text" id="qcLocationInput" class="master-edit-input" value="${safeLocation}" data-original-value="${safeLocation}"
                            onkeydown="if(event.key === 'Enter'){ toggleMasterFieldEdit('loc'); }" ${editDisabled}>
                        <button type="button" id="btnEditLocation" class="btn-inline-edit" onclick="toggleMasterFieldEdit('loc')" ${editDisabled}>EDIT</button>
                    </div>
                </div>
                <div>
                    <span>Registered due</span>
                    <div class="master-edit-control">
                        <strong id="qcDueDisplay" class="master-edit-value">${safeDue}</strong>
                        <input type="text" id="qcDueInput" class="master-edit-input" value="${safeDue}" data-original-value="${safeDue}"
                            placeholder="APR-27" onkeydown="if(event.key === 'Enter'){ toggleMasterFieldEdit('due'); }" ${editDisabled}>
                        <button type="button" id="btnEditDue" class="btn-inline-edit" onclick="toggleMasterFieldEdit('due')" ${editDisabled}>EDIT</button>
                    </div>
                </div>
                <div>
                    <span>Equipment status</span>
                    <div class="master-edit-control">
                        <strong id="qcStatusDisplay" class="master-edit-value">${safeStatus}</strong>
                        <input type="text" id="qcStatusInput" class="master-edit-input" value="${safeStatus}" data-original-value="${safeStatus}"
                            list="qcStatusSuggestions" maxlength="60" autocapitalize="characters"
                            onkeydown="if(event.key === 'Enter'){ toggleMasterFieldEdit('status'); }" ${editDisabled}>
                        <button type="button" id="btnEditStatus" class="btn-inline-edit" onclick="toggleMasterFieldEdit('status')" ${editDisabled}>EDIT</button>
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
                <div><span>Registered MSA</span><strong>${safeMsa}</strong></div>
            </div>
        `;
    }

    if (remarkInput) {
        const existingRemark = isEditMode ? String(auditRecord.remark || "") : "";
        remarkInput.value = existingRemark === "-" ? "" : existingRemark;
    }

    v2DueSuggestion = v2DueStatusSuggestion(currentItem.due);

    if (isEditMode) {
        selectedLoc = auditRecord.locRes || null;
        selectedStickerLoc = auditRecord.stickerLocRes || null;
        selectedDue = auditRecord.dueRes || null;
        selectedMsa = auditRecord.msaRes || null;
    } else if (currentItem.isUnregistered) {
        selectedLoc = "WRONG";
        selectedStickerLoc = "WRONG";
        selectedDue = "UNREADABLE";
        selectedMsa = "N/A";
    } else {
        selectedLoc = null;
        selectedStickerLoc = null;
        selectedDue = null;
        selectedMsa = v2MsaRequired(currentItem.msa) ? null : "N/A";
    }

    const dueText = v2El("dueSuggestionText");
    const dueButton = v2El("applyDueSuggestionButton");

    if (dueText) {
        dueText.textContent = v2DueSuggestion
            ? `System suggests ${v2DueSuggestion} from ${currentItem.due}.`
            : "No reliable date suggestion is available; inspect the sticker.";
    }

    if (dueButton) {
        dueButton.hidden = !v2DueSuggestion || isEditMode;
        dueButton.textContent = v2DueSuggestion
            ? `Apply ${v2DueSuggestion.toLowerCase()} suggestion`
            : "Apply system suggestion";
    }

    const msaText = v2El("msaRequirementText");
    if (msaText) {
        msaText.textContent = v2MsaRequired(currentItem.msa)
            ? `Registered MSA is ${currentItem.msa}; sticker confirmation is required.`
            : `Registered MSA is ${currentItem.msa || "N/A"}; N/A is preselected.`;
    }

    v2ApplyToggleClasses();
    updateVerificationState();

    const modal = v2El("qcModal");
    if (modal) {
        modal.hidden = false;
        modal.style.display = "";
        modal.classList.add("is-open");
        modal.focus();
    }

    v2SetScannerStatus(`Verify ${currentItem.barcode}`, "busy");
}

async function submitQC() {
    if (!currentItem || v2IsSubmitting) return;

    if (!selectedLoc || !selectedStickerLoc || !selectedDue || !selectedMsa) {
        showToast("Complete all four verification checks before saving.", "warning");
        v2Feedback("fail");
        return;
    }

    v2IsSubmitting = true;
    updateVerificationState();

    const remarkInput = v2El("qcRemark");
    const locationInput = v2El("qcLocationInput");
    const dueInput = v2El("qcDueInput");
    const statusInput = v2El("qcStatusInput");
    const remarkValue = remarkInput?.value.trim() || "";
    const editedLocation = locationInput?.value.trim() || currentItem.loc;
    const editedDue = dueInput?.value.trim() || currentItem.due;
    const editedStatus = statusInput?.value.trim() || currentItem.status;
    const isEditMode = Boolean(currentAuditEditRecord);
    const existingRecord = currentAuditEditRecord || {};

    try {
        const masterUpdateResult = await overwriteMasterFieldsIfChanged(editedLocation, editedDue, editedStatus);

        if (masterUpdateResult === null) {
            v2IsSubmitting = false;
            updateVerificationState();
            return;
        }

        const masterLocationUpdated = Boolean(masterUpdateResult.locationUpdated);
        const masterDueUpdated = Boolean(masterUpdateResult.dueUpdated);
        const masterStatusUpdated = Boolean(masterUpdateResult.statusUpdated);
        const savedMasterLocationUpdated = Boolean(existingRecord.masterLocationUpdated || masterLocationUpdated);
        const savedMasterDueUpdated = Boolean(existingRecord.masterDueUpdated || masterDueUpdated);
        const savedMasterStatusUpdated = Boolean(existingRecord.masterStatusUpdated || masterStatusUpdated);

        if (masterLocationUpdated) selectedLoc = "WRONG";

        const automaticRemarks = [];
        if (savedMasterLocationUpdated) automaticRemarks.push("Location overwritten in master database");
        if (savedMasterDueUpdated) automaticRemarks.push("Due date overwritten in master database");
        if (savedMasterStatusUpdated) automaticRemarks.push("Equipment status overwritten in master database");

        const abnormalSuggestion = v2BuildRemarkSuggestion();
        const generatedRemarks = [abnormalSuggestion, ...automaticRemarks].filter(Boolean);
        const finalRemark = remarkValue || generatedRemarks.join("; ") || "-";
        const msaFailed = v2MsaRequired(currentItem.msa) && selectedMsa !== "YES";

        const failed =
            selectedLoc === "WRONG" ||
            selectedStickerLoc === "WRONG" ||
            selectedDue !== "VALID" ||
            msaFailed ||
            currentItem.isUnregistered ||
            savedMasterLocationUpdated ||
            savedMasterDueUpdated ||
            savedMasterStatusUpdated;

        const now = new Date();
        const dateTimeString = now.toLocaleDateString("en-GB") + " " + now.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
        });

        const auditData = {
            id: isEditMode ? (existingRecord.id || Date.now()) : Date.now(),
            time: isEditMode ? (existingRecord.time || dateTimeString) : dateTimeString,
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
            if (existingRecord.cloudId) auditData.cloudId = existingRecord.cloudId;
            auditData.editedBy = loggedInUser;
            auditData.editedAt = dateTimeString;
            await saveEditedAuditRecord(auditData);
            v2SetLastScan(auditData.barcode, failed ? "Updated - abnormal" : "Updated - pass");
            showToast("Audit record updated.", failed ? "warning" : "success");
        } else if (isOnline) {
            const newRef = db.ref("audit_history").push();
            auditData.cloudId = newRef.key;
            await newRef.set(auditData);
            v2SetLastScan(auditData.barcode, failed ? "Saved - abnormal" : "Saved - pass");
            showToast(failed ? "Abnormal audit record saved." : "Audit record saved.", failed ? "warning" : "success");
        } else {
            pendingUploads.push(auditData);
            localStorage.setItem("pending_queue", JSON.stringify(pendingUploads));
            scanHistory.unshift(auditData);
            v2UpdatePendingBadge();
            updateDisplay();
            v2SetLastScan(auditData.barcode, failed ? "Queued - abnormal" : "Queued - pass");
            showToast("Offline: audit record queued for synchronization.", "warning");
        }

        v2Feedback(failed ? "fail" : "pass");
        closeModal();
    } catch (error) {
        console.error("Unable to save audit record", error);
        showToast(`Unable to save the record: ${error.message || "Unknown error"}`, "error", 5200);
        v2Feedback("fail");
        v2IsSubmitting = false;
        updateVerificationState();
    }
}

function closeModal() {
    const barcode = currentItem?.barcode || "";

    if (currentItem && currentLockOwned) {
        releaseLock(currentItem.barcode);
    }

    const modal = v2El("qcModal");
    if (modal) {
        modal.classList.remove("is-open");
        modal.style.display = "";
        modal.hidden = true;
    }

    const remarkInput = v2El("qcRemark");
    if (remarkInput) remarkInput.value = "";

    currentItem = null;
    currentAuditEditId = null;
    currentAuditEditRecord = null;
    currentLockOwned = false;
    selectedLoc = null;
    selectedStickerLoc = null;
    selectedDue = null;
    selectedMsa = null;
    v2DueSuggestion = null;
    v2RemarkSuggestion = "";
    v2IsSubmitting = false;
    setModalMode(false);
    updateDisplay();

    if (v2ResumeCameraAfterModal && html5QrCode && v2CameraPaused) {
        window.setTimeout(() => {
            try {
                html5QrCode.resume();
                v2CameraPaused = false;
                v2ResumeCameraAfterModal = false;
                v2SetScannerStatus("Camera scanning", "active");
            } catch (error) {
                v2CameraPaused = false;
                v2ResumeCameraAfterModal = false;
                v2SetScannerStatus("Scanner ready", "ready");
                v2FocusScannerCollector();
            }
        }, 160);
    } else {
        v2ResumeCameraAfterModal = false;
        if (html5QrCode) {
            v2SetScannerStatus("Camera scanning", "active");
        } else {
            v2SetScannerStatus(barcode ? "Scanner ready for next item" : "Scanner ready", "ready");
            v2FocusScannerCollector();
        }
    }
}

async function handleScannedCode(barcode) {
    if (!barcode || v2ProcessingCode) return;

    const cleanCode = String(barcode).trim().replace(/[\r\n]/g, "");
    if (!cleanCode) return;

    const lookupCode = cleanCode.toUpperCase();
    v2ProcessingCode = true;
    v2SetLastScan(cleanCode, "Processing...");
    v2SetScannerStatus(`Processing ${cleanCode}`, "busy");

    try {
        currentAuditEditId = null;
        currentAuditEditRecord = null;
        currentLockOwned = false;

        const existing = scanHistory.find(record => {
            return String(record.barcode || "").toUpperCase() === lookupCode;
        });

        if (existing) {
            v2SetText("prevPIC", existing.pic || "-");
            v2SetText("prevTime", existing.time || "-");

            const banner = v2El("alertBanner");
            if (banner) {
                banner.classList.add("show");
                window.setTimeout(() => banner.classList.remove("show"), 3600);
            }

            v2SetLastScan(cleanCode, "Duplicate - existing record opened");
            v2Feedback("duplicate");
            showToast("Duplicate detected. Existing record opened for review.", "warning");
            await openAuditDetail(v2SafeActionValue(existing.cloudId || existing.id || existing.barcode || ""));
            return;
        }

        if (isOnline) {
            let lockKey = "";
            try {
                lockKey = btoa(cleanCode).replace(/=/g, "");
            } catch (error) {
                lockKey = "";
            }

            const lock = lockKey ? activeLocks[lockKey] : null;

            if (lock && lock.user !== loggedInUser) {
                v2SetLastScan(cleanCode, `Locked by ${lock.user}`);
                showToast(`${lock.user} is currently auditing this equipment.`, "warning");
                v2Feedback("duplicate");
                return;
            }

            try {
                const lockResult = await attemptLock(cleanCode);
                if (lockResult && lockResult.committed === false) {
                    v2SetLastScan(cleanCode, "Locked by another auditor");
                    showToast("This item is currently being audited by another user.", "warning");
                    v2Feedback("duplicate");
                    return;
                }
                currentLockOwned = true;
            } catch (error) {
                console.warn("Unable to create temporary lock", error);
            }
        }

        const isUrl = cleanCode.toLowerCase().startsWith("http");
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

        v2SetLastScan(cleanCode, masterInfo ? "Registered - verify" : "Unregistered - verify");
        v2Feedback(masterInfo ? "info" : "fail");
        renderQCModal(null);
    } finally {
        v2ProcessingCode = false;

        if (v2ResumeCameraAfterModal && v2CameraPaused && html5QrCode && !v2IsModalOpen()) {
            window.setTimeout(() => {
                try {
                    html5QrCode.resume();
                    v2CameraPaused = false;
                    v2ResumeCameraAfterModal = false;
                    v2SetScannerStatus("Camera scanning", "active");
                } catch (error) {
                    v2CameraPaused = false;
                    v2ResumeCameraAfterModal = false;
                    v2SetScannerStatus("Scanner ready", "ready");
                }
            }, 120);
        }
    }
}

function startPendingAudit(encodedCode) {
    const code = decodeActionValue(encodedCode);
    v2CurrentScanSource = "pending-list";
    handleScannedCode(code);
}

/* -------------------------------------------------------------------------- */
/* Camera workflow                                                             */
/* -------------------------------------------------------------------------- */

async function v2PopulateCameraOptions() {
    const select = v2El("cameraSelect");
    if (!select || !window.Html5Qrcode?.getCameras) return [];

    const existingValue = select.value;
    const cameras = await Html5Qrcode.getCameras();
    select.innerHTML = '<option value="">Rear camera (auto)</option>';

    cameras.forEach((camera, index) => {
        const option = document.createElement("option");
        option.value = camera.id;
        option.textContent = camera.label || `Camera ${index + 1}`;
        option.selected = camera.id === existingValue;
        select.appendChild(option);
    });

    return cameras;
}

function v2PreferredCameraId(cameras) {
    const selected = v2El("cameraSelect")?.value || "";
    if (selected) return selected;

    const preferred = cameras.find(camera => /back|rear|environment/i.test(camera.label || ""));
    return preferred?.id || "";
}

async function v2StopCamera(showReadyStatus = true) {
    const scanner = html5QrCode;
    html5QrCode = null;

    if (scanner) {
        try {
            await scanner.stop();
        } catch (error) {
            // Scanner may already be stopped or paused.
        }

        try {
            scanner.clear();
        } catch (error) {
            // Clearing is optional.
        }
    }

    v2CameraPaused = false;
    v2ResumeCameraAfterModal = false;
    v2TorchOn = false;

    const reader = v2El("reader");
    const cameraButton = v2El("cameraToggleButton");
    const torchButton = v2El("torchButton");

    if (reader) reader.style.display = "none";
    if (cameraButton) cameraButton.textContent = "Start Camera";
    if (torchButton) {
        torchButton.disabled = true;
        torchButton.textContent = "Flashlight";
    }

    if (showReadyStatus) v2SetScannerStatus("Scanner ready", "ready");
    v2FocusScannerCollector();
}

async function v2OnCameraDecoded(decodedText) {
    const now = Date.now();
    const cleanText = String(decodedText || "").trim();

    if (!cleanText || v2IsModalOpen() || v2ProcessingCode) return;

    if (cleanText === v2LastDecodeText && now - v2LastDecodeTime < 2500) return;

    v2LastDecodeText = cleanText;
    v2LastDecodeTime = now;
    v2CurrentScanSource = "camera";

    const continuousMode = Boolean(v2El("continuousMode")?.checked);

    if (continuousMode && html5QrCode) {
        try {
            html5QrCode.pause(true);
            v2CameraPaused = true;
            v2ResumeCameraAfterModal = true;
        } catch (error) {
            v2CameraPaused = false;
            v2ResumeCameraAfterModal = false;
        }
    } else {
        await v2StopCamera(false);
    }

    handleScannedCode(cleanText);
}

async function toggleCamera() {
    if (v2CameraStarting) return;

    if (html5QrCode) {
        await v2StopCamera();
        showToast("Camera scanner stopped.", "info", 2200);
        return;
    }

    const reader = v2El("reader");
    const cameraButton = v2El("cameraToggleButton");
    const torchButton = v2El("torchButton");

    if (!reader || typeof Html5Qrcode === "undefined") {
        showToast("Camera scanner library is not available.", "error");
        return;
    }

    v2CameraStarting = true;
    reader.style.display = "block";
    if (cameraButton) {
        cameraButton.disabled = true;
        cameraButton.textContent = "Starting...";
    }
    v2SetScannerStatus("Starting camera", "busy");

    try {
        const cameras = await v2PopulateCameraOptions();
        const preferredId = v2PreferredCameraId(cameras);
        const cameraSource = preferredId ? { deviceId: { exact: preferredId } } : { facingMode: "environment" };
        const scanWidth = Math.min(320, Math.max(220, window.innerWidth - 70));

        html5QrCode = new Html5Qrcode("reader");

        await html5QrCode.start(
            cameraSource,
            {
                fps: 15,
                qrbox: { width: scanWidth, height: Math.round(scanWidth * 0.62) },
                aspectRatio: 1.333,
                disableFlip: false
            },
            decodedText => {
                v2OnCameraDecoded(decodedText).catch(error => {
                    console.error("Camera decode handling failed", error);
                });
            },
            () => {
                // Frame-level decode failures are expected and intentionally ignored.
            }
        );

        if (cameraButton) {
            cameraButton.disabled = false;
            cameraButton.textContent = "Stop Camera";
        }

        if (torchButton) torchButton.disabled = false;
        v2SetScannerStatus("Camera scanning", "active");
        showToast("Camera scanner started.", "success", 2200);
    } catch (error) {
        console.error("Camera start failed", error);
        html5QrCode = null;
        reader.style.display = "none";
        if (cameraButton) {
            cameraButton.disabled = false;
            cameraButton.textContent = "Start Camera";
        }
        if (torchButton) torchButton.disabled = true;
        v2SetScannerStatus("Camera unavailable", "error");
        showToast("Unable to start the camera. Check browser permission and camera availability.", "error", 5200);
        v2Feedback("fail");
    } finally {
        v2CameraStarting = false;
    }
}

async function toggleTorch() {
    if (!html5QrCode) {
        showToast("Start the camera before using the flashlight.", "warning");
        return;
    }

    const nextState = !v2TorchOn;

    try {
        await html5QrCode.applyVideoConstraints({
            advanced: [{ torch: nextState }]
        });
        v2TorchOn = nextState;
        v2SetText("torchButton", nextState ? "Flashlight On" : "Flashlight");
    } catch (error) {
        showToast("Flashlight control is not supported by this camera or browser.", "warning");
    }
}

/* -------------------------------------------------------------------------- */
/* Master import preview                                                       */
/* -------------------------------------------------------------------------- */

function v2MonthFromToken(token) {
    const normalized = String(token || "").trim().toUpperCase();
    const numeric = Number(normalized);

    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) {
        return MONTH_ORDER[numeric - 1];
    }

    const shortName = normalized.slice(0, 3);
    return MONTH_ORDER.includes(shortName) ? shortName : null;
}

function v2NormalizeImportDue(rawValue) {
    if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
        const month = MONTH_ORDER[rawValue.getMonth()];
        const year = String(rawValue.getFullYear());
        return { valid: true, due: `${month}-${year.slice(-2)}`, month, year };
    }

    if (typeof rawValue === "number" && Number.isFinite(rawValue) && window.XLSX?.SSF?.parse_date_code) {
        const parsed = XLSX.SSF.parse_date_code(rawValue);
        if (parsed) {
            const month = MONTH_ORDER[parsed.m - 1];
            const year = String(parsed.y);
            return { valid: true, due: `${month}-${year.slice(-2)}`, month, year };
        }
    }

    const value = String(rawValue ?? "").trim().toUpperCase();
    if (!value || value === "N/A") {
        return { valid: false, due: "N/A", month: "N/A", year: "N/A", reason: "Missing due date" };
    }

    let match = value.match(/^([A-Z]{3,9})[\s\/-](\d{2}|\d{4})$/);
    if (match) {
        const month = v2MonthFromToken(match[1]);
        const year = match[2].length === 2 ? `20${match[2]}` : match[2];
        if (month) return { valid: true, due: `${month}-${year.slice(-2)}`, month, year };
    }

    match = value.match(/^(\d{1,2})[\/-](\d{2}|\d{4})$/);
    if (match) {
        const month = v2MonthFromToken(match[1]);
        const year = match[2].length === 2 ? `20${match[2]}` : match[2];
        if (month) return { valid: true, due: `${month}-${year.slice(-2)}`, month, year };
    }

    match = value.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
    if (match) {
        const month = v2MonthFromToken(match[1]);
        const year = match[3].length === 2 ? `20${match[3]}` : match[3];
        if (month) return { valid: true, due: `${month}-${year.slice(-2)}`, month, year };
    }

    match = value.match(/^(\d{4})[\/-](\d{1,2})(?:[\/-]\d{1,2})?$/);
    if (match) {
        const month = v2MonthFromToken(match[2]);
        const year = match[1];
        if (month) return { valid: true, due: `${month}-${year.slice(-2)}`, month, year };
    }

    return { valid: false, due: "N/A", month: "N/A", year: "N/A", reason: `Unrecognized due date: ${value}` };
}

function v2NormalizeCell(value) {
    if (value instanceof Date) return value;
    return String(value ?? "").trim();
}

async function loadMasterData(input) {
    const file = input?.files?.[0];
    if (!file) return;

    if (typeof XLSX === "undefined") {
        showToast("Spreadsheet parser is unavailable.", "error");
        return;
    }

    v2SetScannerStatus("Validating master file", "busy");

    try {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, {
            type: "array",
            cellDates: true,
            raw: true
        });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            defval: "",
            raw: true,
            blankrows: false
        });

        if (!rows.length) {
            throw new Error("The selected file is empty.");
        }

        const issues = [];
        const newMasterDB = {};
        const newRawRows = [[
            "EQUIPMENT CODE",
            "EQUIPMENT NAME",
            "LOCATION",
            "DUE DATE",
            "STATUS",
            "MSA"
        ]];
        const previewRows = [];
        const seenCodes = new Set();
        let duplicateCount = 0;

        rows.slice(1).forEach((sourceRow, rowIndex) => {
            const sourceLine = rowIndex + 2;
            const values = Array.from({ length: 6 }, (_, index) => v2NormalizeCell(sourceRow[index]));
            const rowIsEmpty = values.every(value => String(value ?? "").trim() === "");
            if (rowIsEmpty) return;

            const code = String(values[0] || "").trim().toUpperCase();
            let name = String(values[1] || "").trim();
            let location = String(values[2] || "").trim();
            const rawDue = values[3];
            let status = String(values[4] || "").trim();
            let msa = String(values[5] || "").trim();

            if (!code) {
                issues.push({ row: sourceLine, type: "Error", message: "Missing equipment code; row rejected." });
                return;
            }

            if (seenCodes.has(code)) {
                duplicateCount += 1;
                issues.push({ row: sourceLine, type: "Error", message: `Duplicate equipment code ${code}; row rejected.` });
                return;
            }
            seenCodes.add(code);

            if (!name) {
                name = "UNKNOWN";
                issues.push({ row: sourceLine, type: "Warning", message: `${code}: missing equipment name; set to UNKNOWN.` });
            }

            if (!location) {
                location = "N/A";
                issues.push({ row: sourceLine, type: "Warning", message: `${code}: missing location; set to N/A.` });
            }

            if (!status) status = "N/A";
            if (!msa) msa = "N/A";

            const due = v2NormalizeImportDue(rawDue);
            if (!due.valid) {
                issues.push({ row: sourceLine, type: "Warning", message: `${code}: ${due.reason}; set to N/A.` });
            }

            const locationParts = parseLocationParts(location);
            const normalizedRow = [code, name, locationParts.loc, due.due, status, msa];

            newRawRows.push(normalizedRow);
            previewRows.push(normalizedRow);
            newMasterDB[code] = {
                name,
                loc: locationParts.loc,
                bldg: locationParts.bldg,
                prod: locationParts.prod,
                due: due.due,
                status,
                msa,
                month: due.month,
                year: due.year
            };
        });

        v2PendingMasterImport = {
            filename: file.name,
            masterDB: newMasterDB,
            rawMasterRows: newRawRows,
            previewRows,
            issues,
            duplicateCount
        };

        v2RenderImportPreview();
        v2SetScannerStatus("Scanner ready", "ready");
    } catch (error) {
        console.error("Master import failed", error);
        showToast(`Unable to read the master file: ${error.message || "Unknown error"}`, "error", 5200);
        v2SetScannerStatus("Scanner ready", "ready");
        input.value = "";
    }
}

function v2RenderImportPreview() {
    if (!v2PendingMasterImport) return;

    const { previewRows, issues, duplicateCount } = v2PendingMasterImport;
    const errors = issues.filter(issue => issue.type === "Error");
    const warnings = issues.filter(issue => issue.type === "Warning");

    v2SetText("importValidCount", previewRows.length);
    v2SetText("importWarningCount", warnings.length);
    v2SetText("importErrorCount", errors.length);
    v2SetText("importDuplicateCount", duplicateCount);

    const issuePanel = v2El("importIssuePanel");
    const issueList = v2El("importIssueList");

    if (issuePanel) issuePanel.hidden = issues.length === 0;
    if (issueList) {
        issueList.innerHTML = issues.slice(0, 30).map(issue => `
            <div class="import-issue-row ${issue.type === "Error" ? "issue-error" : "issue-warning"}">
                <strong>Row ${issue.row}</strong>
                <span>${escapeHtml(issue.type)}</span>
                <span>${escapeHtml(issue.message)}</span>
            </div>
        `).join("") + (issues.length > 30
            ? `<div class="import-issue-row"><strong>More</strong><span></span><span>${issues.length - 30} additional issues are available in the issue report.</span></div>`
            : "");
    }

    const previewBody = v2El("importPreviewBody");
    if (previewBody) {
        previewBody.innerHTML = previewRows.slice(0, 10).map(row => `
            <tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>
        `).join("");
    }

    const confirmButton = v2El("confirmImportButton");
    if (confirmButton) {
        confirmButton.disabled = previewRows.length === 0;
        confirmButton.textContent = previewRows.length > 0
            ? `Import ${previewRows.length} valid row${previewRows.length === 1 ? "" : "s"}`
            : "No valid rows to import";
    }

    const modal = v2El("importModal");
    if (modal) {
        modal.hidden = false;
        modal.classList.add("is-open");
    }
}

function closeImportModal() {
    const modal = v2El("importModal");
    if (modal) {
        modal.classList.remove("is-open");
        modal.hidden = true;
    }

    const fileInput = v2El("masterFile");
    if (fileInput) fileInput.value = "";

    v2PendingMasterImport = null;
    v2FocusScannerCollector();
}

async function confirmMasterImport() {
    if (!v2PendingMasterImport || v2PendingMasterImport.previewRows.length === 0) {
        showToast("There are no valid master rows to import.", "warning");
        return;
    }

    const button = v2El("confirmImportButton");
    if (button) {
        button.disabled = true;
        button.textContent = "Importing...";
    }

    try {
        await db.ref("master_list").set({
            masterDB: v2PendingMasterImport.masterDB,
            rawMasterRows: v2PendingMasterImport.rawMasterRows
        });

        const count = v2PendingMasterImport.previewRows.length;
        closeImportModal();
        showToast(`${count} master row${count === 1 ? "" : "s"} imported successfully.`, "success");
        v2Feedback("pass");
    } catch (error) {
        console.error("Master upload failed", error);
        showToast(`Master upload failed: ${error.message || "Unknown error"}`, "error", 5200);
        if (button) {
            button.disabled = false;
            button.textContent = "Retry import";
        }
    }
}

function downloadImportIssues() {
    if (!v2PendingMasterImport?.issues.length) {
        showToast("No validation issues to download.", "info");
        return;
    }

    const rows = [["Row", "Type", "Message"]].concat(
        v2PendingMasterImport.issues.map(issue => [issue.row, issue.type, issue.message])
    );
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 80 }];
    worksheet["!autofilter"] = { ref: `A1:C${rows.length}` };
    XLSX.utils.book_append_sheet(workbook, worksheet, "Import Issues");
    XLSX.writeFile(workbook, `Master_Import_Issues_${v2TimestampForFilename()}.xlsx`);
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

function v2ExcelSafe(value) {
    if (typeof value !== "string") return value;
    return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function v2Worksheet(rows, widths, withFilter = true) {
    const safeRows = rows.map(row => row.map(v2ExcelSafe));
    const worksheet = XLSX.utils.aoa_to_sheet(safeRows);
    worksheet["!cols"] = widths.map(width => ({ wch: width }));

    if (withFilter && rows.length > 1 && rows[0].length > 0) {
        const lastColumn = XLSX.utils.encode_col(rows[0].length - 1);
        worksheet["!autofilter"] = { ref: `A1:${lastColumn}${rows.length}` };
    }

    return worksheet;
}

function v2ReportFiltersDescription(filters, search) {
    const parts = [];
    if ((filters.buildings || []).length) parts.push(`Building=${filters.buildings.join("|")}`);
    if ((filters.productions || []).length) parts.push(`Production=${filters.productions.join("|")}`);
    if ((filters.months || []).length) parts.push(`Month=${filters.months.join("|")}`);
    if ((filters.years || []).length) parts.push(`Year=${filters.years.join("|")}`);
    if ((filters.statuses || []).length) parts.push(`Status=${filters.statuses.join("|")}`);
    if (search) parts.push(`Search=${search}`);
    return parts.length ? parts.join(", ") : "All data";
}

function v2BuildReportData(useFilters) {
    const filters = useFilters ? getSelectedFilterState() : {
        buildings: [],
        productions: [],
        months: [],
        years: [],
        statuses: [],
        building: "",
        month: "",
        year: ""
    };
    const search = useFilters ? (v2El("globalSearch")?.value || "").trim().toUpperCase() : "";
    const auditByCode = new Map();

    scanHistory.forEach(record => {
        const code = String(record.barcode || "").toUpperCase();
        if (!auditByCode.has(code)) auditByCode.set(code, record);
    });

    const header = [
        "EQUIPMENT CODE",
        "EQUIPMENT NAME",
        "LOCATION",
        "DUE DATE",
        "STATUS",
        "MSA",
        "AUDIT STATUS",
        "DATE/TIME",
        "AUDITOR",
        "LOCATION AUDIT",
        "STICKER LOCATION AUDIT",
        "DUE AUDIT",
        "MSA AUDIT",
        "REMARK"
    ];

    const allRows = [header];
    const passedRows = [header];
    const abnormalRows = [header];
    const pendingRows = [header];

    Object.keys(masterDB).sort().forEach(code => {
        const item = masterDB[code];
        if (useFilters && (!itemMatchesFilters(item, filters) || !v2MatchesMasterSearch(code, item, search))) return;

        const audit = auditByCode.get(code);
        const base = [code, item.name, item.loc, item.due, item.status, item.msa];
        let row;

        if (audit) {
            row = [
                ...base,
                audit.isFail ? "FAIL" : "PASS",
                audit.time || "",
                audit.pic || "",
                audit.locRes || "",
                audit.stickerLocRes || "",
                audit.dueRes || "",
                audit.msaRes || "",
                audit.remark || ""
            ];
            (audit.isFail ? abnormalRows : passedRows).push(row);
        } else {
            row = [...base, "PENDING", "", "", "", "", "", "", ""];
            pendingRows.push(row);
        }

        allRows.push(row);
    });

    const unregisteredRows = [header];
    scanHistory.forEach(record => {
        const code = String(record.barcode || "").toUpperCase();
        if (masterDB[code]) return;
        if (useFilters && (v2FilterHasStructuredSelection(filters) || !v2MatchesSearch(record, null, search))) return;

        unregisteredRows.push([
            record.barcode || "",
            record.name || "UNREGISTERED",
            "N/A",
            "N/A",
            "UNREGISTERED",
            "N/A",
            "FAIL",
            record.time || "",
            record.pic || "",
            record.locRes || "",
            record.stickerLocRes || "",
            record.dueRes || "",
            record.msaRes || "",
            record.remark || ""
        ]);
    });

    const auditorMap = new Map();
    allRows.slice(1).forEach(row => {
        const auditor = row[8];
        const auditStatus = row[6];
        if (!auditor || auditStatus === "PENDING") return;

        if (!auditorMap.has(auditor)) {
            auditorMap.set(auditor, { total: 0, passed: 0, abnormal: 0 });
        }

        const stats = auditorMap.get(auditor);
        stats.total += 1;
        if (auditStatus === "PASS") stats.passed += 1;
        if (auditStatus === "FAIL") stats.abnormal += 1;
    });

    unregisteredRows.slice(1).forEach(row => {
        const auditor = row[8] || "Unknown";
        if (!auditorMap.has(auditor)) auditorMap.set(auditor, { total: 0, passed: 0, abnormal: 0 });
        const stats = auditorMap.get(auditor);
        stats.total += 1;
        stats.abnormal += 1;
    });

    const auditorRows = [["AUDITOR", "TOTAL SCANS", "PASSED", "ABNORMAL", "PASS RATE"]];
    Array.from(auditorMap.entries())
        .sort((a, b) => b[1].total - a[1].total)
        .forEach(([auditor, stats]) => {
            const passRate = stats.total ? `${Math.round((stats.passed / stats.total) * 100)}%` : "0%";
            auditorRows.push([auditor, stats.total, stats.passed, stats.abnormal, passRate]);
        });

    const totalMaster = allRows.length - 1;
    const passed = passedRows.length - 1;
    const abnormal = abnormalRows.length - 1;
    const pending = pendingRows.length - 1;
    const unregistered = unregisteredRows.length - 1;
    const scanned = passed + abnormal;
    const completion = totalMaster ? `${Math.round((scanned / totalMaster) * 100)}%` : "0%";

    const summaryRows = [
        ["GRID V2.2 CALIBRATION AUDIT REPORT"],
        ["Generated", new Date().toLocaleString("en-MY")],
        ["Generated by", loggedInUser || "Unknown"],
        ["Scope", v2ReportFiltersDescription(filters, search)],
        [],
        ["METRIC", "VALUE"],
        ["Master equipment", totalMaster],
        ["Scanned", scanned],
        ["Passed", passed],
        ["Abnormal", abnormal],
        ["Pending", pending],
        ["Unregistered", unregistered],
        ["Completion", completion]
    ];

    return {
        summaryRows,
        allRows,
        passedRows,
        abnormalRows,
        pendingRows,
        unregisteredRows,
        auditorRows,
        filters,
        search
    };
}

function v2WriteReport(useFilters) {
    if (!Object.keys(masterDB).length && scanHistory.length === 0) {
        showToast("No data is available to export.", "warning");
        return;
    }

    try {
        const report = v2BuildReportData(useFilters);
        const workbook = XLSX.utils.book_new();
        const dataWidths = [20, 32, 24, 12, 16, 10, 14, 20, 18, 16, 20, 16, 14, 38];

        XLSX.utils.book_append_sheet(workbook, v2Worksheet(report.summaryRows, [25, 60], false), "Summary");
        XLSX.utils.book_append_sheet(workbook, v2Worksheet(report.allRows, dataWidths), "All Equipment");
        XLSX.utils.book_append_sheet(workbook, v2Worksheet(report.passedRows, dataWidths), "Passed");
        XLSX.utils.book_append_sheet(workbook, v2Worksheet(report.abnormalRows, dataWidths), "Abnormal");
        XLSX.utils.book_append_sheet(workbook, v2Worksheet(report.pendingRows, dataWidths), "Pending");
        XLSX.utils.book_append_sheet(workbook, v2Worksheet(report.unregisteredRows, dataWidths), "Unregistered");
        XLSX.utils.book_append_sheet(workbook, v2Worksheet(report.auditorRows, [24, 14, 12, 14, 12]), "Auditor Summary");

        const scope = useFilters
            ? v2Slug(
                report.filters.buildings?.[0] ||
                report.filters.productions?.[0] ||
                report.filters.statuses?.[0] ||
                report.search ||
                "filtered"
            )
            : "full";
        const filename = `Calibration_Audit_${scope}_${v2TimestampForFilename()}.xlsx`;

        XLSX.writeFile(workbook, filename);
        showToast(`Report created: ${filename}`, "success", 4200);
    } catch (error) {
        console.error("Report generation failed", error);
        showToast(`Report generation failed: ${error.message || "Unknown error"}`, "error", 5200);
    }
}

function exportToExcel() {
    v2WriteReport(false);
}

function exportFilteredOnly() {
    v2WriteReport(true);
}

/* -------------------------------------------------------------------------- */
/* Startup wiring                                                              */
/* -------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
    const rememberedUser = localStorage.getItem("grid_last_user");
    if (rememberedUser && v2El("username")) v2El("username").value = rememberedUser;

    ["username", "password"].forEach(id => {
        v2El(id)?.addEventListener("keydown", event => {
            if (event.key === "Enter") checkLogin();
        });
    });

    v2El("manualBarcode")?.addEventListener("keydown", event => {
        if (event.key === "Enter") submitManualEntry();
    });

    v2El("globalSearch")?.addEventListener("input", () => {
        window.clearTimeout(v2SearchTimer);
        v2SearchTimer = window.setTimeout(() => {
            v2AuditLimit = 200;
            updateDisplay();
        }, 240);
    });

    v2El("qcRemark")?.addEventListener("input", updateVerificationState);

    v2El("cameraSelect")?.addEventListener("change", () => {
        if (html5QrCode) {
            showToast("Stop and restart the camera to apply the new camera selection.", "info");
        }
    });

    document.addEventListener("pointerdown", event => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(".multi-select")) {
            closeAllMultiFilters();
        }
    });

    window.addEventListener("resize", () => closeAllMultiFilters());

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            if (document.querySelector(".multi-select.open")) {
                closeAllMultiFilters();
                return;
            }

            if (v2IsImportModalOpen()) {
                closeImportModal();
            } else if (v2IsModalOpen()) {
                closeModal();
            }
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            v2El("globalSearch")?.focus();
        }
    });

    v2El("qcModal")?.addEventListener("click", event => {
        if (event.target === v2El("qcModal")) closeModal();
    });

    v2El("importModal")?.addEventListener("click", event => {
        if (event.target === v2El("importModal")) closeImportModal();
    });

    document.querySelector(".progress-container[role='button']")?.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setQuickView("pending");
        }
    });

    db.ref(".info/connected").on("value", snapshot => {
        isOnline = snapshot.val() === true;
        v2UpdateConnectionUI();
    });

    v2UpdateConnectionUI();
    v2UpdatePendingBadge();
    v2SetScannerStatus("Scanner ready", "ready");
    v2SetLastScan("None", "Waiting");
    rebuildFilters();
    updateDisplay();

    if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
        navigator.serviceWorker.register("./sw.js").catch(() => {
            // The app remains fully usable without service worker support.
        });
    }
});
