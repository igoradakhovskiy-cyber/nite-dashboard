/**
 * Bitrix24 (nitecrm.bitrix24.com) → Google Sheets: выгрузка лидов и сделок NITE.
 *
 * Два листа:
 *  - «leads» — все лиды + последняя сделка, в которую конвертирован лид + «Валидный»: лид хоть раз
 *    доходил до Re-contact или Qualified (по истории стадий — после валидации лид часто уходит
 *    в «не дозвонились», но для оценки рекламы он остаётся валидным);
 *  - «deals» — все сделки, включая созданные напрямую без лида (у них свои UTM),
 *    + «дальше всего дошла» по системной истории стадий: проигранная сделка теряет стадию,
 *    а история помнит, была ли встреча или бронь.
 *
 * Как работает:
 *  - каждые 15 минут забирает лиды и сделки, изменённые с прошлого запуска, и обновляет строки
 *    по ID или дописывает новые;
 *  - раз в сутки (≈04:00) перезаливает оба листа целиком — ловит удалённые записи и
 *    переименованные стадии.
 *
 * Установка: Расширения → Apps Script → вставить этот файл → Сохранить → обновить таблицу →
 * меню «Bitrix24» → «Настроить». Ссылка вебхука хранится в свойствах скрипта, не в коде.
 *
 * Персональных данных (имя, телефон, email) в листах нет намеренно: дашборд читает таблицу
 * по ссылке, а ссылка = доступ для всех, у кого она есть.
 */

const SHEET_NAME = 'leads';
const DEALS_SHEET = 'deals';
const PORTAL = 'https://nitecrm.bitrix24.com';
const TZ = 'Europe/Kiev'; // как в рекламном кабинете AD_UA — дни сходятся с Meta
const QUAL_STATUS = 'CONVERTED'; // «კვალიფიციური / Qualified»
// Валидный лид (правило NITE от 19.10.2026): Re-contact — первая ступень квалификации
// («созвонились, активен, интересно»), Qualified — максимально вовлечён, из него создаётся сделка.
const VALID_STATUSES = ['UC_JKBEXL', 'CONVERTED'];
const INCREMENT_OVERLAP_MIN = 10;
const DICT_CACHE_KEY = 'dict_v2'; // сменить при изменении структуры словарей

// Колонки листов. Дашборд читает по индексу, поэтому новые колонки добавлять только в конец.
const COLUMNS = [
  ['ID', r => r.ID],
  ['Карточка', r => `${PORTAL}/crm/lead/details/${r.ID}/`],
  ['Создан', r => fmtDate(r.DATE_CREATE)],
  ['Изменён', r => fmtDate(r.DATE_MODIFY)],
  ['Стадия', (r, d) => d.status[r.STATUS_ID] || r.STATUS_ID],
  ['Код стадии', r => r.STATUS_ID],
  ['Итог стадии', r => ({ P: 'в работе', S: 'успех', F: 'провал' })[r.STATUS_SEMANTIC_ID] || r.STATUS_SEMANTIC_ID],
  ['Квал', r => (r.STATUS_ID === QUAL_STATUS ? 1 : 0)],
  ['Стадия сменена', r => fmtDate(r.MOVED_TIME)],
  ['Источник', (r, d) => d.source[r.SOURCE_ID] || r.SOURCE_ID],
  ['utm_source', r => r.UTM_SOURCE],
  ['utm_medium', r => r.UTM_MEDIUM],
  ['utm_campaign', r => r.UTM_CAMPAIGN],
  ['utm_content', r => r.UTM_CONTENT],
  ['utm_term (adset id)', r => r.UTM_TERM],
  ['utm_id (campaign id)', r => r.UF_CRM_UTMID],
  ['Форма', r => r.UF_CRM_FORMNAME],
  ['Проект', (r, d) => d.enumText('UF_CRM_1714533546265', r)],
  ['Язык', (r, d) => d.enumText('UF_CRM_1744106927708', r)],
  ['Страна', (r, d) => d.enumText('UF_CRM_1727297448372', r)],
  ['Квалификация', (r, d) => d.enumText('UF_CRM_1774525758634', r)],
  ['Бюджет', (r, d) => d.enumText('UF_CRM_1774525822944', r)],
  ['Цель покупки', (r, d) => d.enumText('UF_CRM_1714533852191', r)],
  ['Сроки', (r, d) => d.enumText('UF_CRM_1774525983801', r)],
  ['ЛПР', (r, d) => d.enumText('UF_CRM_1774525878125', r)],
  ['Причина отказа', (r, d) => d.enumText('UF_CRM_1774536958098', r)],
  ['Закрыт с этапа', (r, d) => d.enumText('UF_CRM_1744231140372', r)],
  ['Пройденные этапы', (r, d) => d.enumText('UF_CRM_1728117440812', r)],
  ['Статус сделки (поле лида)', (r, d) => d.enumText('UF_CRM_1727720168691', r)],
  ['Ответственный', (r, d) => d.user[r.ASSIGNED_BY_ID] || r.ASSIGNED_BY_ID],
  // сделка, в которую конвертирован лид (если их несколько — последняя)
  ['ID сделки', r => r.deal && r.deal.ID],
  ['Стадия сделки', (r, d) => r.deal && (d.dealStage[r.deal.STAGE_ID] || r.deal.STAGE_ID)],
  ['Итог сделки', r => r.deal && dealOutcome_(r.deal)],
  ['Стадия сделки сменена', r => r.deal && fmtDate(r.deal.MOVED_TIME)],
  ['Валидный', r => (r.validSince ? 1 : 0)],
  ['Валиден с', r => r.validSince && fmtDate(r.validSince)],
];

const DEAL_COLUMNS = [
  ['ID сделки', s => s.ID],
  ['Карточка', s => `${PORTAL}/crm/deal/details/${s.ID}/`],
  ['Создана', s => fmtDate(s.DATE_CREATE)],
  ['Изменена', s => fmtDate(s.DATE_MODIFY)],
  ['Стадия', (s, d) => d.dealStage[s.STAGE_ID] || s.STAGE_ID],
  ['Код стадии', s => s.STAGE_ID],
  ['Итог', s => dealOutcome_(s)],
  ['Стадия сменена', s => fmtDate(s.MOVED_TIME)],
  ['Дальше всего дошла', (s, d) => s.reach && (d.dealStage[s.reach.stage] || s.reach.stage)],
  ['Шаг воронки', s => s.reach && s.reach.step], // 1 = общая инфа … последний = продано
  ['Дошла (дата)', s => s.reach && fmtDate(s.reach.time)],
  ['Источник', (s, d) => d.source[s.SOURCE_ID] || s.SOURCE_ID],
  ['utm_source', s => s.UTM_SOURCE],
  ['utm_medium', s => s.UTM_MEDIUM],
  ['utm_campaign', s => s.UTM_CAMPAIGN],
  ['utm_content', s => s.UTM_CONTENT],
  ['utm_term (adset id)', s => s.UTM_TERM],
  ['utm_id (campaign id)', s => s.UF_CRM_6AC5FD08F1D60],
  ['Форма', s => s.UF_CRM_6AC5FD08AB5C6],
  ['ID лида', s => (isLinkedLead_(s) ? s.LEAD_ID : '')],
  ['Из лида', s => (isLinkedLead_(s) ? 'да' : 'нет')],
  ['Проект', (s, d) => d.enumText('UF_CRM_68B6F20085DB0', s)],
  ['Язык', (s, d) => d.enumText('UF_CRM_68B6F2016B3D8', s)],
  ['Страна', (s, d) => d.enumText('UF_CRM_68B6F200EEB98', s)],
  ['Квалификация', (s, d) => d.enumText('UF_CRM_69C51E73E0EB9', s)],
  ['Бюджет', (s, d) => d.enumText('UF_CRM_69C51E7415B90', s)],
  ['Цель покупки', (s, d) => d.enumText('UF_CRM_68B6F200AEFC5', s)],
  ['Сроки', (s, d) => d.enumText('UF_CRM_69C51E747AEC4', s)],
  ['Сумма', s => (Number(s.OPPORTUNITY) ? `${s.OPPORTUNITY} ${s.CURRENCY_ID || ''}`.trim() : '')],
  ['Ответственный', (s, d) => d.user[s.ASSIGNED_BY_ID] || s.ASSIGNED_BY_ID],
];

const SELECT = [
  'ID', 'DATE_CREATE', 'DATE_MODIFY', 'MOVED_TIME', 'STATUS_ID', 'STATUS_SEMANTIC_ID', 'SOURCE_ID',
  'ASSIGNED_BY_ID', 'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
  'UF_CRM_UTMID', 'UF_CRM_FORMNAME', 'UF_CRM_1714533546265', 'UF_CRM_1744106927708',
  'UF_CRM_1727297448372', 'UF_CRM_1774525758634', 'UF_CRM_1774525822944', 'UF_CRM_1714533852191',
  'UF_CRM_1774525983801', 'UF_CRM_1774525878125', 'UF_CRM_1774536958098', 'UF_CRM_1744231140372',
  'UF_CRM_1728117440812', 'UF_CRM_1727720168691',
];
const DEAL_SELECT = [
  'ID', 'LEAD_ID', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'MOVED_TIME', 'DATE_CREATE', 'DATE_MODIFY',
  'SOURCE_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'CURRENCY_ID',
  'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
  'UF_CRM_6AC5FD08F1D60', 'UF_CRM_6AC5FD08AB5C6', 'UF_CRM_68B6F20085DB0', 'UF_CRM_68B6F2016B3D8',
  'UF_CRM_68B6F200EEB98', 'UF_CRM_69C51E73E0EB9', 'UF_CRM_69C51E7415B90', 'UF_CRM_68B6F200AEFC5',
  'UF_CRM_69C51E747AEC4',
];
const HISTORY_SELECT = ['ID', 'OWNER_ID', 'STAGE_ID', 'CREATED_TIME', 'TYPE_ID'];
const LEAD_HISTORY_SELECT = ['ID', 'OWNER_ID', 'STATUS_ID', 'CREATED_TIME']; // у лидов стадия — STATUS_ID

// ───────────────────────── меню и установка ─────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bitrix24')
    .addItem('Настроить (вебхук + автообновление)', 'setup')
    .addItem('Обновить сейчас', 'syncLeads')
    .addItem('Перезалить всё', 'fullResync')
    .addToUi();
}

function setup() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Вебхук Bitrix24',
    'Вставь ссылку входящего вебхука, вида https://nitecrm.bitrix24.com/rest/123/abc.../',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  let hook = res.getResponseText().trim();
  if (!/^https:\/\/[\w.-]+\/rest\/\d+\/\w+\/?/.test(hook)) {
    ui.alert('Это не похоже на ссылку вебхука. Нужна ссылка из «Входящий вебхук» → «Вебхук для вызова REST API».');
    return;
  }
  hook = hook.replace(/(\/rest\/\d+\/\w+).*$/, '$1/');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('BITRIX_HOOK', hook);

  const probe = bx('crm.lead.list', { select: ['ID'] });
  const probeDeals = bx('crm.deal.list', { select: ['ID'] });
  fullResync();

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncLeads').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('fullResync').timeBased().everyDays(1).atHour(4).create();

  ui.alert(`Готово. Вебхук видит лидов: ${probe.total}, сделок: ${probeDeals.total}. Листы «${SHEET_NAME}» и ` +
    `«${DEALS_SHEET}» залиты, обновление каждые 15 минут, полная перезаливка ночью.`);
}

// ───────────────────────── синхронизация ─────────────────────────

/** Инкремент: лиды и сделки, изменённые с прошлого запуска. Обновляет строки по ID, новые дописывает. */
function syncLeads() {
  withLock(() => {
    const props = PropertiesService.getScriptProperties();
    const last = props.getProperty('LAST_MODIFY');
    // новая версия скрипта с другим набором колонок → сначала перезаливаем листы целиком
    const ss = SpreadsheetApp.getActive();
    const leadsSheet = ss.getSheetByName(SHEET_NAME);
    const dealsSheet = ss.getSheetByName(DEALS_SHEET);
    const layoutChanged = !leadsSheet || !dealsSheet ||
      leadsSheet.getLastColumn() !== COLUMNS.length || dealsSheet.getLastColumn() !== DEAL_COLUMNS.length;
    if (!last || layoutChanged) return fullResync_();

    const since = new Date(new Date(last).getTime() - INCREMENT_OVERLAP_MIN * 60000).toISOString();
    const leads = bxAll('crm.lead.list', {
      select: SELECT,
      filter: { '>=DATE_MODIFY': since },
      order: { DATE_MODIFY: 'ASC' },
    });
    const changedDeals = bxAll('crm.deal.list', {
      select: DEAL_SELECT,
      filter: { '>=DATE_MODIFY': since },
    });

    // лиды, у которых сдвинулась только сделка, а сам лид не менялся
    const have = new Set(leads.map(l => String(l.ID)));
    const extraIds = [...new Set(changedDeals.filter(isLinkedLead_).map(d => String(d.LEAD_ID)).filter(id => !have.has(id)))];
    chunks_(extraIds, 50).forEach(ids => {
      leads.push(...bxAll('crm.lead.list', { select: SELECT, filter: { ID: ids } }));
    });
    if (!leads.length && !changedDeals.length) return touch_(props);

    const leadDeals = [];
    chunks_(leads.map(l => l.ID), 50).forEach(ids => {
      leadDeals.push(...bxAll('crm.deal.list', { select: DEAL_SELECT, filter: { LEAD_ID: ids } }));
    });
    attachDeals_(leads, leadDeals);

    const leadHistory = [];
    chunks_(leads.map(l => l.ID), 50).forEach(ids => {
      leadHistory.push(...bxAll('crm.stagehistory.list', {
        entityTypeId: 1, select: LEAD_HISTORY_SELECT, filter: { OWNER_ID: ids, STATUS_ID: VALID_STATUSES },
      }));
    });
    attachValid_(leads, leadHistory);

    const history = [];
    chunks_(changedDeals.map(d => d.ID), 50).forEach(ids => {
      history.push(...bxAll('crm.stagehistory.list', { entityTypeId: 2, select: HISTORY_SELECT, filter: { OWNER_ID: ids } }));
    });

    const dict = loadDictionaries_(leads.concat(changedDeals));
    attachReach_(changedDeals, history, dict);
    upsert_(getSheet_(SHEET_NAME), COLUMNS, leads, dict);
    upsert_(getSheet_(DEALS_SHEET), DEAL_COLUMNS, changedDeals, dict);

    props.setProperty('LAST_MODIFY', maxModify_(leads.concat(changedDeals), last));
    touch_(props);
  });
}

/** Полная перезаливка обоих листов. */
function fullResync() {
  withLock(fullResync_);
}

function fullResync_() {
  const leads = bxAll('crm.lead.list', { select: SELECT, order: { ID: 'ASC' } });
  const deals = bxAll('crm.deal.list', { select: DEAL_SELECT, order: { ID: 'ASC' } });
  const history = bxAll('crm.stagehistory.list', { entityTypeId: 2, select: HISTORY_SELECT, order: { ID: 'ASC' } });
  const leadHistory = bxAll('crm.stagehistory.list', {
    entityTypeId: 1, select: LEAD_HISTORY_SELECT, filter: { STATUS_ID: VALID_STATUSES }, order: { ID: 'ASC' },
  });
  attachDeals_(leads, deals);
  attachValid_(leads, leadHistory);
  const dict = loadDictionaries_(leads.concat(deals));
  attachReach_(deals, history, dict);

  writeAll_(getSheet_(SHEET_NAME), COLUMNS, leads, dict);
  writeAll_(getSheet_(DEALS_SHEET), DEAL_COLUMNS, deals, dict);

  const props = PropertiesService.getScriptProperties();
  props.setProperty('LAST_MODIFY', maxModify_(leads.concat(deals), new Date(0).toISOString()));
  touch_(props);
}

/** К каждому лиду — его сделка; если сделок несколько, берём последнюю (больший ID). */
function attachDeals_(leads, deals) {
  const byLead = {};
  deals.filter(isLinkedLead_).forEach(d => {
    const cur = byLead[d.LEAD_ID];
    if (!cur || Number(d.ID) > Number(cur.ID)) byLead[d.LEAD_ID] = d;
  });
  leads.forEach(l => (l.deal = byLead[l.ID] || null));
}

/** «Валиден с»: когда лид впервые попал в Re-contact или Qualified (история, иначе текущая стадия). */
function attachValid_(leads, leadHistory) {
  const first = {};
  leadHistory
    .filter(h => VALID_STATUSES.includes(h.STATUS_ID))
    .forEach(h => {
      if (!first[h.OWNER_ID] || new Date(h.CREATED_TIME) < new Date(first[h.OWNER_ID])) first[h.OWNER_ID] = h.CREATED_TIME;
    });
  leads.forEach(l => {
    l.validSince = first[l.ID] || (VALID_STATUSES.includes(l.STATUS_ID) ? l.MOVED_TIME || l.DATE_MODIFY : null);
  });
}

/**
 * «Дальше всего дошла»: самая поздняя «положительная» стадия (в работе или продано) из истории.
 * Стадии-причины проигрыша не считаются. Запись о создании сделки в системной стадии NEW не
 * считается этой стадией: в NITE «NEW» = «встреча назначена», и часть сделок создавалась сразу в
 * ней по умолчанию — такую сделку засчитываем как первый шаг воронки.
 */
function attachReach_(deals, history, dict) {
  const byDeal = {};
  history.forEach(h => (byDeal[h.OWNER_ID] = byDeal[h.OWNER_ID] || []).push(h));
  deals.forEach(deal => {
    const hs = (byDeal[deal.ID] || []).slice().sort((a, b) => Number(a.ID) - Number(b.ID));
    let best = null;
    const consider = (stage, time) => {
      const m = dict.dealMeta[stage];
      if (!m || !m.step) return;
      if (!best || m.step > best.step) best = { stage, step: m.step, time };
    };
    hs.forEach(h => {
      const m = dict.dealMeta[h.STAGE_ID];
      if (Number(h.TYPE_ID) === 1 && m && m.step > 1 && /(^|:)NEW$/.test(h.STAGE_ID)) {
        consider(m.firstStage, h.CREATED_TIME);
      } else {
        consider(h.STAGE_ID, h.CREATED_TIME);
      }
    });
    if (!hs.length) consider(deal.STAGE_ID, deal.MOVED_TIME || deal.DATE_CREATE);
    deal.reach = best;
  });
}

// ───────────────────────── словари ─────────────────────────

function loadDictionaries_(items) {
  const cache = CacheService.getScriptCache();
  let base = cache.get(DICT_CACHE_KEY);
  if (base) {
    base = JSON.parse(base);
  } else {
    const statuses = bxAll('crm.status.list', {}); // все справочники разом: стадии лидов, источники, стадии сделок
    const pick = test => Object.fromEntries(statuses.filter(s => test(s.ENTITY_ID)).map(s => [s.STATUS_ID, s.NAME]));
    const isDealStage = e => /^DEAL_STAGE(_\d+)?$/.test(e);

    // шаг воронки: порядковый номер среди «положительных» стадий своей воронки, по SORT
    const dealMeta = {};
    const byEntity = {};
    statuses.filter(s => isDealStage(s.ENTITY_ID)).forEach(s => (byEntity[s.ENTITY_ID] = byEntity[s.ENTITY_ID] || []).push(s));
    Object.values(byEntity).forEach(list => {
      const positive = list
        .filter(s => ['process', 'success'].includes((s.EXTRA && s.EXTRA.SEMANTICS) || ''))
        .sort((a, b) => Number(a.SORT) - Number(b.SORT));
      const first = positive.length ? positive[0].STATUS_ID : null;
      list.forEach(s => {
        const step = positive.findIndex(p => p.STATUS_ID === s.STATUS_ID) + 1;
        dealMeta[s.STATUS_ID] = { step, firstStage: first };
      });
    });

    // только поля, которые выгружаем: у сделок сотни полей рассрочки, кэш их не вместит
    const used = new Set(SELECT.concat(DEAL_SELECT));
    const enums = {};
    [bx('crm.lead.fields', {}).result, bx('crm.deal.fields', {}).result].forEach(fields => {
      Object.keys(fields).forEach(code => {
        if (used.has(code) && fields[code].items) {
          enums[code] = {};
          fields[code].items.forEach(i => (enums[code][i.ID] = i.VALUE));
        }
      });
    });
    base = {
      status: pick(e => e === 'STATUS'),
      source: pick(e => e === 'SOURCE'),
      dealStage: pick(isDealStage),
      dealMeta,
      enums,
    };
    try {
      cache.put(DICT_CACHE_KEY, JSON.stringify(base), 6 * 3600);
    } catch (e) {
      // словарь больше лимита кэша (100 КБ) — просто перечитаем в следующий раз
    }
  }

  const userIds = [...new Set(items.map(x => x.ASSIGNED_BY_ID).filter(Boolean))];
  const user = {};
  if (userIds.length) {
    try {
      chunks_(userIds, 50).forEach(ids => {
        bxAll('user.get', { filter: { ID: ids } })
          .forEach(u => (user[u.ID] = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ')));
      });
    } catch (e) {
      // нет права «Пользователи» у вебхука — оставляем ID
    }
  }

  return {
    status: base.status,
    source: base.source,
    dealStage: base.dealStage,
    dealMeta: base.dealMeta,
    user,
    enumText(code, item) {
      const v = item[code];
      const list = Array.isArray(v) ? v : v ? [v] : [];
      return list.map(id => (base.enums[code] || {})[id] || id).join(', ');
    },
  };
}

// ───────────────────────── листы ─────────────────────────

function writeAll_(sheet, columns, items, dict) {
  const rows = items.map(x => toRow_(columns, x, dict));
  sheet.clearContents();
  sheet.getRange(1, 1, 1, columns.length).setValues([columns.map(c => c[0])]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (rows.length) {
    // текстом, иначе Google превратит 18-значный adset id в число и обрежет его
    sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, rows.length), columns.length).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, columns.length).setValues(rows);
  }
}

function upsert_(sheet, columns, items, dict) {
  if (!items.length) return;
  const ids = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(r => String(r[0]))
    : [];
  const rowById = new Map(ids.map((id, i) => [id, i + 2]));
  const seen = new Set();
  const appended = [];
  items.forEach(x => {
    if (seen.has(String(x.ID))) return;
    seen.add(String(x.ID));
    const row = toRow_(columns, x, dict);
    const at = rowById.get(String(x.ID));
    if (at) sheet.getRange(at, 1, 1, row.length).setValues([row]);
    else appended.push(row);
  });
  if (appended.length) {
    appended.sort((a, b) => Number(a[0]) - Number(b[0]));
    sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, columns.length)
      .setNumberFormat('@')
      .setValues(appended);
  }
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name, name === SHEET_NAME ? 0 : ss.getSheets().length);
}

// ───────────────────────── Bitrix REST ─────────────────────────

function bx(method, params) {
  const hook = PropertiesService.getScriptProperties().getProperty('BITRIX_HOOK');
  if (!hook) throw new Error('Вебхук не задан: меню Bitrix24 → Настроить');
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = UrlFetchApp.fetch(`${hook}${method}.json`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(params || {}),
      muteHttpExceptions: true,
    });
    const body = JSON.parse(resp.getContentText() || '{}');
    if (body.error === 'QUERY_LIMIT_EXCEEDED' || resp.getResponseCode() === 503) {
      Utilities.sleep(1000 * (attempt + 1));
      continue;
    }
    if (body.error) throw new Error(`Bitrix ${method}: ${body.error} ${body.error_description || ''}`);
    return body;
  }
  throw new Error(`Bitrix ${method}: лимит запросов, попробуем в следующий запуск`);
}

/** Все страницы списка (Bitrix отдаёт по 50). crm.stagehistory.list кладёт строки в result.items. */
function bxAll(method, params) {
  let out = [];
  let start = 0;
  while (start !== undefined) {
    const page = bx(method, Object.assign({}, params, { start }));
    const rows = Array.isArray(page.result) ? page.result : (page.result && page.result.items) || [];
    out = out.concat(rows);
    start = page.next;
    if (start !== undefined) Utilities.sleep(300); // лимит Bitrix ~2 запроса/с
  }
  return out;
}

// ───────────────────────── мелочи ─────────────────────────

function toRow_(columns, item, dict) {
  return columns.map(([, get]) => {
    const v = get(item, dict);
    return v === null || v === undefined ? '' : String(v);
  });
}

function dealOutcome_(deal) {
  return ({ P: 'в работе', S: 'продано', F: 'провал' })[deal.STAGE_SEMANTIC_ID] || deal.STAGE_SEMANTIC_ID;
}

/** Bitrix отдаёт LEAD_ID строкой, и у сделок без лида это "0", а не пусто. */
function isLinkedLead_(deal) {
  return Boolean(deal.LEAD_ID) && String(deal.LEAD_ID) !== '0';
}

function fmtDate(iso) {
  return iso ? Utilities.formatDate(new Date(iso), TZ, 'yyyy-MM-dd HH:mm') : '';
}

function maxModify_(items, fallback) {
  return items.reduce((max, x) => (x.DATE_MODIFY && new Date(x.DATE_MODIFY) > new Date(max) ? x.DATE_MODIFY : max), fallback);
}

function chunks_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function touch_(props) {
  props.setProperty('LAST_RUN', new Date().toISOString());
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // предыдущий запуск ещё идёт
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}
