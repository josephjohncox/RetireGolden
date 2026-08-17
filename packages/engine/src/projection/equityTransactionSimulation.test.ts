import { describe, expect, it } from 'vitest'

import {
  createEmptyPlan,
  parsePlan,
  type Account,
  type Plan,
} from '../model/plan.js'
import type { TaxYearInput } from './types.js'
import { simulatePlan } from './simulate.js'

let counter = 0
const ids = () => `equity-simulation-${++counter}`

function basePlan(): Plan {
  const plan = createEmptyPlan({
    newId: ids,
    now: () => new Date('2026-06-11T00:00:00.000Z'),
  })
  plan.household.people[0] = {
    id: 'person',
    name: 'Pat',
    dob: '1964-03-15',
    sex: 'average',
    retirementAge: 62,
    longevity: { planningAge: 70, source: 'manual' },
  }
  plan.household.state = 'CA'
  plan.assumptions.inflationPct = 0
  plan.assumptions.defaultReturnPct = 0
  plan.assumptions.stateEffectiveTaxPct = 0
  plan.expenses.baseAnnual = 0
  plan.expenses.healthcare = {
    pre65MonthlyPremiumPerPerson: 0,
    applyAcaCredit: false,
    medicareExtrasMonthlyPerPerson: 0,
  }
  plan.accounts = [
    {
      type: 'cash',
      id: 'cash',
      name: 'Cash',
      ownerPersonId: null,
      annualReturnPct: null,
      balance: 100_000,
      annualContribution: 0,
    } as Account,
    {
      type: 'taxable',
      id: 'brokerage',
      name: 'Brokerage',
      ownerPersonId: null,
      annualReturnPct: 0,
      balance: 0,
      costBasis: 0,
      interestYieldPct: 0,
      dividendYieldPct: 0,
      qualifiedRatio: 0,
      reinvestDividends: true,
      annualContribution: 0,
    } as Account,
  ]
  plan.strategies.surplusAllocation = {
    cashAccountId: 'cash',
    cashTarget: 10_000,
    overflowAccountId: 'brokerage',
  }
  return plan
}

function withIsoTransactions(plan: Plan): void {
  plan.equity = {
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

function run(plan: Plan) {
  const parsed = parsePlan(plan)
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  const inputs: TaxYearInput[] = []
  const result = simulatePlan(parsed.plan, {
    startYear: 2026,
    taxCalculator: {
      compute(input) {
        inputs.push({ ...input })
        return 0
      },
    },
  })
  return { result, inputs }
}

describe('native equity transactions in the annual ledger', () => {
  it('treats an ISO exercise as a capital outlay and sends its spread to AMT', () => {
    const plan = basePlan()
    withIsoTransactions(plan)

    const year = run(plan).result.years.find((entry) => entry.year === 2026)!

    expect(year.equityAcquisitionOutlay).toBe(1_000)
    expect(year.expenses.oneTimeGoals).toBe(0)
    expect(year.expenses.total).toBe(0)
    expect(year.withdrawals.cash).toBe(1_000)
    expect(year.advisoryFederalTax?.input.amtPreferenceItems).toBe(2_000)
    expect(year.equityTransactions).toEqual([
      expect.objectContaining({
        transactionId: 'exercise',
        type: 'exercise',
        cashOutlay: 1_000,
        amtAdjustment: 2_000,
      }),
    ])
    expect(year.equityHoldings).toEqual([
      expect.objectContaining({ lotId: 'iso-lot', remainingShares: 100 }),
    ])
  })

  it('publishes sale proceeds and derives LTCG from the exercised lot', () => {
    const plan = basePlan()
    withIsoTransactions(plan)

    const year = run(plan).result.years.find((entry) => entry.year === 2028)!

    expect(year.equitySaleProceeds).toBe(5_000)
    expect(year.advisoryFederalTax?.input.shortTermCapitalGains).toBe(0)
    expect(year.advisoryFederalTax?.input.capitalGains).toBe(4_000)
    expect(year.advisoryFederalTax?.input.amtPreferenceItems).toBe(-2_000)
    expect(year.equityHoldings).toEqual([])
    expect(year.balances.brokerage).toBe(5_000)
  })

  it('fills the cash target and invests the rest of a cash inheritance', () => {
    const plan = basePlan()
    const cash = plan.accounts.find((account) => account.id === 'cash')!
    if (cash.type !== 'cash') throw new Error('cash fixture mismatch')
    cash.balance = 0
    plan.incomes.push({
      type: 'windfall',
      id: 'inheritance',
      label: 'Cash inheritance',
      date: '2026-07-01',
      amount: 100_000,
      source: 'inheritance',
      taxTreatment: 'none',
    })

    const year = run(plan).result.years.find((entry) => entry.year === 2026)!

    expect(year.incomes.oneTime).toBe(100_000)
    expect(year.advisoryFederalTax?.input.ordinaryIncome).toBe(0)
    expect(year.balances.cash).toBe(10_000)
    expect(year.balances.brokerage).toBe(90_000)
    expect(year.surplusInvested).toBe(100_000)
  })

  it('preserves opening short- and long-term loss character against lot gains', () => {
    const plan = basePlan()
    plan.household.capitalLossCarryforward = 0
    plan.household.capitalLossCarryforwardShortTerm = 500_000
    plan.household.capitalLossCarryforwardLongTerm = 60_000
    plan.incomes.push({
      type: 'oneTime',
      id: 'long-gain',
      label: 'Long-term gain',
      year: 2026,
      amount: 1_000_000,
      taxTreatment: 'capitalGain',
    })
    plan.equity = {
      grants: [
        {
          id: 'common',
          companyId: 'company',
          companyName: 'Company',
          ownerPersonId: 'person',
          instrument: 'common',
          shares: 100,
          grantDate: '2026-01-01',
          strikePrice: 0,
          vestingSchedule: [],
          openingLots: [
            {
              id: 'short-lot',
              shares: 100,
              acquisitionDate: '2026-01-01',
              regularBasisPerShare: 0,
              qsbsEligibility: 'ineligible',
            },
          ],
        },
      ],
      transactions: [
        {
          type: 'sale',
          id: 'short-sale',
          date: '2026-06-01',
          pricePerShare: 6_000,
          transactionCost: 0,
          dispositions: [{ lotId: 'short-lot', shares: 100 }],
        },
      ],
    }

    const year = run(plan).result.years.find((entry) => entry.year === 2026)!
    expect(year.advisoryFederalTax?.input.shortTermCapitalGains).toBe(100_000)
    expect(year.advisoryFederalTax?.input.capitalGains).toBe(940_000)
    expect(year.capitalLossUsedAgainstGains).toBe(560_000)
    expect(year.capitalLossCarryforwardRemaining).toBe(0)
  })

  it('rejects surplus routing that does not name cash and taxable accounts', () => {
    const plan = basePlan()
    plan.strategies.surplusAllocation = {
      cashAccountId: 'brokerage',
      cashTarget: 10_000,
      overflowAccountId: 'cash',
    }

    const parsed = parsePlan(plan)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.issues.join(' ')).toContain(
        'surplus cash target must name a cash account',
      )
      expect(parsed.issues.join(' ')).toContain(
        'surplus overflow must name a taxable account',
      )
    }
  })

  it('rejects combining the legacy net loss pool with character-specific pools', () => {
    const plan = basePlan()
    plan.household.capitalLossCarryforward = 10_000
    plan.household.capitalLossCarryforwardShortTerm = 5_000

    const parsed = parsePlan(plan)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.issues.join(' ')).toContain(
        'legacy net capital-loss pool cannot be combined',
      )
    }
  })
})
