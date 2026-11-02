/**
 * Проверка АВР — серверная часть, версия 2.1 (несколько площадок, ДГУ, контроль и срок по объектам).
 *
 * Что делает:
 *  • хранит фото актов проверки АВР на Google Диске:
 *    «АВР — акты проверки» → «Пром-1» → «Корпус 12»;
 *  • ведёт журнал актов на листе «Журнал» этой Google Таблицы;
 *    столбец J «Площадка» — код площадки (p1, p2…); пустая ячейка = Пром-1;
 *  • коды доступа берёт с листа «Доступ»: у каждой площадки свой код, плюс код администратора;
 *  • список «Кто проверял» берёт с листа «Проверяющие»;
 *  • контроль АВР по зданиям и ДГУ: администратор включает и выключает его со страницы
 *    и задаёт объекту срок акта от 10 до 45 дней; каждое изменение — строка на листе «Контроль»;
 *  • отдаёт странице только акты тех площадок, которые открывает введённый код.
 *
 * Совместимость: страница версии 1 продолжает работать с кодом Пром-1 —
 * её запросы без площадки относятся к Пром-1, старые строки журнала тоже.
 *
 * Установка и обновление — по шагам в README.md. Коротко:
 *  1. Расширения → Apps Script → замените весь код этим → Сохранить.
 *  2. Выполните функцию setup (один раз) — появятся листы «Доступ» и «Проверяющие».
 *  3. На листе «Доступ» впишите коды; на листе «Проверяющие» — ФИО.
 *  4. Развертывание → Управление развертываниями → карандаш → Версия: новая версия → Развернуть.
 *     Адрес /exec не меняется.
 */

// ===================== НАСТРОЙКИ =====================

// Название папки на Google Диске, в которой появятся папки площадок.
const ROOT_FOLDER_NAME = 'АВР — акты проверки';

// Названия листов.
const SHEET_NAME = 'Журнал';
const ACCESS_SHEET = 'Доступ';
const PEOPLE_SHEET = 'Проверяющие';
const CONTROL_SHEET = 'Контроль';

// Площадки, которые setup впишет на лист «Доступ» (код, название как на вкладке).
const DEFAULT_SITES = [['p1', 'Пром-1'], ['p2', 'Пром-2']];

// =====================================================

const MAX_FILES = 6;
const MAX_FILE_MB = 15;
const MIN_KEY_LENGTH = 4;
const ADMIN = 'admin';
const LEGACY_SITE = 'p1';   // площадка для записей и запросов без площадки (версия 1)
const HEADERS = ['ID акта', 'Загружен', 'Корпус', 'Дата проверки', 'Кто проверял', 'Примечание', 'Ссылки на фото', 'ID файлов', 'Удалён', 'Площадка'];
const COL = { id: 1, uploaded: 2, building: 3, date: 4, by: 5, note: 6, links: 7, fileIds: 8, deleted: 9, site: 10 };
const ACCESS_HEADERS = ['Площадка', 'Название', 'Код доступа'];
const PEOPLE_HEADERS = ['ФИО', 'Площадка'];
const CONTROL_HEADERS = ['Площадка', 'Объект', 'Контроль', 'Изменено', 'Кто', 'Причина', 'Срок, дней'];
const MIN_DAYS = 10;   // срок акта, который администратор может задать объекту
const MAX_DAYS = 45;

/** Запустите один раз из редактора: подготовит листы и папку на Диске, попросит разрешения. */
function setup() {
  const sheet = sheet_();
  const access = accessSheet_();
  peopleSheet_();
  controlSheet_();
  const root = rootFolder_();
  const sites = readAccess_();
  const empty = sites.list.filter(function (s) { return !s.key; }).map(function (s) { return s.name; });
  if (!sites.adminKey) empty.push('Администратор');
  Logger.log('Готово. Журнал: лист «%s». Папка с актами: %s', sheet.getName(), root.getUrl());
  if (empty.length) Logger.log('Впишите коды доступа на листе «%s» (не короче %s символов): %s', access.getName(), MIN_KEY_LENGTH, empty.join(', '));
  Logger.log('ФИО для поля «Кто проверял» впишите на листе «%s».', PEOPLE_SHEET);
}

function doGet(e) {
  return respond_(function () {
    const p = (e && e.parameter) || {};
    const acc = checkKey_(p.key);
    const v2 = String(p.v || '') === '2';
    switch (p.action) {
      case 'ping': return { sites: acc.sites, admin: acc.admin };
      case 'list':
        // страница версии 1 не знает о площадках — ей только Пром-1
        if (!v2) return { acts: listActs_(only_(acc, LEGACY_SITE)) };
        return { acts: listActs_(acc.sites), people: listPeople_(acc), control: listControl_(acc.sites), sites: acc.sites, admin: acc.admin };
      case 'file': return getFile_(p.id, acc);
      default: throw fail_('bad_request', 'Неизвестное действие.');
    }
  });
}

function doPost(e) {
  return respond_(function () {
    let body;
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      throw fail_('bad_request', 'Некорректный запрос.');
    }
    const acc = checkKey_(body.key);
    switch (body.action) {
      case 'upload': return { act: upload_(body, acc) };
      case 'delete': return { id: deleteAct_(body.id, body.by, acc) };
      case 'control': return { control: setControl_(body, acc) };
      default: throw fail_('bad_request', 'Неизвестное действие.');
    }
  });
}

// ---------- ответы и проверки ----------

function respond_(fn) {
  let out;
  try {
    out = Object.assign({ ok: true }, fn());
  } catch (err) {
    out = err && err.code
      ? { ok: false, code: err.code, error: err.message }
      : { ok: false, code: 'server_error', error: 'Ошибка в скрипте Google: ' + (err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Какие площадки открывает код: { sites: ['p1'], admin: false }. */
function checkKey_(key) {
  const acc = readAccess_();
  const k = String(key || '').trim();
  if (!acc.anyKey) {
    throw fail_('not_configured', 'В Google Таблице на листе «' + ACCESS_SHEET + '» не заданы коды доступа. Впишите их и обновите развертывание.');
  }
  if (k && k.length >= MIN_KEY_LENGTH) {
    if (acc.adminKey && k === acc.adminKey) return { sites: acc.list.map(function (s) { return s.code; }), admin: true };
    const sites = acc.list.filter(function (s) { return s.key && s.key === k; }).map(function (s) { return s.code; });
    if (sites.length) return { sites: sites, admin: false };
  }
  Utilities.sleep(800); // замедляем подбор кода
  throw fail_('bad_key', 'Неверный код доступа.');
}

function only_(acc, site) {
  return acc.sites.indexOf(site) >= 0 ? [site] : [];
}

function allowed_(acc, site) {
  if (acc.sites.indexOf(site) < 0) throw fail_('forbidden', 'Этот код доступа не открывает площадку ' + siteName_(site) + '.');
}

// ---------- хранилище ----------

function spreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw fail_('not_configured', 'Скрипт нужно создать из Google Таблицы: Расширения → Apps Script.');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function sheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('C:D').setNumberFormat('@'); // корпус и дату храним как текст
    sh.setColumnWidth(COL.uploaded, 150);
    sh.setColumnWidth(COL.by, 170);
    sh.setColumnWidth(COL.note, 240);
    sh.setColumnWidth(COL.links, 320);
  } else if (String(sh.getRange(1, COL.site).getValue() || '').trim() === '') {
    // журнал версии 1: добавляем столбец «Площадка» в конец, остальное не трогаем
    sh.getRange(1, COL.site).setValue(HEADERS[COL.site - 1]).setFontWeight('bold');
  }
  return sh;
}

function accessSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(ACCESS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ACCESS_SHEET);
    const rows = [ACCESS_HEADERS].concat(DEFAULT_SITES.map(function (s) { return [s[0], s[1], '']; }), [[ADMIN, 'Администратор', '']]);
    sh.getRange(1, 1, rows.length, 3).setValues(rows);
    sh.getRange(1, 1, 1, 3).setFontWeight('bold');
    sh.getRange('C:C').setNumberFormat('@');
    sh.setFrozenRows(1);
    sh.setColumnWidth(2, 160);
    sh.setColumnWidth(3, 200);
  }
  return sh;
}

function peopleSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(PEOPLE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PEOPLE_SHEET);
    sh.getRange(1, 1, 1, 2).setValues([PEOPLE_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 220);
    sh.getRange(1, 3).setValue('Площадка: код (p1, p2) или название (Пром-1). Пусто — человек есть в списке всех площадок.');
  }
  return sh;
}

function controlSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(CONTROL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONTROL_SHEET);
    sh.getRange(1, 1, 1, CONTROL_HEADERS.length).setValues([CONTROL_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('@');
    sh.setColumnWidth(4, 150);
    sh.setColumnWidth(6, 260);
  } else if (String(sh.getRange(1, 7).getValue() || '').trim() === '') {
    // лист версии 2.1 без срока: добавляем столбец в конец
    sh.getRange(1, 7).setValue(CONTROL_HEADERS[6]).setFontWeight('bold');
  }
  return sh;
}

/** Лист «Доступ» → { list: [{code, name, key}], adminKey, anyKey }. Читается один раз за запрос. */
let ACCESS_ = null;
function readAccess_() {
  if (ACCESS_) return ACCESS_;
  const sh = accessSheet_();
  const last = sh.getLastRow();
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 3).getValues() : [];
  const out = { list: [], adminKey: '', anyKey: false };
  rows.forEach(function (r) {
    const code = String(r[0] || '').trim();
    const name = String(r[1] || '').trim();
    const k = String(r[2] || '').trim();
    if (!code) return;
    if (code.toLowerCase() === ADMIN || name.toLowerCase() === 'администратор') { out.adminKey = k; }
    else out.list.push({ code: code, name: name || code, key: k });
    if (k) out.anyKey = true;
  });
  if (!out.list.some(function (s) { return s.code === LEGACY_SITE; })) out.list.unshift({ code: LEGACY_SITE, name: 'Пром-1', key: '' });
  ACCESS_ = out;
  return out;
}

/** Код площадки по коду или названию из ячейки; пусто — Пром-1. */
function siteCode_(v, acc) {
  const s = String(v || '').trim();
  if (!s) return LEGACY_SITE;
  const list = (acc || readAccess_()).list;
  const low = s.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    if (list[i].code.toLowerCase() === low || list[i].name.toLowerCase() === low) return list[i].code;
  }
  return s;
}

function siteName_(code) {
  const s = readAccess_().list.filter(function (x) { return x.code === code; })[0];
  return s ? s.name : code;
}

function timeZone_() {
  try { return spreadsheet_().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }
  catch (e) { return Session.getScriptTimeZone(); }
}

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* папку удалили — создадим заново */ }
  }
  const found = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
  props.setProperty('ROOT_ID', folder.getId());
  return folder;
}

function subFolder_(parent, name) {
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

// ---------- действия ----------

/** Акты указанных площадок (неудалённые). */
function listActs_(sites) {
  if (!sites || !sites.length) return [];
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = timeZone_();
  const acc = readAccess_();
  const rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const acts = [];
  rows.forEach(function (r, i) {
    if (String(r[COL.deleted - 1] || '').trim()) return;
    const site = siteCode_(r[COL.site - 1], acc);
    if (sites.indexOf(site) < 0) return;
    const building = String(r[COL.building - 1]).trim().replace(/\.0+$/, '');
    const date = normDate_(r[COL.date - 1], tz);
    if (!validBuilding_(building) || !date) return;
    const ids = String(r[COL.fileIds - 1] || '').split(/[\s,;]+/).filter(String);
    const links = String(r[COL.links - 1] || '').split(/\s+/).filter(String);
    const uploaded = r[COL.uploaded - 1];
    acts.push({
      id: String(r[COL.id - 1] || '').trim() || 'row' + (i + 2),
      site: site,
      building: building,
      date: date,
      by: String(r[COL.by - 1] || ''),
      note: String(r[COL.note - 1] || ''),
      uploadedAt: isDate_(uploaded) ? uploaded.toISOString() : '',
      files: ids.map(function (fid, k) {
        return { id: fid, url: links[k] || 'https://drive.google.com/file/d/' + fid + '/view' };
      })
    });
  });
  return acts;
}

/** Список «Кто проверял» для площадок, которые открывает код. */
function listPeople_(acc) {
  const sh = peopleSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const all = readAccess_();
  const out = [];
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    const name = clean_(r[0], 80);
    if (!name) return;
    const raw = String(r[1] || '').trim();
    const site = raw ? siteCode_(raw, all) : '';
    if (site && acc.sites.indexOf(site) < 0) return;
    out.push({ name: name, site: site });
  });
  return out;
}

/** Текущий контроль по объектам: последняя строка листа «Контроль» для каждой пары «площадка + объект». */
function listControl_(sites) {
  if (!sites || !sites.length) return [];
  const sh = controlSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const acc = readAccess_();
  const cur = {};
  sh.getRange(2, 1, last - 1, CONTROL_HEADERS.length).getValues().forEach(function (r) {
    const site = siteCode_(r[0], acc);
    const building = String(r[1]).trim().replace(/\.0+$/, '');
    if (!building || sites.indexOf(site) < 0) return;
    const k = site + '|' + building;
    const c = cur[k] || (cur[k] = { site: site, building: building, on: null, at: '', by: '', note: '', days: null, daysAt: '', daysBy: '' });
    const at = isDate_(r[3]) ? r[3].toISOString() : String(r[3] || '');
    // «Контроль» и «Срок» меняются независимо: у каждого действует последняя непустая ячейка
    const v = String(r[2] == null ? '' : r[2]).trim().toLowerCase();
    if (v !== '') {
      c.on = !/^(выкл|выключен|нет|off|0|false|-)/.test(v);
      c.at = at; c.by = String(r[4] || ''); c.note = String(r[5] || '');
    }
    const d = String(r[6] == null ? '' : r[6]).trim().toLowerCase();
    if (d !== '') {
      const n = days_(d);
      c.days = n;  // «по умолч.», 0 или неверное число — общий срок
      c.daysAt = at; c.daysBy = String(r[4] || '');
    }
  });
  return Object.keys(cur).map(function (k) { return cur[k]; });
}

/** Срок акта в ячейке или запросе → целое 10–45 или null. */
function days_(v) {
  const n = Number(String(v == null ? '' : v).replace(',', '.').replace(/[^\d.]/g, ''));
  return isFinite(n) && Math.round(n) === n && n >= MIN_DAYS && n <= MAX_DAYS ? n : null;
}

/** Контроль АВР и срок акта по объекту — только код администратора.
 *  on: true/false — включить или выключить контроль; days: 10–45 — срок акта. Можно передать одно из двух. */
function setControl_(b, acc) {
  if (!acc.admin) throw fail_('forbidden', 'Включать и выключать контроль и менять срок может только администратор.');
  const site = siteCode_(b.site);
  allowed_(acc, site);
  const building = String(b.building || '').trim();
  if (!validBuilding_(building)) throw fail_('bad_request', 'Не указан объект.');
  const hasOn = b.on !== undefined && b.on !== null && b.on !== '';
  const hasDays = b.days !== undefined && b.days !== null && b.days !== '';
  if (!hasOn && !hasDays) throw fail_('bad_request', 'Не указано, что изменить.');
  const on = b.on === true || b.on === 'true' || b.on === 1 || b.on === '1';
  let days = null;
  if (hasDays) {
    days = days_(b.days);
    if (days === null) throw fail_('bad_request', 'Срок — от ' + MIN_DAYS + ' до ' + MAX_DAYS + ' дней.');
  }
  const by = clean_(b.by, 80) || 'Администратор';
  const note = hasOn ? clean_(b.note, 200) : '';
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const at = new Date();
    controlSheet_().appendRow([site, building, hasOn ? (on ? 'вкл' : 'выкл') : '', at, safe_(by), safe_(note), hasDays ? days : '']);
    const st = listControl_([site]).filter(function (c) { return c.building === building; })[0];
    return st || { site: site, building: building, on: hasOn ? on : null, at: at.toISOString(), by: by, note: note, days: days, daysAt: hasDays ? at.toISOString() : '', daysBy: hasDays ? by : '' };
  } finally {
    lock.releaseLock();
  }
}

function upload_(b, acc) {
  const site = siteCode_(b.site);
  allowed_(acc, site);
  const building = String(b.building || '').trim();
  if (!validBuilding_(building)) throw fail_('bad_request', 'Не указан номер здания.');
  const tz = timeZone_();
  const date = normDate_(b.date, tz);
  if (!date) throw fail_('bad_request', 'Укажите дату проверки.');
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 864e5), tz, 'yyyy-MM-dd');
  if (date > tomorrow) throw fail_('bad_request', 'Дата проверки не может быть в будущем.');
  const by = clean_(b.by, 80);
  if (!by) throw fail_('bad_request', 'Укажите, кто проверял.');
  const note = clean_(b.note, 300);
  const label = folderName_(b.label) || 'Корпус ' + building;
  const sname = folderName_(siteName_(site)) || folderName_(b.siteName) || site;
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.length) throw fail_('bad_request', 'Прикрепите хотя бы одно фото акта.');
  if (files.length > MAX_FILES) throw fail_('bad_request', 'В одном акте не больше ' + MAX_FILES + ' файлов.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const created = [];
  try {
    const folder = subFolder_(subFolder_(rootFolder_(), sname), label);
    const id = Utilities.getUuid().split('-')[0];
    files.forEach(function (f, i) {
      const mime = String(f.mimeType || '').toLowerCase();
      if (!/^(image\/[a-z0-9.+-]+|application\/pdf)$/.test(mime)) throw fail_('bad_request', 'Можно прикреплять только фото или PDF.');
      const bytes = Utilities.base64Decode(String(f.data || ''));
      if (!bytes.length) throw fail_('bad_request', 'Один из файлов пустой.');
      if (bytes.length > MAX_FILE_MB * 1024 * 1024) throw fail_('too_large', 'Файл больше ' + MAX_FILE_MB + ' МБ.');
      const name = label + ' — акт АВР ' + date + (files.length > 1 ? ' (' + (i + 1) + ')' : '') + ext_(mime);
      const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
      file.setDescription(['Акт проверки АВР', sname, label, 'дата проверки ' + date, 'проверял: ' + by, note, 'ID акта ' + id].filter(String).join(' · '));
      created.push(file);
    });
    const uploaded = new Date();
    sheet_().appendRow([
      id, uploaded, building, date, safe_(by), safe_(note),
      created.map(function (f) { return f.getUrl(); }).join('\n'),
      created.map(function (f) { return f.getId(); }).join(','),
      '', site
    ]);
    return {
      id: id, site: site, building: building, date: date, by: by, note: note,
      uploadedAt: uploaded.toISOString(),
      files: created.map(function (f) { return { id: f.getId(), url: f.getUrl() }; })
    };
  } catch (err) {
    created.forEach(function (f) { try { f.setTrashed(true); } catch (e) {} });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function getFile_(id, acc) {
  id = String(id || '');
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw fail_('bad_request', 'Некорректный файл.');
  // Отдаём только файлы из журнала актов доступных площадок — никакие другие файлы Диска страница получить не может.
  const known = listActs_(acc.sites).some(function (a) { return a.files.some(function (f) { return f.id === id; }); });
  if (!known) throw fail_('not_found', 'Файл не найден в журнале актов.');
  const file = DriveApp.getFileById(id);
  const blob = file.getBlob();
  return { name: file.getName(), mimeType: blob.getContentType(), url: file.getUrl(), data: Utilities.base64Encode(blob.getBytes()) };
}

function deleteAct_(id, by, acc) {
  id = String(id || '').trim();
  if (!id) throw fail_('bad_request', 'Не указан акт.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      const all = readAccess_();
      const rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][COL.id - 1]).trim() === id || 'row' + (i + 2) === id) {
          allowed_(acc, siteCode_(rows[i][COL.site - 1], all));
          const stamp = Utilities.formatDate(new Date(), timeZone_(), 'yyyy-MM-dd HH:mm');
          const who = clean_(by, 80);
          sh.getRange(i + 2, COL.deleted).setValue(safe_(stamp + (who ? ' — ' + who : '')));
          return id;
        }
      }
    }
    throw fail_('not_found', 'Акт не найден в журнале.');
  } finally {
    lock.releaseLock();
  }
}

// ---------- мелочи ----------

/** Номер объекта как на схеме: «12», «26а», «ДГУ ТП-43», «ДГУ зд. 66». */
function validBuilding_(s) {
  return /^[0-9a-zа-яё][0-9a-zа-яё .\-]{0,23}$/i.test(String(s || '')) && !/\s$/.test(String(s));
}

function folderName_(s) {
  return clean_(s, 40).replace(/[\/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Дата из ячейки или запроса → 'yyyy-MM-dd'. Понимает 2026-10-13, 13.10.2026 и даты таблицы. */
function normDate_(v, tz) {
  if (isDate_(v)) return Utilities.formatDate(v, tz || timeZone_(), 'yyyy-MM-dd');
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validYmd_(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return validYmd_(+m[3], +m[2], +m[1]);
  return '';
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function validYmd_(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Текст, начинающийся с = + - @, таблица приняла бы за формулу — экранируем апострофом. */
function safe_(s) {
  s = String(s || '');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ext_(mime) {
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic' || mime === 'image/heif') return '.heic';
  return '.jpg';
}
