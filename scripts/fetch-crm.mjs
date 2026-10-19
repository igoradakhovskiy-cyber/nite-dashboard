#!/usr/bin/env node
/**
 * CRM layer from Google Sheets — Nite / Bitrix24.
 *
 * Source: the "NITE — лиды из Bitrix24" sheet, tab `leads`, which an Apps Script
 * (scripts/bitrix-leads-to-sheets.gs, bound to the sheet) refreshes from the
 * nitecrm.bitrix24.com webhook every 15 minutes.
 *
 * Runs AFTER fetch-meta.mjs: reads .data/latest.json, pulls the CRM export from
 * the sheet tab, joins it onto the Meta data by UTM, and writes the `crm` block
 * back into the same file.
 *
 * Join: every ad carries utm_campaign={{campaign.name}}, utm_content={{ad.name}},
 * utm_term={{adset.id}} and utm_id={{campaign.id}}. Campaigns are matched by id
 * first (survives renames) and by name as a fallback; ads by name; ad sets by id.
 *
 * Qual = the sheet's «Валидный» column: the lead has been in Re-contact or
 * Qualified at least once (NITE rule agreed 19.10.2026). That rule only holds for
 * leads from CRM_MIN_DATE on — earlier managers ran the CRM differently — so older
 * rows are dropped here and the UI divides only post-cutoff spend by quals.
 *
 * The sheet is readable by link, so this is a plain unauthenticated fetch of the
 * gviz CSV export — no OAuth, no service account, no API key. If the sheet is ever
 * made private this script fails loudly and the fallback is a service account +
 * Sheets API with the JSON key in a GitHub Secret.
 *
 * Local dry run without link sharing: CRM_CSV_FILE=path/to/leads.csv reads the
 * export from disk instead of the network.
 *
 * No npm deps — Node 18+ global fetch only.
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_FILE = path.join(ROOT, '.data', 'latest.json')

// ---------------------------------------------------------------- config ----
// No default on purpose: the inherited default pointed at another project's sheet,
// and a dashboard that quietly joins someone else's leads is worse than one that
// refuses to run.
const SHEET_ID = process.env.SHEET_ID
if (!SHEET_ID) {
  console.error('✖ SHEET_ID env is required — this project has no CRM sheet configured yet')
  process.exit(1)
}
const SHEET_TAB = process.env.SHEET_TAB || 'leads'
/** First lead date the qual rule applies to (NITE, agreed with the current manager). */
const CRM_MIN_DATE = process.env.CRM_MIN_DATE || '2026-10-14'
const CRM_CSV_FILE = process.env.CRM_CSV_FILE || ''
const VERIFY = process.argv.includes('--verify')
/** Local runs abort on a bad sheet; CI keeps the last good layer and deploys anyway. */
const STRICT = process.argv.includes('--strict')
/** Live dashboard, used to recover the previously deployed CRM layer as a baseline. */
const DASHBOARD_URL =
  process.env.DASHBOARD_URL || 'https://igoradakhovskiy-cyber.github.io/nite-dashboard/'
/**
 * A filter left on the sheet drops `rows_total` off a cliff — 3118 → 33 on
 * 27.07.2026, which killed the whole deploy for two days. Anything past this
 * much shrinkage is breakage, never organic: rows are only ever appended.
 */
const ROWS_DROP_LIMIT = 0.4

/**
 * Layout of the `leads` tab written by bitrix-leads-to-sheets.gs. The Apps Script only
 * ever appends columns at the end, so these indexes are stable.
 *
 * Columns are addressed BY INDEX, not by header name, on purpose: the sheet has two
 * different quality columns — «Квалификация» (index 20, the manager's hot/warm/cold
 * field, mostly empty) and «Валидный» (index 34, the rule we report). A name lookup
 * would one day grab the wrong one.
 */
const COL = {
  date: 2, // C  Создан                 YYYY-MM-DD HH:mm (Europe/Kiev)
  status: 5, // F  Код стадии             Bitrix STATUS_ID
  campaign: 12, // M  utm_campaign           = {{campaign.name}}
  ad: 13, // N  utm_content            = {{ad.name}}
  adset: 14, // O  utm_term (adset id)    = {{adset.id}}
  campaignId: 15, // P  utm_id (campaign id)   = {{campaign.id}}
  country: 19, // T  Страна
  qual: 34, // AI Валидный               "1" | "0"   ← the one we want
}

/** Header cells that must match exactly, or the tab/layout changed under us. */
const EXPECTED_HEADER = {
  2: 'Создан',
  5: 'Код стадии',
  12: 'utm_campaign',
  13: 'utm_content',
  14: 'utm_term (adset id)',
  15: 'utm_id (campaign id)',
  19: 'Страна',
  34: 'Валидный',
}

/**
 * Bitrix lead STATUS_ID → ladder label. Numbered in Bitrix pipeline order; losses carry
 * "×" so the UI sorts them below the ladder. Keep in sync with STATUS_ORDER in src/config.ts.
 */
const STATUS_LABEL = {
  NEW: '01. Новый',
  IN_PROCESS: '02. Messengers',
  UC_8QBXXF: '03. BASE',
  PROCESSED: '04. Не дозвонились 1 раз',
  UC_EY2ISH: '05. Не дозвонились 2 раза',
  UC_PT6TPS: '06. Не дозвонились 3 раза',
  UC_JKBEXL: '07. Re-contact',
  CONVERTED: '08. Qualified',
  2: '× Не дозвонились',
  JUNK: '× Нецелевой',
  UC_M1CKOJ: '× Неверный номер',
  9: '× Дубль / спам / тест',
  12: '× Не рассматривает покупку',
  13: '× Нет контактных данных',
  3: '× Другое',
}

// ------------------------------------------------------------- utilities ----
/** RFC4180-ish CSV parser: handles quoted fields, escaped quotes and embedded newlines. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const cell = (row, i) => (row[i] === undefined ? '' : String(row[i]).trim())
/** Join keys are compared case-insensitively — Meta sometimes lowercases macro output. */
const norm = (s) => String(s || '').trim().toLowerCase()

/** "2026-10-14 15:23" -> "2026-10-14"; returns null on anything else. */
function toIso(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(stamp).trim())
  return m ? m[1] : null
}

function bump(map, key, qual) {
  let v = map.get(key)
  if (!v) {
    v = { leads: 0, qual: 0 }
    map.set(key, v)
  }
  v.leads++
  if (qual) v.qual++
}

/**
 * Last successfully deployed CRM layer, read back out of the live dashboard's own
 * encrypted blob.
 *
 * The alternative — committing a baseline file from CI — needs `contents: write`
 * and pushes a commit every three hours. The deployed artefact is already the
 * authoritative "last good state", costs no permissions, and self-heals: once a
 * healthy run deploys, the next run's baseline is that healthy run.
 *
 * Returns null whenever anything at all goes wrong. A missing baseline must
 * degrade to "no drop check", never to a failed build.
 */
async function loadDeployedBaseline() {
  const password = process.env.DASHBOARD_PASSWORD
  if (!password) return null
  try {
    const res = await fetch(new URL('data/latest.enc', DASHBOARD_URL))
    if (!res.ok) return null
    const blob = await res.json()
    const key = crypto.pbkdf2Sync(password, Buffer.from(blob.salt, 'base64'), blob.iter, 32, 'sha256')
    const ct = Buffer.from(blob.ct, 'base64')
    const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'))
    // encrypt-data.mjs appends the 16-byte GCM tag to the ciphertext
    dec.setAuthTag(ct.subarray(ct.length - 16))
    const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()])
    const prev = JSON.parse(plain.toString('utf8'))
    return prev.crm || null
  } catch {
    return null
  }
}

/** "1 строка / 3 строки / 33 строки / 3118 строк" — these strings go straight into the UI. */
function plural(n, one, few, many) {
  const m100 = n % 100
  if (m100 >= 11 && m100 <= 14) return `${n} ${many}`
  const m10 = n % 10
  if (m10 === 1) return `${n} ${one}`
  if (m10 >= 2 && m10 <= 4) return `${n} ${few}`
  return `${n} ${many}`
}
const rowsRu = (n) => plural(n, 'строку', 'строки', 'строк')

/**
 * Names the failure instead of just detecting one. Returns null when healthy.
 *
 * The distinction that matters: a *truncated source* (rows vanished, but the ones
 * left still join fine) and a *broken join* (rows are there, they stopped
 * matching) look identical to a plain match-rate floor, and have opposite fixes.
 */
function diagnose({ baseline, rowsTotal, inWindow, rate }) {
  const prev = baseline && baseline.rows_total
  if (prev && rowsTotal < prev * (1 - ROWS_DROP_LIMIT)) {
    const lost = prev - rowsTotal
    return {
      reason: 'source_truncated',
      message:
        `Таблица CRM отдала ${rowsRu(rowsTotal)} вместо ${prev} — пропало ${lost} ` +
        `(−${(((prev - rowsTotal) / prev) * 100).toFixed(0)}%). Строки в эту выгрузку только добавляются, ` +
        'так что это не естественная убыль.',
      hint:
        `Почти наверняка на вкладке "${SHEET_TAB}" оставлен фильтр: экспорт Google Sheets отдаёт ` +
        'только видимые строки. Снимите фильтр (Данные → Отключить фильтр) и нажмите «Обновить данные».',
    }
  }
  if (!inWindow) {
    return {
      reason: 'no_rows_in_window',
      message: `В окне дашборда нет ни одной строки CRM (в таблице всего ${rowsRu(rowsTotal)}).`,
      hint:
        `Проверьте фильтр на вкладке "${SHEET_TAB}", формат дат в колонке C «Создан» ` +
        `и CRM_MIN_DATE (${CRM_MIN_DATE}).`,
    }
  }
  if (rate < 50) {
    return {
      reason: 'join_broken',
      message: `Склейка CRM с Meta ${rate.toFixed(1)}% — ниже порога 50%.`,
      hint:
        'Строки на месте, но не сходятся по UTM. Проверьте, что в объявлениях остались ' +
        'utm_campaign={{campaign.name}}, utm_content={{ad.name}}, utm_id={{campaign.id}}, ' +
        'и что Tilda передаёт UTM в Bitrix.',
    }
  }
  return null
}

// ------------------------------------------------------------------- main ---
async function main() {
  if (!existsSync(DATA_FILE)) {
    throw new Error('.data/latest.json not found — run fetch-meta.mjs first')
  }
  const ds = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'))
  const baseline = await loadDeployedBaseline()
  if (baseline) {
    console.log(
      `▶ Baseline from live dashboard: ${baseline.rows_total} sheet rows, ` +
        `${baseline.rows_matched} matched (${baseline.fetched_at})`,
    )
  } else {
    console.log('▶ No baseline available (first run, or dashboard unreachable) — drop check skipped')
  }

  let csv
  if (CRM_CSV_FILE) {
    console.log(`▶ CRM from local file ${CRM_CSV_FILE} (dry run, sheet not fetched)`)
    csv = await fs.readFile(CRM_CSV_FILE, 'utf8')
  } else {
    const url =
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
      `?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`
    // never the full id: Actions logs of this repo are public and the sheet is open by link
    console.log(`▶ CRM sheet …${SHEET_ID.slice(-6)} · tab "${SHEET_TAB}"`)

    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) {
      throw new Error(
        `sheet fetch failed: HTTP ${res.status}. ` +
          'If link sharing was turned off, switch to a service account + Sheets API.',
      )
    }
    csv = await res.text()
  }
  const rows = parseCsv(csv).filter((r) => r.some((c) => String(c).trim() !== ''))
  if (!rows.length) throw new Error('sheet returned no rows')

  // ---- header validation ----------------------------------------------------
  // Critical: gviz does NOT 404 on a wrong tab name — it silently serves the FIRST
  // tab instead. Without this check the pipeline would happily encrypt garbage.
  const hdr = rows[0]
  const bad = Object.entries(EXPECTED_HEADER).filter(([i, name]) => cell(hdr, Number(i)) !== name)
  if (bad.length) {
    console.error('✖ unexpected header — wrong tab, or the sheet layout changed.')
    console.error(`  got: ${hdr.slice(0, 17).map((h, i) => `${i}:${h}`).join(' | ')}`)
    for (const [i, name] of bad) {
      console.error(`  col ${i}: expected "${name}", got "${cell(hdr, Number(i))}"`)
    }
    throw new Error('CRM header validation failed')
  }
  const body = rows.slice(1)
  console.log(`  ${body.length} data rows`)

  // ---- lookups from the Meta side -------------------------------------------
  const campById = new Map(ds.campaigns.map((c) => [String(c.id), c]))
  const campByName = new Map(ds.campaigns.map((c) => [norm(c.name), c]))
  const adsetIds = new Set(ds.adsets.map((s) => String(s.id)))
  const adNameByNorm = new Map() // normalised ad name -> canonical ad name (creative key)
  for (const a of ds.ads) if (!adNameByNorm.has(norm(a.name))) adNameByNorm.set(norm(a.name), a.name)

  // The CRM window starts at the later of the Meta window and the qual-rule cutoff.
  const MIN = ds.date_min > CRM_MIN_DATE ? ds.date_min : CRM_MIN_DATE
  const MAX = ds.date_max

  // ---- aggregate -------------------------------------------------------------
  const daily = new Map() // `${date}|${campaign_id}|${adset_id}|${ad_key}` -> {leads,qual}
  const status = new Map() // `${date}|${status}` -> n
  const geo = new Map() // `${date}|${country}` -> {leads,qual}
  const unmatched = {
    macro: 0, // {{campaign.name}} / {{ad.name}} — Meta never substituted the macro
    unknown_campaign: 0, // campaign not in the dashboard window (older flights)
    unknown_ad: 0, // campaign matched but the ad no longer exists in the account
    no_utm: 0,
    bad_date: 0,
    out_of_window: 0,
    examples: {},
  }
  const noteExample = (bucket, value) => {
    const arr = (unmatched.examples[bucket] ||= [])
    if (value && arr.length < 5 && !arr.includes(value)) arr.push(value)
  }

  let inWindow = 0
  let matched = 0
  let qualTotal = 0

  for (const r of body) {
    const iso = toIso(cell(r, COL.date))
    if (!iso) {
      unmatched.bad_date++
      continue
    }
    if (iso < MIN || iso > MAX) {
      unmatched.out_of_window++
      continue
    }
    inWindow++

    const rawCamp = cell(r, COL.campaign)
    const rawCampId = cell(r, COL.campaignId)
    const rawAdset = cell(r, COL.adset)
    const rawAd = cell(r, COL.ad)
    const isQual = cell(r, COL.qual) === '1'

    // WhatsApp / calls / office visits carry no UTM at all — not ad traffic.
    if (!rawCamp && !rawAd && !rawCampId) {
      unmatched.no_utm++
      continue
    }
    if (rawCamp.includes('{{') || rawAd.includes('{{')) {
      unmatched.macro++
      noteExample('macro', rawCamp || rawAd)
      continue
    }

    const camp = campById.get(rawCampId) || campByName.get(norm(rawCamp))
    if (!camp) {
      // Leads from campaigns outside the Meta window (or another account) are
      // excluded on purpose: their spend is not in the dataset, so counting their
      // quals would make CPQL wrong. They surface in the diagnostics chip instead.
      unmatched.unknown_campaign++
      noteExample('unknown_campaign', rawCamp || rawCampId)
      continue
    }
    const adsetId = adsetIds.has(rawAdset) ? rawAdset : ''

    const adKey = adNameByNorm.get(norm(rawAd)) || null
    if (!adKey) {
      unmatched.unknown_ad++
      noteExample('unknown_ad', rawAd)
      // still counted at campaign level — only the creative gallery misses it
    }

    matched++
    if (isQual) qualTotal++
    bump(daily, `${iso}|${camp.id}|${adsetId}|${adKey || ''}`, isQual)

    // campaign_id rides along so the UI can filter these blocks by language too
    const code = cell(r, COL.status)
    const st = code ? STATUS_LABEL[code] || code : ''
    if (st) {
      const k = `${iso}|${camp.id}|${st}`
      status.set(k, (status.get(k) || 0) + 1)
    }

    const country = cell(r, COL.country)
    if (country && country !== '—') bump(geo, `${iso}|${camp.id}|${country}`, isQual)
  }

  const crm = {
    source: 'google_sheets',
    sheet_id: SHEET_ID,
    tab: SHEET_TAB,
    fetched_at: new Date().toISOString(),
    date_min: MIN,
    rows_total: body.length,
    rows_in_window: inWindow,
    rows_matched: matched,
    qual_total: qualTotal,
    daily: [...daily.entries()]
      .map(([k, v]) => {
        const [date, campaign_id, adset_id, ad_key] = k.split('|')
        return {
          date,
          campaign_id,
          adset_id: adset_id || null,
          ad_key: ad_key || null,
          leads: v.leads,
          qual: v.qual,
        }
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    status: [...status.entries()]
      .map(([k, n]) => {
        const [date, campaign_id, name] = k.split('|')
        return { date, campaign_id, status: name, n }
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    geo: [...geo.entries()]
      .map(([k, v]) => {
        const [date, campaign_id, country] = k.split('|')
        return { date, campaign_id, country, leads: v.leads, qual: v.qual }
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    unmatched,
  }

  // ---- cross-check -----------------------------------------------------------
  // Measured against Meta inside the CRM window only — the whole-window lead count
  // would make a healthy join after the cutoff look like a broken one.
  const metaInWindow = ds.daily.filter((r) => r.date >= MIN && r.date <= MAX)
  const metaLeads = metaInWindow.reduce((s, r) => s + r.leads, 0)
  const metaSpend = metaInWindow.reduce((s, r) => s + r.spend, 0)
  const rate = metaLeads ? (matched / metaLeads) * 100 : 0
  console.log('\n──── CRM cross-check ────')
  console.log(`  window            ${MIN} → ${MAX}`)
  console.log(`  rows in window    ${inWindow}`)
  console.log(`  matched to Meta   ${matched}  (${rate.toFixed(1)}% of ${metaLeads} Meta leads)`)
  console.log(`  qualified         ${qualTotal}  (${matched ? ((qualTotal / matched) * 100).toFixed(1) : 0}% of matched)`)
  console.log(`  CPQL              $${qualTotal ? (metaSpend / qualTotal).toFixed(2) : '—'}`)
  console.log(
    `  unmatched         macro ${unmatched.macro} · unknown campaign ${unmatched.unknown_campaign} · ` +
      `unknown ad ${unmatched.unknown_ad} · no utm ${unmatched.no_utm}`,
  )

  // ---- health --------------------------------------------------------------
  // Ordered most-specific first: a truncated sheet also fails the match-rate
  // check, and "someone left a filter on" is a far more actionable message than
  // "the UTM join is broken" — which is what sent this pipeline down the wrong
  // trail for two days.
  const problem = diagnose({ baseline, rowsTotal: body.length, inWindow, rate })

  if (problem && STRICT) throw new Error(problem.message)

  if (problem && baseline) {
    // Freeze: keep the last good CRM layer, let today's fresh Meta data deploy.
    console.error(`\n⚠ ${problem.message}`)
    console.error(`  → keeping the CRM layer from ${baseline.fetched_at} and deploying anyway.`)
    console.error('  → Meta metrics are unaffected and stay live.')
    ds.crm = {
      ...baseline,
      health: {
        ok: false,
        stale: true,
        reason: problem.reason,
        message: problem.message,
        hint: problem.hint,
        checked_at: new Date().toISOString(),
        frozen_at: baseline.fetched_at,
        rows_total: body.length,
        baseline_rows_total: baseline.rows_total,
        match_rate: Number(rate.toFixed(1)),
      },
    }
  } else if (problem) {
    // No baseline to fall back on: ship the bad layer but flag it hard, so the
    // dashboard shows a warning instead of quietly presenting a wrong CPQL.
    console.error(`\n⚠ ${problem.message}`)
    console.error('  → no baseline to fall back on; publishing with a warning banner.')
    crm.health = {
      ok: false,
      stale: false,
      reason: problem.reason,
      message: problem.message,
      hint: problem.hint,
      checked_at: new Date().toISOString(),
      frozen_at: null,
      rows_total: body.length,
      baseline_rows_total: baseline ? baseline.rows_total : null,
      match_rate: Number(rate.toFixed(1)),
    }
    ds.crm = crm
  } else {
    crm.health = {
      ok: true,
      stale: false,
      reason: 'ok',
      message: null,
      hint: null,
      checked_at: new Date().toISOString(),
      frozen_at: null,
      rows_total: body.length,
      baseline_rows_total: baseline ? baseline.rows_total : null,
      match_rate: Number(rate.toFixed(1)),
    }
    ds.crm = crm
  }

  await fs.writeFile(DATA_FILE, JSON.stringify(ds, null, 2))
  console.log(`\n✔ Wrote crm block into ${path.relative(ROOT, DATA_FILE)} (health: ${ds.crm.health.ok ? 'ok' : ds.crm.health.reason})`)
  if (problem) return

  // ---- frozen expectations (opt-in, --verify) --------------------------------
  // Not run in CI: the sheet grows daily, so these numbers drift by design.
  // They exist to prove the join on the snapshot it was built against.
  if (VERIFY) {
    const byCamp = new Map()
    const byAd = new Map()
    for (const r of crm.daily) {
      bumpN(byCamp, r.campaign_id, r.leads, r.qual)
      if (r.ad_key) bumpN(byAd, r.ad_key, r.leads, r.qual)
    }
    // Counted independently from the Bitrix export on 19.10.2026 ~18:40 (Kyiv), before
    // this join existed: 26 FB leads since 14.10 = 26 Meta leads, 8 of them valid.
    const camp = (prefix) => ds.campaigns.find((c) => c.name.startsWith(prefix))?.id
    const expect = [
      ['matched to Meta', matched, 26],
      ['qualified (matched)', qualTotal, 8],
      ['069 leads', byCamp.get(camp('069_'))?.leads, 16],
      ['069 qualified', byCamp.get(camp('069_'))?.qual, 5],
      ['070 leads', byCamp.get(camp('070_'))?.leads, 10],
      ['070 qualified', byCamp.get(camp('070_'))?.qual, 3],
      ['001_45 leads', byAd.get('001_45')?.leads, 11],
      ['001_45 qualified', byAd.get('001_45')?.qual, 3],
      ['004_150k leads', byAd.get('004_150k')?.leads, 11],
      ['004_150k qualified', byAd.get('004_150k')?.qual, 3],
    ]
    console.log('\n──── --verify against the 19.10.2026 snapshot ────')
    let failed = 0
    for (const [label, got, want] of expect) {
      const ok = got === want
      if (!ok) failed++
      console.log(`  ${ok ? '✔' : '✖'} ${label}: got ${got}, expected ${want}`)
    }
    if (failed) throw new Error(`${failed} frozen expectation(s) failed`)
    console.log('  all frozen expectations hold')
  }
}

function bumpN(map, key, leads, qual) {
  let v = map.get(key)
  if (!v) {
    v = { leads: 0, qual: 0 }
    map.set(key, v)
  }
  v.leads += leads
  v.qual += qual
}

main().catch((e) => {
  console.error('✖ CRM pipeline failed:', e.message)
  process.exit(1)
})
