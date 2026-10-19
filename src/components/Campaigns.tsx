import { useState } from 'react'
import type { CrmDaily, DailyRow, Dataset, Metrics } from '../types'
import { aggregate, groupBy, type CrmBucket, type Index } from '../lib/data'
import { Card, SectionTitle, LangBadge } from './ui'
import { int, money, moneySmart, pct } from '../lib/format'
import { assetUrl, COLORS, langColor } from '../config'

interface Group {
  id: string
  rows: DailyRow[]
  m: Metrics
}

function rankGroups(rows: DailyRow[], keyFn: (r: DailyRow) => string | undefined): Group[] {
  const g = groupBy(rows, keyFn)
  return [...g.entries()]
    .map(([id, rs]) => ({ id, rows: rs, m: aggregate(rs) }))
    .sort((a, b) => b.m.spend - a.m.spend)
}

/**
 * Quals resolve at the campaign and ad levels always, and at the ad-set level only when
 * the CRM export carries the ad set id (utm_term) — otherwise that row honestly shows "—".
 */
function Cells({ m, crm, hasCrm }: { m: Metrics; crm?: CrmBucket; hasCrm: boolean }) {
  return (
    <div className="flex items-center gap-2 tabular text-sm shrink-0">
      <span className="w-20 sm:w-24 text-right text-ink font-medium">{money(m.spend)}</span>
      <span className="w-12 text-right text-ink">{int(m.leads)}</span>
      <span className="w-16 text-right text-mute">{moneySmart(m.cpl)}</span>
      {hasCrm && (
        <span
          className="w-12 text-right font-medium"
          style={{ color: crm?.qual ? COLORS.qual : COLORS.dim }}
        >
          {crm ? int(crm.qual) : '—'}
        </span>
      )}
      {hasCrm && (
        <span className="hidden sm:inline w-16 text-right text-mute">
          {crm?.qual ? moneySmart(m.spend_crm / crm.qual) : '—'}
        </span>
      )}
      <span className="hidden sm:inline w-14 text-right text-dim">{pct(m.ctr)}</span>
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      className="text-dim text-xs transition-transform w-3 inline-block"
      style={{ transform: open ? 'rotate(90deg)' : 'none' }}
    >
      ▸
    </span>
  )
}

export default function Campaigns({
  ds,
  idx,
  rows,
  crmRows,
}: {
  ds: Dataset
  idx: Index
  rows: DailyRow[]
  crmRows: CrmDaily[] | null
}) {
  const [openCamp, setOpenCamp] = useState<string | null>(null)
  const [openAdset, setOpenAdset] = useState<string | null>(null)

  const camps = rankGroups(rows, (r) => idx.adById.get(r.ad_id)?.campaign_id)
  const maxSpend = Math.max(1, ...camps.map((c) => c.m.spend))
  const hasCrm = !!crmRows

  // campaign_id -> bucket, adset_id -> bucket, and `campaign_id|ad name` -> bucket
  const byCamp = new Map<string, CrmBucket>()
  const byAdset = new Map<string, CrmBucket>()
  const byCampAd = new Map<string, CrmBucket>()
  const add = (target: Map<string, CrmBucket>, key: string, r: CrmDaily) => {
    const b = target.get(key) || { leads: 0, qual: 0 }
    b.leads += r.leads
    b.qual += r.qual
    target.set(key, b)
  }
  for (const r of crmRows || []) {
    add(byCamp, r.campaign_id, r)
    if (r.adset_id) add(byAdset, r.adset_id, r)
    if (r.ad_key) add(byCampAd, `${r.campaign_id}|${r.ad_key}`, r)
  }
  const hasAdsetCrm = !!ds.crm?.daily.some((r) => r.adset_id)

  return (
    <section>
      <SectionTitle
        title="Кампании"
        subtitle={
          'Клик по кампании → адсеты → объявления. Сортировка по расходу.' +
          (hasCrm && !hasAdsetCrm ? ' В выгрузке CRM нет адсета, поэтому квалы там — прочерк.' : '')
        }
        right={
          <div className="hidden sm:flex items-center gap-2 text-[11px] uppercase tracking-wide text-dim">
            <span className="w-20 sm:w-24 text-right">Расход</span>
            <span className="w-12 text-right">Лиды</span>
            <span className="w-16 text-right">CPL</span>
            {hasCrm && <span className="w-12 text-right">Квалы</span>}
            {hasCrm && <span className="w-16 text-right">CPQL</span>}
            <span className="w-14 text-right">CTR</span>
          </div>
        }
      />
      <Card className="p-1.5 sm:p-2">
        <div className="divide-y divide-line2">
          {camps.map((c) => {
            const camp = idx.campById.get(c.id)
            const open = openCamp === c.id
            const w = (c.m.spend / maxSpend) * 100
            return (
              <div key={c.id}>
                <button
                  onClick={() => {
                    setOpenCamp(open ? null : c.id)
                    setOpenAdset(null)
                  }}
                  className="relative w-full text-left group"
                >
                  <div
                    className="absolute inset-y-1 left-0 rounded-md"
                    style={{ width: `${w}%`, background: (camp ? langColor(camp.lang) : COLORS.mute) + '14' }}
                  />
                  <div className="relative flex items-center gap-3 px-2.5 py-2.5">
                    <Chevron open={open} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-ink font-medium" title={camp?.name}>
                          {camp?.name || c.id}
                        </span>
                        {camp && <LangBadge lang={camp.lang} />}
                      </div>
                    </div>
                    <Cells m={c.m} crm={byCamp.get(c.id)} hasCrm={hasCrm} />
                  </div>
                </button>

                {open && (
                  <div className="pb-2">
                    <AdsetList
                      idx={idx}
                      rows={c.rows}
                      openAdset={openAdset}
                      setOpenAdset={setOpenAdset}
                      byAdset={hasAdsetCrm ? byAdset : null}
                      byCampAd={byCampAd}
                      hasCrm={hasCrm}
                    />
                  </div>
                )}
              </div>
            )
          })}
          {camps.length === 0 && (
            <div className="py-6 text-center text-dim text-sm">Нет данных за выбранный период</div>
          )}
        </div>
      </Card>
    </section>
  )
}

function AdsetList({
  idx,
  rows,
  openAdset,
  setOpenAdset,
  byAdset,
  byCampAd,
  hasCrm,
}: {
  idx: Index
  rows: DailyRow[]
  openAdset: string | null
  setOpenAdset: (v: string | null) => void
  /** null when the CRM export has no ad set — the row then shows "—" */
  byAdset: Map<string, CrmBucket> | null
  byCampAd: Map<string, CrmBucket>
  hasCrm: boolean
}) {
  const adsets = rankGroups(rows, (r) => idx.adById.get(r.ad_id)?.adset_id)
  return (
    <div className="ml-4 pl-3 border-l border-line2 space-y-0.5">
      {adsets.map((s) => {
        const adset = idx.adsetById.get(s.id)
        const open = openAdset === s.id
        return (
          <div key={s.id}>
            <button
              onClick={() => setOpenAdset(open ? null : s.id)}
              className="w-full text-left flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-card2/60"
            >
              <Chevron open={open} />
              <span className="min-w-0 flex-1 truncate text-sm text-mute" title={adset?.name}>
                {adset?.name || s.id}
              </span>
              <Cells m={s.m} crm={byAdset ? byAdset.get(s.id) : undefined} hasCrm={hasCrm} />
            </button>
            {open && <AdList idx={idx} rows={s.rows} byCampAd={byCampAd} hasCrm={hasCrm} />}
          </div>
        )
      })}
    </div>
  )
}

function AdList({
  idx,
  rows,
  byCampAd,
  hasCrm,
}: {
  idx: Index
  rows: DailyRow[]
  byCampAd: Map<string, CrmBucket>
  hasCrm: boolean
}) {
  const ads = rankGroups(rows, (r) => r.ad_id)
  return (
    <div className="ml-4 pl-3 border-l border-line2 space-y-0.5 py-1">
      {ads.map((a) => {
        const ad = idx.adById.get(a.id)
        const crm = ad ? byCampAd.get(`${ad.campaign_id}|${ad.name}`) : undefined
        return (
          <div key={a.id} className="flex items-center gap-3 px-2 py-1.5">
            <span className="w-3" />
            {ad?.creative.poster ? (
              <img
                src={assetUrl(ad.creative.poster)}
                alt=""
                className="h-8 w-[18px] rounded object-cover border border-line shrink-0"
                loading="lazy"
              />
            ) : (
              <span className="h-8 w-[18px] rounded bg-card2 border border-line shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm text-mute" title={ad?.name}>
              {ad?.name || a.id}
            </span>
            <Cells m={a.m} crm={crm} hasCrm={hasCrm} />
          </div>
        )
      })}
    </div>
  )
}
