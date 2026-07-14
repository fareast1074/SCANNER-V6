# GRID V2.1 Calibration Inventory System

This package upgrades the original browser application while retaining its existing Firebase Realtime Database configuration, paths, and audit/master record structure.

## Main upgrades

- Scanner-first console with live state, last scan, last result, cloud state, pending-sync count, and last-sync time.
- Continuous camera mode that pauses while the verification modal is open and resumes for the next item.
- Camera selection and flashlight controls where supported by the device/browser.
- Sound and vibration feedback for passed, abnormal, duplicate, and invalid operations.
- Explicit verification: location, due date, and MSA must be completed before Save is enabled.
- Due-date suggestion from registered values such as `APR-27`.
- MSA handling based on whether the master record marks MSA as required.
- Remarks no longer make an otherwise passed audit fail; abnormal conditions determine the audit result.
- Responsive mobile cards, larger touch targets, sticky modal actions, and horizontally safe desktop tables.
- Quick views for all, abnormal, passed, current auditor, unregistered, and pending records.
- Search across code, name, location, production, auditor, result, and remarks.
- Checkbox multi-select filters for Building, Production, Due Month, Due Year, and Equipment Status. Each menu supports option search, Select all, Clear, selected-count feedback, and combinations across multiple filter groups.
- Validated CSV/Excel master import with preview, duplicate detection, warnings, rejected-row reporting, and issue export.
- Multi-sheet Excel report: Summary, All Equipment, Passed, Abnormal, Pending, Unregistered, and Auditor Summary.
- Pagination-style limiting for large audit histories and batched pending display.
- Toast notifications, loading states, empty states, keyboard shortcuts, and accessible labels.
- Installable app manifest and a same-origin app-shell service worker.

## Files

- `index.html` — application markup and unchanged Firebase project configuration.
- `script.js` — original application/database logic.
- `enhancements.js` — V2.1 workflow, interface, import, scanner, and reporting upgrades.
- `style.css` — complete responsive V2.1 styling.
- `manifest.json`, `icon.svg`, `sw.js` — installable app shell.
- `sample_master.csv` — example import file, including a quoted equipment name containing a comma.

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

The importer reads the first six columns in this order:

1. Equipment Code
2. Equipment Name
3. Location
4. Due Date
5. Status
6. MSA

Supported due-date examples include `APR-27`, `04/2027`, `04/15/2027`, and `2027-04`.

## Compatibility notes

- The app still loads Html5Qrcode, SheetJS, Chart.js, and Firebase compatibility libraries from their existing CDNs.
- Firebase paths remain `audit_history`, `master_list`, and `temporary_locks`.
- Existing `Clear Cloud` and `Logout & Clear` behavior in `script.js` remains unchanged.
- The app-shell service worker caches only same-origin application files; Firebase synchronization still requires a network connection.
- Flashlight control depends on camera hardware and browser support.
