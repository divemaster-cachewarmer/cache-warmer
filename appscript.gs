// Install in the Apps Script project that receives divemaster's POST requests.
// Keep this schema aligned with SHEET_HEADERS in index.js.
const DEFAULT_HEADER = [
  "run_id", "started_at", "finished_at", "country", "url", "status",
  "cf_cache", "vercel_cache", "cf_ray", "response_ms", "error", "message",
  "nextjs_cache",
];
const MAX_RUN_SHEETS = 30;
const SHEETS_TO_DELETE = 5;
const MAX_CLEANUP_RETRIES = 3;

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const data = JSON.parse(e && e.postData && e.postData.contents || "{}");
    const headers = data.headers || DEFAULT_HEADER;
    if (!Array.isArray(headers) || JSON.stringify(headers) !== JSON.stringify(DEFAULT_HEADER)) {
      throw new Error("Header schema does not match the divemaster receiver");
    }
    if (!Array.isArray(data.rows) || data.rows.length === 0 ||
        data.rows.some((row) => !Array.isArray(row) || row.length !== headers.length)) {
      throw new Error("Every row must contain exactly " + headers.length + " columns");
    }
    const rows = data.rows.map((row) => row.map((value) => value == null ? "" : value));
    const sheetName = String(data.sheetName || "").trim();
    if (!sheetName || sheetName.length > 100 || /[:\\\/\?\*\[\]]/.test(sheetName)) {
      throw new Error("Invalid sheetName");
    }

    const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
    const spreadsheet = spreadsheetId
      ? SpreadsheetApp.openById(spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet) throw new Error("Set the SPREADSHEET_ID script property");

    lock.waitLock(30000);
    locked = true;
    let sheet = spreadsheet.getSheetByName(sheetName);
    const lastRow = sheet ? sheet.getLastRow() : 0;
    if (lastRow > 0) {
      const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      if (JSON.stringify(existing) !== JSON.stringify(headers)) {
        throw new Error("Existing sheet uses different headers; use a new run sheet");
      }
    }

    const values = lastRow === 0 ? [headers].concat(rows) : rows;
    const deletedSheets = [];
    for (let attempt = 0; ; attempt++) {
      try {
        if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
        // Reuse the same range on retry so a retried flush cannot append duplicates.
        sheet.getRange(lastRow + 1, 1, values.length, headers.length).setValues(values);
        SpreadsheetApp.flush();
        break;
      } catch (error) {
        if (!isCellLimitError_(error) || attempt >= MAX_CLEANUP_RETRIES) throw error;
        const deleted = deleteOldestSheets_(spreadsheet, SHEETS_TO_DELETE, sheetName);
        if (deleted.length === 0) throw error;
        deletedSheets.push(...deleted);
      }
    }

    // Apply normal retention after the incoming data has been saved.
    const excess = getRunSheets_(spreadsheet).length - MAX_RUN_SHEETS;
    if (excess > 0) {
      deletedSheets.push(...deleteOldestSheets_(spreadsheet, excess, sheetName));
    }
    return respondJSON_({ ok: true, inserted: rows.length, sheet: sheetName, headers, deletedSheets });
  } catch (error) {
    return respondJSON_({ ok: false, error: String(error.message || error) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function isCellLimitError_(error) {
  return /\bcells?\b.*\b(?:limit|maximum)\b|\b(?:limit|maximum)\b.*\bcells?\b/i
    .test(String(error.message || error));
}

function parseSheetDate_(name) {
  // Also recognize the -2, -3 suffixes used by the previous receiver.
  const match = String(name).match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_WITA(?:-\d+)?$/);
  if (!match) return null;
  const iso = match[1] + "T" + match[2] + ":" + match[3] + ":" + match[4] + ".000Z";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso ? date : null;
}

function getRunSheets_(spreadsheet) {
  return spreadsheet.getSheets()
    .map((sheet) => ({ sheet, date: parseSheetDate_(sheet.getName()) }))
    .filter((entry) => entry.date !== null);
}

function deleteOldestSheets_(spreadsheet, count, protectedSheetName) {
  const candidates = getRunSheets_(spreadsheet)
    .filter((entry) => entry.sheet.getName() !== protectedSheetName)
    .sort((a, b) => a.date.getTime() - b.date.getTime() ||
      a.sheet.getName().localeCompare(b.sheet.getName()));
  // Google Sheets needs at least one tab, even when every tab is a run log.
  const limit = Math.min(count, candidates.length, spreadsheet.getSheets().length - 1);
  const deleted = [];
  for (let i = 0; i < limit; i++) {
    const name = candidates[i].sheet.getName();
    spreadsheet.deleteSheet(candidates[i].sheet);
    deleted.push(name);
    Logger.log("Deleted old cache-warmer tab: " + name);
  }
  if (deleted.length > 0) SpreadsheetApp.flush();
  return deleted;
}

function respondJSON_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
