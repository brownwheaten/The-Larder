// The Larder service — Google Apps Script bound to the "Larder Cooking Log" spreadsheet.
// v3 (Oct 18 2026): cooking log (with ratings/notes updates) + Pantry tab + Plan tab (weekly plan).
// Deploy: Deploy → Manage deployments → pencil → Version: New version → Deploy. URL stays the same.
const LOG_SHEET = 'Log';
const PANTRY_SHEET = 'Pantry';
const PLAN_SHEET = 'Plan';

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'pantry') return json({ pantry: readPantry() });
  if (p.action === 'plan') return json({ plan: readPlan() });
  if (p.action === 'list' || !p.action) return listLog();
  return json({ error: 'unknown action' });
}

function doPost(e) {
  const body = JSON.parse((e.postData && e.postData.contents) || '{}');
  if (body.pantry) return json({ ok: true, pantry: writePantry(body.pantry) });
  if (body.plan) return json({ ok: true, plan: writePlan(body.plan) });
  const entries = body.entries || [];
  const sh = getLogSheet();
  const data = sh.getDataRange().getValues();
  const rowByKey = {};
  for (let i = 1; i < data.length; i++) {
    let k = '';
    try { const j = JSON.parse(data[i][3]); k = j.ts + '|' + j.id; } catch (err) { k = asText(data[i][0]) + '|' + data[i][1]; }
    rowByKey[k] = i + 1;
  }
  let added = 0, updated = 0;
  entries.forEach(en => {
    if (!en || !en.ts || !en.id) return;
    const key = en.ts + '|' + en.id;
    const row = [en.ts, en.id, en.title || '', JSON.stringify(en), (en.ingredients || []).map(i => i.item).join(', '), en.servings || '', en.rating || '', en.note || ''];
    if (rowByKey[key]) { textRange(sh, rowByKey[key], row.length).setValues([row]); updated++; }
    else { const r = sh.getLastRow() + 1; textRange(sh, r, row.length).setValues([row]); rowByKey[key] = r; added++; }
  });
  return json({ ok: true, added: added, updated: updated });
}

function listLog() {
  const rows = getLogSheet().getDataRange().getValues().slice(1);
  const entries = rows.filter(r => r[0]).map(r => { try { return JSON.parse(r[3]); } catch (err) { return null; } }).filter(Boolean);
  return json({ entries: entries });
}

function getLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) { sh = ss.insertSheet(LOG_SHEET); sh.appendRow(['timestamp', 'recipe_id', 'title', 'entry_json', 'ingredients', 'servings', 'rating', 'note']); }
  if (sh.getLastColumn() < 8) sh.getRange(1, 7, 1, 2).setValues([['rating', 'note']]);
  return sh;
}

function getPantrySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PANTRY_SHEET);
  if (!sh) { sh = ss.insertSheet(PANTRY_SHEET); sh.appendRow(['item', 'state', 'category', 'name', 'updated']); }
  return sh;
}

// Pantry is stored one row per item with an explicit state (have / growing / out / none).
// Items not listed use the Larder's defaults. Row 2 holds the last-updated timestamp in column E.
function readPantry() {
  const sh = getPantrySheet();
  const rows = sh.getDataRange().getValues().slice(1);
  const items = {}, custom = [];
  let updated = '';
  rows.forEach(r => {
    if (!r[0]) return;
    items[r[0]] = r[1];
    if (r[2] || r[3]) custom.push({ k: r[0], n: r[3] || r[0], c: r[2] || 'other' });
    if (r[4] && asText(r[4]) > updated) updated = asText(r[4]);
  });
  return { items: items, custom: dedupe(custom), updated: updated };
}

function writePantry(p) {
  const sh = getPantrySheet();
  const items = p.items || {}, custom = p.custom || [], updated = p.updated || new Date().toISOString();
  const byKey = {};
  custom.forEach(c => { if (c && c.k) byKey[c.k] = c; });
  const rows = Object.keys(items).sort().map(k => [k, items[k], byKey[k] ? byKey[k].c : '', byKey[k] ? byKey[k].n : '', updated]);
  custom.forEach(c => { if (c && c.k && !(c.k in items)) rows.push([c.k, '', c.c || '', c.n || '', updated]); });
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 5).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 5).setNumberFormat('@').setValues(rows);
  return { count: rows.length, updated: updated };
}

// Plan: one row per planned meal (readable in the sheet), with the week and last-updated time in H2 / I2.
function getPlanSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PLAN_SHEET);
  if (!sh) { sh = ss.insertSheet(PLAN_SHEET); sh.getRange(1, 1, 1, 9).setValues([['day', 'recipe', 'servings', 'cooked', 'recipe_id', 'added', '', 'week', 'updated']]); }
  return sh;
}

function readPlan() {
  const sh = getPlanSheet();
  const last = sh.getLastRow();
  const week = asText(sh.getRange(2, 8).getValue(), true), updated = asText(sh.getRange(2, 9).getValue());
  if (last < 2) return { week: week, items: [], updated: updated };
  const rows = sh.getRange(2, 1, last - 1, 6).getValues();
  const items = rows.filter(r => r[4]).map(r => ({ day: r[0] || '', title: r[1], servings: Number(r[2]) || 2, done: r[3] === true || r[3] === 'TRUE' || r[3] === 'yes', id: String(r[4]), added: asText(r[5]) }));
  return { week: week, items: items, updated: updated };
}

function writePlan(p) {
  const sh = getPlanSheet();
  const items = p.items || [], updated = p.updated || new Date().toISOString();
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 9).clearContent();
  const rows = items.map(i => [i.day || '', i.title || '', i.servings || 2, i.done ? 'yes' : '', i.id, i.added || '']);
  if (rows.length) sh.getRange(2, 1, rows.length, 6).setNumberFormat('@').setValues(rows);
  sh.getRange(2, 8, 1, 2).setNumberFormat('@').setValues([[p.week || '', updated]]);
  return { count: rows.length, week: p.week || '', updated: updated };
}

// Sheets turns date-looking text into dates. Store as plain text; read either form back as text.
function textRange(sh, row, width) { return sh.getRange(row, 1, 1, width).setNumberFormat('@'); }
function asText(v, dateOnly) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return dateOnly ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v.toISOString();
  }
  return String(v);
}

function dedupe(list) { const seen = {}; return list.filter(c => (seen[c.k] ? false : (seen[c.k] = true))); }
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
