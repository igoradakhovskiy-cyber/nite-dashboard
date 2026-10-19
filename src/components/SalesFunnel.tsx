import type { Dataset } from '../types'
import type { Filters, Index } from '../lib/data'
import { statusLadder } from '../lib/data'
import { Card, SectionTitle, InfoDot } from './ui'
import { int, pct } from '../lib/format'
import { COLORS, STATUS_ORDER } from '../config'

const HINT =
  'Стадии лидов в Bitrix за выбранный период. Это состояние на сейчас, а не путь лида: ' +
  'лид виден только в той стадии, где стоит сегодня. Поэтому квалов в KPI может быть больше, ' +
  'чем лидов в Re-contact и Qualified: квал засчитывается и тому, кто был в Re-contact, а потом ушёл.'

/** Colour ramp: cold grey at the top of the pipeline → green at the qualified stages. */
const TINT: Record<string, string> = {
  '01. Новый': COLORS.impressions,
  '02. Messengers': COLORS.ctr,
  '03. BASE': COLORS.dim,
  '04. Не дозвонились 1 раз': COLORS.dim,
  '05. Не дозвонились 2 раза': COLORS.dim,
  '06. Не дозвонились 3 раза': COLORS.dim,
  '07. Re-contact': COLORS.qual,
  '08. Qualified': COLORS.gold,
}

/** Terminal loss — the pipeline prefixes these with "×"; tinted red, below the ladder. */
const isLost = (s: string) => s.startsWith('×')

export default function SalesFunnel({
  ds,
  idx,
  filters,
}: {
  ds: Dataset
  idx: Index
  filters: Filters
}) {
  const ladder = statusLadder(ds, idx, filters, STATUS_ORDER)
  const total = ladder.reduce((s, r) => s + r.n, 0)
  const max = Math.max(1, ...ladder.map((r) => r.n))

  return (
    <Card className="p-5">
      <SectionTitle
        title="Стадии лидов"
        subtitle={`${int(total)} лидов из рекламы в CRM за период`}
        right={<InfoDot text={HINT} />}
      />

      {ladder.length === 0 ? (
        <div className="py-6 text-center text-dim text-sm">Нет лидов за период</div>
      ) : (
        <div className="space-y-2">
          {ladder.map((r, i) => {
            const lost = isLost(r.status)
            const firstLost = lost && !isLost(ladder[i - 1]?.status || '')
            const color = TINT[r.status] || (lost ? COLORS.neg : COLORS.mute)
            return (
              <div
                key={r.status}
                className={`flex items-center gap-3 ${firstLost ? 'pt-2 mt-1 border-t border-line2' : ''}`}
              >
                <span className="w-36 shrink-0 truncate text-xs text-mute" title={r.status}>
                  {r.status}
                </span>
                <div className="h-6 flex-1 rounded-md bg-card2 overflow-hidden">
                  <div
                    className="h-full rounded-md"
                    style={{
                      width: `${Math.max(2, (r.n / max) * 100)}%`,
                      background: `linear-gradient(90deg, ${color}cc, ${color}66)`,
                    }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right tabular text-sm font-medium text-ink">
                  {int(r.n)}
                </span>
                <span className="w-12 shrink-0 text-right tabular text-xs text-dim">
                  {pct(total ? (r.n / total) * 100 : 0, 1)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
