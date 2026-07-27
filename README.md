# GRID V2.7 Calibration Inventory System

This package upgrades the original browser application while retaining its existing Firebase Realtime Database configuration and paths. New audit fields are optional, so existing records remain readable.

## Main upgrades

- Scanner-first console with live state, last scan, last result, cloud state, pending-sync count, and last-sync time.
- Continuous camera mode that pauses while the verification modal is open and resumes for the next item.
- Camera selection and flashlight controls where supported by the device/browser.
- Sound and vibration feedback for passed, missing, abnormal, duplicate, and invalid operations.
- Explicit verification: physical location, location printed on the sticker, due date, and MSA must be completed before Save is enabled.
- One-tap **Mark Missing & Save** action: registered equipment can be recorded as missing without completing the four verification checks. The audit stores `isMissing: true`, `auditStatus: MISSING`, physical location as `MISSING`, all non-applicable checks as `N/A`, and `isFail: false`.
- Registered equipment status can be edited from the verification/detail modal and is synchronized to Firebase `master_list` together with the raw master row.
- Sticker-location results are stored as `stickerLocRes`, included in abnormal logic, displayed in audit logs, searchable, and exported in Excel reports.
- Due-date suggestion from registered values such as `APR-27`.
- MSA handling based on whether the master record marks MSA as required.
- Remarks no longer make an otherwise passed audit fail; abnormal conditions determine the audit result.
- Responsive mobile cards, larger touch targets, sticky modal actions, and horizontally safe desktop tables.
- Dedicated **Missing** statistic card and quick view. Missing records are excluded from Passed, Abnormal, and the Abnormal Analysis chart, including older missing records that were previously saved with `isFail: true`.
- Quick views for all, abnormal, missing, passed, current auditor, unregistered, and pending records.
- Search across code, serial number, name, location, production, auditor, result, and remarks.
- Checkbox multi-select filters for Building, Production, Due Month, Due Year, and Equipment Status. Each menu supports option search, Select all, Clear, selected-count feedback, and combinations across multiple filter groups.
- Header-aware CSV/Excel master import with preview, duplicate detection, warnings, rejected-row reporting, issue export, and optional serial-number preservation.
- Multi-sheet Excel report: Summary, All Equipment, Passed, Abnormal, Missing, Pending, Unregistered, and Auditor Summary. Missing is counted separately from Abnormal.
- **Export CSV Filtered** creates one filtered equipment list with exactly these columns: `EquipName`, `SerialNo`, `EquipCode`, `LocationName`, `Building`, `ProdType`, and `Status`. The status is `MISSING` for the latest missing audit, `PENDING` when the equipment has not been scanned, and `OK` for every other scanned item.
- Pagination-style limiting for large audit histories and batched pending display.
- Toast notifications, loading states, empty states, keyboard shortcuts, and accessible labels.
- Installable app manifest and a same-origin app-shell service worker.

## Files

- `index.html` — application markup and unchanged Firebase project configuration.
- `script.js` — original application/database logic.
- `enhancements.js` — V2.7 workflow, interface, import, scanner, and reporting upgrades.
- `style.css` — complete responsive V2.7 styling.
- `manifest.json`, `icon.svg`, `sw.js` — installable app shell.
- `sample_master.csv` — example import file with an optional serial-number column and a quoted equipment name containing a comma.

## Run locally

Camera access and service workers generally require HTTPS or localhost. From this folder, start a local server:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

For production, deploy the complete folder to an HTTPS-enabled static host.

## Master-file columns

The importer detects columns by their header names rather than requiring one fixed order. It supports the original calibration layout:

1. Equipment Code
2. Equipment Name
3. Location
4. Due Date
5. Status
6. MSA
7. Serial No. (optional)

It also supports the equipment-list layout shown in the requested CSV format:

1. EquipName
2. SerialNo
3. EquipCode
4. LocationName
5. Building
6. ProdType
7. Status

When Due Date or MSA is not present, the imported value is stored as `N/A`. Supported due-date examples include `APR-27`, `04/2027`, `04/15/2027`, and `2027-04`.

## Compatibility notes

- The app still loads Html5Qrcode, SheetJS, Chart.js, and Firebase compatibility libraries from their existing CDNs.
- Firebase paths remain `audit_history`, `master_list`, and `temporary_locks`.
- Existing `Clear Cloud` and `Logout & Clear` behavior in `script.js` remains unchanged.
- Existing audit records without `stickerLocRes` display `N/A`; opening one for editing requires completing the new sticker-location check.
- The filtered CSV uses the Search, Building, Production, Due Month, Due Year, and Equipment Status controls and exports one row per matching registered equipment. Unregistered scans are not included.
- `SerialNo` is read from the master record or a recognized serial-number column. It remains blank when the source master data does not contain a serial number.
- The latest audit for each equipment determines the exported tracking status. A later normal audit changes a previously missing item back to `OK`.
- Equipment status edits are trimmed, normalized to uppercase, and rejected when blank.
- Marking an item missing records a separate Missing result, not an Abnormal result, and does not silently overwrite the master equipment status; use the existing status editor when the master status must also be changed.
- The app-shell service worker caches only same-origin application files; Firebase synchronization still requires a network connection.
- Flashlight control depends on camera hardware and browser support.
