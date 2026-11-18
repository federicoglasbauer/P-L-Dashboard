// ================================================================
//  REFERENCIA — Código original de Google Apps Script (Code.gs)
//  Se guarda solo para trazabilidad de la migración (spec 001).
//  NO se despliega. Las credenciales de PBCS fueron removidas.
// ================================================================

// ================================================================
//  P&L Dashboard — Google Apps Script
//  Serve la página y actúa de proxy hacia Oracle PBCS
// ================================================================

const PBCS_BASE    = 'https://epmdespegaropsfin2-despegaroraclesaas.epm.us-phoenix-1.ocs.oraclecloud.com';
const PBCS_URL     = PBCS_BASE + '/HyperionPlanning/rest/v3/applications/PPTO/plantypes/PPTO/exportdataslice';
const PBCS_INTEROP = PBCS_BASE + '/interop/rest/11.1.2.3.600';

// [REMOVIDO] Las credenciales estaban hardcodeadas acá. En Ownia se leen de APP_SECRETS.
const PBCS_CREDENTIALS = Utilities.base64Encode('<PBCS_USER>:<PBCS_PASSWORD>');

// ── Sirve el HTML ────────────────────────────────────────────────
function doGet(e) {
  const page  = (e && e.parameter && e.parameter.page) || 'index';
  const valid = { index: true, country: true, lob: true };
  const file  = valid[page] ? page : 'index';
  return HtmlService.createHtmlOutputFromFile(file)
    .setTitle('P&L Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1'); // Mobile responsive
}

// ── Helper interno ───────────────────────────────────────────────
function _pbcsFetch(url, options) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = 'Basic ' + PBCS_CREDENTIALS;
  options.muteHttpExceptions = true;
  const resp = UrlFetchApp.fetch(url, options);
  const code = resp.getResponseCode();
  if (code >= 400) {
    throw new Error('PBCS HTTP ' + code + ': ' + resp.getContentText().substring(0, 300));
  }
  return resp;
}

// ── Proxy hacia Oracle PBCS (data slice) ────────────────────────
function fetchPBCS(payloadStr) {
  const resp = _pbcsFetch(PBCS_URL, {
    method:      'post',
    contentType: 'application/json',
    headers:     { 'Accept': 'application/json' },
    payload:     payloadStr,
  });
  return resp.getContentText();
}

// ── Dispara el job de export ─────────────────────────────────────
function runExportJob(jobName) {
  jobName = jobName || 'Actual FCCS';
  const url  = PBCS_BASE + '/HyperionPlanning/rest/v3/applications/PPTO/jobs';
  const resp = _pbcsFetch(url, {
    method:      'post',
    contentType: 'application/json',
    headers:     { 'Accept': 'application/json' },
    payload:     JSON.stringify({ jobType: 'EXPORT_DATA', jobName: jobName }),
  });
  return resp.getContentText(); // JSON string con jobId
}

// ── Estado del job ───────────────────────────────────────────────
function getJobStatus(jobId) {
  const url  = PBCS_BASE + '/HyperionPlanning/rest/v3/applications/PPTO/jobs/' + jobId;
  const resp = _pbcsFetch(url, {
    method:  'get',
    headers: { 'Accept': 'application/json' },
  });
  return resp.getContentText(); // JSON string
}

// ── Descarga el archivo del outbox y lo devuelve como base64 ─────
function downloadExportFile(filename) {
  const url  = PBCS_INTEROP + '/applicationsnapshots/' + encodeURIComponent(filename) + '/contents';
  const resp = _pbcsFetch(url, {
    method:  'get',
    headers: { 'Accept': 'application/octet-stream,*/*' },
  });
  const b64 = Utilities.base64Encode(resp.getBlob().getBytes());
  return JSON.stringify({ filename: filename, base64: b64 });
}

// ── Descarga múltiples archivos y los combina en un ZIP ───────────
function downloadExportFilesZipped(filenames, zipName) {
  zipName = zipName || 'export.zip';
  const blobs = filenames.map(function(filename) {
    const url  = PBCS_INTEROP + '/applicationsnapshots/' + encodeURIComponent(filename) + '/contents';
    const resp = _pbcsFetch(url, {
      method:  'get',
      headers: { 'Accept': 'application/octet-stream,*/*' },
    });
    return resp.getBlob().setName(filename);
  });
  const zipped = Utilities.zip(blobs, zipName);
  const b64 = Utilities.base64Encode(zipped.getBytes());
  return JSON.stringify({ filename: zipName, base64: b64 });
}

// ── Log de Refresh en Google Sheets ─────────────────────────────
const LOG_SHEET_ID  = '1ZdzjNmfMFgs0ZANsnCJRfnwyAdTUYJBIvlbr4Gt2ocg';
const LOG_TAB_NAME  = 'Refresh Log';

function logRefresh(vista) {
  try {
    var ss    = SpreadsheetApp.openById(LOG_SHEET_ID);
    var sheet = ss.getSheetByName(LOG_TAB_NAME);
    if (!sheet) return; // si no existe la pestaña, no hace nada
    var usuario   = Session.getActiveUser().getEmail();
    var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([timestamp, usuario, vista]);
  } catch (e) {
    // silencioso — nunca bloquea el refresh principal
  }
}

// ── Admins: emails autorizados para editar configuración Medidas ──
const ALERT_AUTHORIZED_EMAILS = [
  'joaquin.cassiani@despegar.com',
  'juan.chahwan@despegar.com',
  'agustin.troglio@despegar.com',
  'micaela.kennis@despegar.com',
];

function isAuthorizedForAlerts() {
  try {
    var email = (Session.getActiveUser().getEmail() || '').toLowerCase().trim();
    if (!email) return false;
    return ALERT_AUTHORIZED_EMAILS.some(function(e) { return e.toLowerCase().trim() === email; });
  } catch (e) {
    return false;
  }
}

// ── Medidas: configuración de escenarios ────────────────────────────────
const MEDIDAS_CONFIG_KEY    = 'MEDIDAS_CONFIG';
const ACTUAL_MONTHS_KEY     = 'ACTUAL_MONTHS'; // legacy, se mantiene para retrocompat
const VALID_FISCAL_MONTHS   = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
const MEDIDAS_DEFAULT = { actualMonths: ['Apr','May'], runRateMonths: [], runRateTail: 'Forecast', forecastActualMonths: ['Apr','May'] };

// Lectura: pública (todos los usuarios la necesitan para saber qué meses aplican a qué escenario)
function getMedidasConfig() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(MEDIDAS_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
    // Retrocompat: si hay legacy ACTUAL_MONTHS, usarlos como actualMonths
    var legacyRaw = PropertiesService.getScriptProperties().getProperty(ACTUAL_MONTHS_KEY);
    var legacyMonths = legacyRaw ? JSON.parse(legacyRaw) : MEDIDAS_DEFAULT.actualMonths;
    return { actualMonths: legacyMonths, runRateMonths: MEDIDAS_DEFAULT.runRateMonths, runRateTail: MEDIDAS_DEFAULT.runRateTail };
  } catch (e) {
    return JSON.parse(JSON.stringify(MEDIDAS_DEFAULT));
  }
}

// Escritura: solo admins
function setMedidasConfig(config) {
  if (!isAuthorizedForAlerts()) throw new Error('Usuario no autorizado para editar esta configuración.');
  var valid = VALID_FISCAL_MONTHS;
  var tailOpts = ['Forecast', 'Budget', 'None'];
  var clean = {
    actualMonths:         (config.actualMonths         || []).filter(function(m) { return valid.indexOf(m) !== -1; }),
    runRateMonths:        (config.runRateMonths        || []).filter(function(m) { return valid.indexOf(m) !== -1; }),
    runRateTail:          tailOpts.indexOf(config.runRateTail) !== -1 ? config.runRateTail : 'Forecast',
    forecastActualMonths: (config.forecastActualMonths || []).filter(function(m) { return valid.indexOf(m) !== -1; })
  };
  PropertiesService.getScriptProperties().setProperty(MEDIDAS_CONFIG_KEY, JSON.stringify(clean));
  PropertiesService.getScriptProperties().setProperty(ACTUAL_MONTHS_KEY, JSON.stringify(clean.actualMonths));
  return { ok: true, config: clean };
}

// Info del usuario: email e isAdmin (para mostrar/ocultar controles en el cliente)
function getUserInfo() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch(e) {}
  var isAdmin = ALERT_AUTHORIZED_EMAILS.some(function(ae) {
    return ae.toLowerCase().trim() === email.toLowerCase().trim();
  });
  return { email: email, isAdmin: isAdmin };
}

// Legacy — se mantiene por si hay alguna llamada vieja
function getActualMonthsConfig() { return getMedidasConfig().actualMonths; }
function setActualMonthsConfig(monthsArray) {
  return setMedidasConfig({ actualMonths: monthsArray, runRateMonths: [], runRateTail: 'Forecast' });
}
