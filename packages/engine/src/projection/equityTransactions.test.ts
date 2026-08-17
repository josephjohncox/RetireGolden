import { describe, expect, it } from 'vitest'

import type { EquityPlan } from '../model/plan.js'
import { buildEquityTransactionLedger } from './equityTransactions.js'

function isoPlan(): EquityPlan {
  return {
    grants: [
      {
        id: 'iso-grant',
        companyId: 'company',
        companyName: 'Company',
        ownerPersonId: 'person',
        instrument: 'iso',
        shares: 100,
        grantDate: '2024-01-01',
        strikePrice: 10,
        vestingSchedule: [],
        openingLots: [],
      },
    ],
    transactions: [
      {
        type: 'exercise',
        id: 'exercise',
        date: '2026-01-02',
        grantId: 'iso-grant',
        shares: 100,
        fmvPerShare: 30,
        transactionCost: 0,
        lotId: 'iso-lot',
      },
      {
        type: 'sale',
        id: 'sale',
        date: '2028-01-03',
        pricePerShare: 50,
        transactionCost: 0,
        dispositions: [{ lotId: 'iso-lot', shares: 100 }],
      },
    ],
  }
}

describe('native equity transaction ledger', () => {
  it('creates an ISO lot, sends the bargain element to AMT, and reverses AMT basis at sale', () => {
    const ledger = buildEquityTransactionLedger(isoPlan())
    const exercise = ledger.byYear.get(2026)!
    const sale = ledger.byYear.get(2028)!

    expect(exercise.cashOutlay).toBe(1_000)
    expect(exercise.ordinaryIncome).toBe(0)
    expect(exercise.amtAdjustment).toBe(2_000)
    expect(exercise.holdings).toEqual([
      expect.objectContaining({
        lotId: 'iso-lot',
        remainingShares: 100,
        regularBasis: 1_000,
        amtBasis: 3_000,
      }),
    ])

    expect(sale.cashProceeds).toBe(5_000)
    expect(sale.longTermCapitalGain).toBe(4_000)
    expect(sale.shortTermCapitalGain).toBe(0)
    expect(sale.ordinaryIncome).toBe(0)
    expect(sale.amtAdjustment).toBe(-2_000)
    expect(sale.holdings).toEqual([])
  })

  it('taxes an NSO bargain element as ordinary income and only post-exercise appreciation as STCG', () => {
    const equity: EquityPlan = {
      grants: [
        {
          id: 'nso-grant',
          companyId: 'company',
          companyName: 'Company',
          ownerPersonId: 'person',
          instrument: 'nso',
          shares: 100,
          grantDate: '2025-01-01',
          strikePrice: 10,
          vestingSchedule: [],
          openingLots: [],
        },
      ],
      transactions: [
        {
          type: 'exercise',
          id: 'exercise',
          date: '2026-01-02',
          grantId: 'nso-grant',
          shares: 100,
          fmvPerShare: 30,
          transactionCost: 0,
          lotId: 'nso-lot',
        },
        {
          type: 'sale',
          id: 'sale',
          date: '2026-06-01',
          pricePerShare: 40,
          transactionCost: 0,
          dispositions: [{ lotId: 'nso-lot', shares: 100 }],
        },
      ],
    }

    const year = buildEquityTransactionLedger(equity).byYear.get(2026)!
    expect(year.cashOutlay).toBe(1_000)
    expect(year.cashProceeds).toBe(4_000)
    expect(year.ordinaryIncome).toBe(2_000)
    expect(year.shortTermCapitalGain).toBe(1_000)
    expect(year.longTermCapitalGain).toBe(0)
  })

  it('applies a five-year QSBS exclusion federally and adds it back for a nonconforming state', () => {
    const equity: EquityPlan = {
      grants: [
        {
          id: 'common-grant',
          companyId: 'company',
          companyName: 'Company',
          ownerPersonId: 'person',
          instrument: 'common',
          shares: 100,
          grantDate: '2020-01-01',
          strikePrice: 0,
          vestingSchedule: [],
          openingLots: [
            {
              id: 'common-lot',
              shares: 100,
              acquisitionDate: '2020-01-02',
              regularBasisPerShare: 1,
              amtBasisPerShare: 1,
              qsbsEligibility: 'eligible',
            },
          ],
        },
      ],
      transactions: [
        {
          type: 'sale',
          id: 'sale',
          date: '2026-01-03',
          pricePerShare: 101,
          transactionCost: 0,
          dispositions: [{ lotId: 'common-lot', shares: 100 }],
        },
      ],
    }

    const sale = buildEquityTransactionLedger(equity).byYear.get(2026)!
    expect(sale.cashProceeds).toBe(10_100)
    expect(sale.longTermCapitalGain).toBe(0)
    expect(sale.federalExcludedGain).toBe(10_000)
    expect(sale.stateCapitalGainAddback).toBe(10_000)
  })

  it('claims no QSBS exclusion when eligibility is unknown', () => {
    const equity = isoPlan()
    equity.grants = [
      {
        id: 'common-grant',
        companyId: 'company',
        companyName: 'Company',
        ownerPersonId: 'person',
        instrument: 'common',
        shares: 100,
        grantDate: '2020-01-01',
        strikePrice: 0,
        vestingSchedule: [],
        openingLots: [
          {
            id: 'common-lot',
            shares: 100,
            acquisitionDate: '2020-01-02',
            regularBasisPerShare: 1,
            qsbsEligibility: 'unknown',
          },
        ],
      },
    ]
    equity.transactions = [
      {
        type: 'sale',
        id: 'sale',
        date: '2026-01-03',
        pricePerShare: 101,
        transactionCost: 0,
        dispositions: [{ lotId: 'common-lot', shares: 100 }],
      },
    ]

    const ledger = buildEquityTransactionLedger(equity)
    expect(ledger.byYear.get(2026)!.longTermCapitalGain).toBe(10_000)
    expect(ledger.byYear.get(2026)!.federalExcludedGain).toBe(0)
    expect(ledger.warnings.join(' ')).toContain('unknown QSBS')
  })
})
