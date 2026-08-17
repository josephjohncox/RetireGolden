import { addCalendarMonths } from '../actions/civilDate.js'
import type { EquityGrant, EquityPlan, EquityTransaction } from '../model/plan.js'

const EPSILON = 1e-9
const QSBS_BASE_EXCLUSION_LIMIT = 10_000_000

interface EquityLotState {
  id: string
  grantId: string
  companyId: string
  instrument: EquityGrant['instrument']
  grantDate: string | null
  acquisitionDate: string
  remainingShares: number
  regularBasisPerShare: number
  amtBasisPerShare: number
  exerciseFmvPerShare: number | null
  qsbsEligibility: 'eligible' | 'ineligible' | 'unknown'
}

export interface EquityHoldingSnapshot {
  lotId: string
  grantId: string
  companyId: string
  instrument: EquityGrant['instrument']
  acquisitionDate: string
  remainingShares: number
  regularBasis: number
  amtBasis: number
  qsbsEligibility: 'eligible' | 'ineligible' | 'unknown'
}

export interface EquityTransactionActivity {
  transactionId: string
  type: EquityTransaction['type']
  date: string
  cashOutlay: number
  grossProceeds: number
  netProceeds: number
  ordinaryIncome: number
  shortTermCapitalGain: number
  longTermCapitalGain: number
  federalExcludedGain: number
  stateCapitalGainAddback: number
  amtAdjustment: number
}

export interface EquityYearLedger {
  year: number
  cashOutlay: number
  cashProceeds: number
  ordinaryIncome: number
  shortTermCapitalGain: number
  longTermCapitalGain: number
  federalExcludedGain: number
  stateCapitalGainAddback: number
  amtAdjustment: number
  activities: EquityTransactionActivity[]
  holdings: EquityHoldingSnapshot[]
  warnings: string[]
}

export interface EquityTransactionLedger {
  byYear: Map<number, EquityYearLedger>
  warnings: string[]
}

function emptyYear(year: number): EquityYearLedger {
  return {
    year,
    cashOutlay: 0,
    cashProceeds: 0,
    ordinaryIncome: 0,
    shortTermCapitalGain: 0,
    longTermCapitalGain: 0,
    federalExcludedGain: 0,
    stateCapitalGainAddback: 0,
    amtAdjustment: 0,
    activities: [],
    holdings: [],
    warnings: [],
  }
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4))
}

function onOrAfterAnniversary(date: string, start: string, months: number): boolean {
  const anniversary = addCalendarMonths(start, months)
  return anniversary !== null && date >= anniversary
}

function qsbsExclusionFraction(acquisitionDate: string): number {
  if (acquisitionDate >= '2010-09-28') return 1
  if (acquisitionDate >= '2009-02-18') return 0.75
  return 0.5
}

function holdingSnapshot(lots: Map<string, EquityLotState>): EquityHoldingSnapshot[] {
  return [...lots.values()]
    .filter((lot) => lot.remainingShares > EPSILON)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((lot) => ({
      lotId: lot.id,
      grantId: lot.grantId,
      companyId: lot.companyId,
      instrument: lot.instrument,
      acquisitionDate: lot.acquisitionDate,
      remainingShares: lot.remainingShares,
      regularBasis: lot.remainingShares * lot.regularBasisPerShare,
      amtBasis: lot.remainingShares * lot.amtBasisPerShare,
      qsbsEligibility: lot.qsbsEligibility,
    }))
}

function addActivity(year: EquityYearLedger, activity: EquityTransactionActivity): void {
  year.cashOutlay += activity.cashOutlay
  year.cashProceeds += activity.netProceeds
  year.ordinaryIncome += activity.ordinaryIncome
  year.shortTermCapitalGain += activity.shortTermCapitalGain
  year.longTermCapitalGain += activity.longTermCapitalGain
  year.federalExcludedGain += activity.federalExcludedGain
  year.stateCapitalGainAddback += activity.stateCapitalGainAddback
  year.amtAdjustment += activity.amtAdjustment
  year.activities.push(activity)
}

/**
 * Compile deterministic private-company transactions into annual cash and tax
 * facts. The plan parser has already proved lot identity, chronology, and share
 * availability; this module owns tax character and never accepts a caller-
 * supplied ordinary/LTCG/QSBS split.
 */
export function buildEquityTransactionLedger(equity: EquityPlan): EquityTransactionLedger {
  const grants = new Map(equity.grants.map((grant) => [grant.id, grant]))
  const lots = new Map<string, EquityLotState>()
  const byYear = new Map<number, EquityYearLedger>()
  const warnings = new Set<string>()
  const qsbsExcludedByCompany = new Map<string, number>()

  for (const grant of equity.grants) {
    for (const opening of grant.openingLots) {
      lots.set(opening.id, {
        id: opening.id,
        grantId: grant.id,
        companyId: grant.companyId,
        instrument: grant.instrument,
        grantDate: grant.grantDate,
        acquisitionDate: opening.acquisitionDate,
        remainingShares: opening.shares,
        regularBasisPerShare: opening.regularBasisPerShare,
        amtBasisPerShare: opening.amtBasisPerShare ?? opening.regularBasisPerShare,
        exerciseFmvPerShare: null,
        qsbsEligibility: opening.qsbsEligibility,
      })
    }
  }

  const transactions = equity.transactions
    .map((transaction, index) => ({ transaction, index }))
    .sort((left, right) =>
      left.transaction.date.localeCompare(right.transaction.date) ||
      left.index - right.index,
    )

  for (const { transaction } of transactions) {
    const yearNumber = yearOf(transaction.date)
    const year = byYear.get(yearNumber) ?? emptyYear(yearNumber)
    byYear.set(yearNumber, year)

    if (transaction.type === 'exercise') {
      const grant = grants.get(transaction.grantId)!
      const strikeCost = grant.strikePrice * transaction.shares
      let ordinaryIncome = 0
      let amtAdjustment = 0
      let regularBasisPerShare = grant.strikePrice
      let amtBasisPerShare = grant.strikePrice
      if (transaction.fmvPerShare === null) {
        warnings.add(
          `ISO exercise ${transaction.id} has no exercise-date FMV; its bargain element and AMT adjustment are omitted.`,
        )
        year.warnings.push(
          `Exercise-date FMV is unknown for ${transaction.id}; AMT is incomplete.`,
        )
      } else if (grant.instrument === 'iso') {
        const spread = Math.max(0, transaction.fmvPerShare - grant.strikePrice)
        amtAdjustment = spread * transaction.shares
        amtBasisPerShare = Math.max(grant.strikePrice, transaction.fmvPerShare)
      } else {
        const spread = Math.max(0, transaction.fmvPerShare - grant.strikePrice)
        ordinaryIncome = spread * transaction.shares
        regularBasisPerShare = Math.max(grant.strikePrice, transaction.fmvPerShare)
        amtBasisPerShare = regularBasisPerShare
      }
      lots.set(transaction.lotId, {
        id: transaction.lotId,
        grantId: grant.id,
        companyId: grant.companyId,
        instrument: grant.instrument,
        grantDate: grant.grantDate,
        acquisitionDate: transaction.date,
        remainingShares: transaction.shares,
        regularBasisPerShare,
        amtBasisPerShare,
        exerciseFmvPerShare: transaction.fmvPerShare,
        qsbsEligibility: 'unknown',
      })
      addActivity(year, {
        transactionId: transaction.id,
        type: transaction.type,
        date: transaction.date,
        cashOutlay: strikeCost + transaction.transactionCost,
        grossProceeds: 0,
        netProceeds: 0,
        ordinaryIncome,
        shortTermCapitalGain: 0,
        longTermCapitalGain: 0,
        federalExcludedGain: 0,
        stateCapitalGainAddback: 0,
        amtAdjustment,
      })
      continue
    }

    if (transaction.type === 'vest') {
      const grant = grants.get(transaction.grantId)!
      const ordinaryIncome = transaction.fmvPerShare * transaction.shares
      lots.set(transaction.lotId, {
        id: transaction.lotId,
        grantId: grant.id,
        companyId: grant.companyId,
        instrument: grant.instrument,
        grantDate: grant.grantDate,
        acquisitionDate: transaction.date,
        remainingShares: transaction.shares,
        regularBasisPerShare: transaction.fmvPerShare,
        amtBasisPerShare: transaction.fmvPerShare,
        exerciseFmvPerShare: transaction.fmvPerShare,
        qsbsEligibility: 'ineligible',
      })
      addActivity(year, {
        transactionId: transaction.id,
        type: transaction.type,
        date: transaction.date,
        cashOutlay: transaction.transactionCost,
        grossProceeds: 0,
        netProceeds: 0,
        ordinaryIncome,
        shortTermCapitalGain: 0,
        longTermCapitalGain: 0,
        federalExcludedGain: 0,
        stateCapitalGainAddback: 0,
        amtAdjustment: 0,
      })
      continue
    }

    const totalShares = transaction.dispositions.reduce(
      (sum, disposition) => sum + disposition.shares,
      0,
    )
    const grossProceeds = totalShares * transaction.pricePerShare
    let ordinaryIncome = 0
    let shortTermCapitalGain = 0
    let longTermCapitalGain = 0
    let federalExcludedGain = 0
    let stateCapitalGainAddback = 0
    let amtAdjustment = 0

    for (const disposition of transaction.dispositions) {
      const lot = lots.get(disposition.lotId)!
      const proceeds = disposition.shares * transaction.pricePerShare
      const sellingCost = totalShares > 0
        ? transaction.transactionCost * (disposition.shares / totalShares)
        : 0
      const netProceeds = proceeds - sellingCost
      const regularBasis = disposition.shares * lot.regularBasisPerShare
      const amtBasis = disposition.shares * lot.amtBasisPerShare
      let regularGain = netProceeds - regularBasis
      const longTerm = onOrAfterAnniversary(transaction.date, lot.acquisitionDate, 12)

      if (lot.instrument === 'iso') {
        const grantHoldingMet = lot.grantDate !== null &&
          onOrAfterAnniversary(transaction.date, lot.grantDate, 24)
        const qualifyingDisposition = longTerm && grantHoldingMet
        if (!qualifyingDisposition && regularGain > 0) {
          if (lot.exerciseFmvPerShare === null) {
            warnings.add(
              `ISO lot ${lot.id} lacks exercise-date FMV; disqualifying-disposition ordinary income cannot be computed.`,
            )
            year.warnings.push(
              `ISO disposition tax character is incomplete for lot ${lot.id}.`,
            )
          } else {
            const bargainElement = Math.max(
              0,
              lot.exerciseFmvPerShare - lot.regularBasisPerShare,
            ) * disposition.shares
            const compensation = Math.min(regularGain, bargainElement)
            ordinaryIncome += compensation
            regularGain -= compensation
          }
        }
        // Form 6251 basis differs from regular basis after an ISO exercise.
        // The signed adjustment reverses prior preference when the stock sells.
        amtAdjustment += regularBasis - amtBasis
      }

      if (longTerm && regularGain > 0 && lot.qsbsEligibility === 'eligible') {
        if (onOrAfterAnniversary(transaction.date, lot.acquisitionDate, 60)) {
          const priorExcluded = qsbsExcludedByCompany.get(lot.companyId) ?? 0
          const remainingBaseLimit = Math.max(
            0,
            QSBS_BASE_EXCLUSION_LIMIT - priorExcluded,
          )
          const exclusionLimit = Math.max(
            remainingBaseLimit,
            regularBasis * 10,
          )
          const excluded = Math.min(
            regularGain * qsbsExclusionFraction(lot.acquisitionDate),
            exclusionLimit,
          )
          regularGain -= excluded
          federalExcludedGain += excluded
          stateCapitalGainAddback += excluded
          qsbsExcludedByCompany.set(lot.companyId, priorExcluded + excluded)
        }
      } else if (
        longTerm &&
        regularGain > 0 &&
        lot.qsbsEligibility === 'unknown' &&
        onOrAfterAnniversary(transaction.date, lot.acquisitionDate, 60)
      ) {
        warnings.add(
          `Equity lot ${lot.id} has an unknown QSBS determination; no exclusion was claimed.`,
        )
        year.warnings.push(`QSBS eligibility is unknown for lot ${lot.id}.`)
      }

      if (longTerm) longTermCapitalGain += regularGain
      else shortTermCapitalGain += regularGain
      lot.remainingShares -= disposition.shares
    }

    addActivity(year, {
      transactionId: transaction.id,
      type: transaction.type,
      date: transaction.date,
      cashOutlay: 0,
      grossProceeds,
      netProceeds: Math.max(0, grossProceeds - transaction.transactionCost),
      ordinaryIncome,
      shortTermCapitalGain,
      longTermCapitalGain,
      federalExcludedGain,
      stateCapitalGainAddback,
      amtAdjustment,
    })
  }

  const years = [...byYear.keys()].sort((left, right) => left - right)
  for (const year of years) {
    // Rebuild the year-end quantity from the transaction history because the
    // final lot map has already consumed sales from later years.
    const throughYearLots = new Map(
      [...lots.entries()]
        .filter(([, lot]) => yearOf(lot.acquisitionDate) <= year)
        .map(([lotId, lot]) => {
          const futureSold = transactions
            .filter(({ transaction }) =>
              transaction.type === 'sale' && yearOf(transaction.date) > year,
            )
            .flatMap(({ transaction }) =>
              transaction.type === 'sale' ? transaction.dispositions : [],
            )
            .filter((disposition) => disposition.lotId === lot.id)
            .reduce((sum, disposition) => sum + disposition.shares, 0)
          const restored: EquityLotState = {
            ...lot,
            remainingShares: lot.remainingShares + futureSold,
          }
          return [lotId, restored] as const
        }),
    )
    byYear.get(year)!.holdings = holdingSnapshot(throughYearLots)
  }

  return { byYear, warnings: [...warnings] }
}
