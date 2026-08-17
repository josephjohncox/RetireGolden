import { describe, expect, it } from 'vitest'

import { createEmptyPlan, parsePlan, type Account, type Plan } from '../model/plan.js'
import { createFlatTaxCalculator } from './flatTax.js'
import { simulatePlan } from './simulate.js'

let counter = 0
const ids = () => `property-acquisition-${++counter}`
const noTax = createFlatTaxCalculator(0)

function basePlan(): Plan {
  const plan = createEmptyPlan({
    newId: ids,
    now: () => new Date('2026-06-11T00:00:00.000Z'),
  })
  plan.household.people[0] = {
    id: 'p1',
    name: 'Pat',
    dob: '1964-03-15',
    sex: 'average',
    retirementAge: 62,
    longevity: { planningAge: 72, source: 'manual' },
  }
  plan.assumptions.inflationPct = 0
  plan.assumptions.defaultReturnPct = 0
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
      balance: 1_000_000,
      annualContribution: 0,
    } as Account,
  ]
  return plan
}

function futureCashHome(): Account {
  return {
    type: 'property',
    id: 'future-home',
    name: 'Future home',
    ownerPersonId: null,
    annualReturnPct: null,
    value: 250_000,
    plannedSaleYear: null,
    expectedNetProceeds: null,
    propertyTaxAnnual: 2_500,
    insuranceAnnual: 1_000,
    purchase: {
      year: 2028,
      purchasePrice: 250_000,
      purchasePriceBasis: 'purchaseYearNominal',
      financing: { type: 'cash' },
    },
  } as unknown as Account
}

function run(plan: Plan) {
  const parsed = parsePlan(plan)
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  return simulatePlan(parsed.plan, { startYear: 2026, taxCalculator: noTax })
}

describe('dated property acquisition', () => {
  it('has no property, debt, spending, withdrawal, or net-worth effect before acquisition', () => {
    const withoutHome = basePlan()
    const withHome = basePlan()
    withHome.accounts.push(futureCashHome())

    const baseline = run(withoutHome)
    const acquired = run(withHome)

    for (const year of [2026, 2027]) {
      const expected = baseline.years.find((entry) => entry.year === year)!
      const actual = acquired.years.find((entry) => entry.year === year)!

      expect(actual.balances['future-home'] ?? 0).toBe(0)
      expect(actual.expenses).toEqual(expected.expenses)
      expect(actual.withdrawals).toEqual(expected.withdrawals)
      expect(actual.investableTotal).toBe(expected.investableTotal)
      expect(actual.netWorth).toBe(expected.netWorth)
    }
  })

  it('atomically funds a cash purchase and starts carrying costs in the acquisition year', () => {
    const plan = basePlan()
    plan.accounts.push(futureCashHome())

    const year = run(plan).years.find((entry) => entry.year === 2028)!

    expect(year.propertyAcquisitionOutlay).toBeCloseTo(250_000, 2)
    expect(year.propertyAcquisitions).toEqual([
      {
        propertyAccountId: 'future-home',
        status: 'executed',
        purchasePrice: 250_000,
        cashOutlay: 250_000,
        mortgagePrincipal: 0,
        mortgagePayment: 0,
        costBasis: 250_000,
      },
    ])
    expect(year.balances['future-home']).toBeCloseTo(250_000, 2)
    expect(year.expenses.propertyCosts).toBeCloseTo(3_500, 2)
    expect(year.expenses.oneTimeGoals).toBe(0)
    expect(year.expenses.total).toBeCloseTo(3_500, 2)
    expect(year.withdrawals.cash).toBeCloseTo(253_500, 2)
    expect(year.investableTotal).toBeCloseTo(746_500, 2)
    expect(year.netWorth).toBeCloseTo(996_500, 2)
  })

  it('creates and services an embedded mortgage only when the property is acquired', () => {
    const plan = basePlan()
    plan.accounts.push({
      type: 'property',
      id: 'mortgaged-home',
      name: 'Mortgaged home',
      ownerPersonId: null,
      annualReturnPct: null,
      value: 300_000,
      plannedSaleYear: null,
      expectedNetProceeds: null,
      purchase: {
        year: 2028,
        purchasePrice: 300_000,
        purchasePriceBasis: 'purchaseYearNominal',
        financing: {
          type: 'mortgage',
          downPaymentPct: 20,
          interestPct: 6,
          termYears: 30,
        },
      },
    } as Account)

    const result = run(plan)
    const before = result.years.find((entry) => entry.year === 2027)!
    const acquired = result.years.find((entry) => entry.year === 2028)!
    const nextYear = result.years.find((entry) => entry.year === 2029)!
    const principal = 240_000
    const monthlyRate = 0.06 / 12
    const months = 30 * 12
    const monthlyPayment =
      principal * monthlyRate * Math.pow(1 + monthlyRate, months) /
      (Math.pow(1 + monthlyRate, months) - 1)
    const annualPayment = monthlyPayment * 12
    const endingPrincipal = principal * 1.06 - annualPayment

    expect(before.propertyMortgageBalances).toEqual({})
    expect(before.expenses.debtService).toBe(0)
    expect(acquired.propertyAcquisitionOutlay).toBeCloseTo(60_000, 2)
    expect(acquired.expenses.debtService).toBeCloseTo(annualPayment, 2)
    expect(acquired.propertyMortgageBalances).toEqual({
      'mortgaged-home': expect.closeTo(endingPrincipal, 2),
    })
    expect(acquired.withdrawals.cash).toBeCloseTo(60_000 + annualPayment, 2)
    expect(acquired.netWorth).toBeCloseTo(1_000_000 - principal * 0.06, 2)
    expect(nextYear.expenses.debtService).toBeCloseTo(annualPayment, 2)
    expect(nextYear.propertyMortgageBalances?.['mortgaged-home']).toBeCloseTo(
      endingPrincipal * 1.06 - annualPayment,
      2,
    )
  })

  it('pays off an embedded mortgage in a configured future year', () => {
    const plan = basePlan()
    plan.accounts.push({
      type: 'property',
      id: 'payoff-home',
      name: 'Payoff home',
      ownerPersonId: null,
      annualReturnPct: null,
      value: 300_000,
      plannedSaleYear: null,
      expectedNetProceeds: null,
      purchase: {
        year: 2028,
        purchasePrice: 300_000,
        purchasePriceBasis: 'purchaseYearNominal',
        financing: {
          type: 'mortgage',
          downPaymentPct: 20,
          interestPct: 6,
          termYears: 30,
          payoffYear: 2030,
        },
      },
    } as Account)

    const result = run(plan)
    const beforePayoff = result.years.find((entry) => entry.year === 2029)!
    const payoff = result.years.find((entry) => entry.year === 2030)!
    const afterPayoff = result.years.find((entry) => entry.year === 2031)!
    const openingPayoffBalance = beforePayoff.propertyMortgageBalances?.['payoff-home'] ?? 0

    expect(payoff.expenses.debtService).toBeCloseTo(
      openingPayoffBalance * 1.06,
      2,
    )
    expect(payoff.propertyMortgageBalances).toEqual({})
    expect(payoff.balances['payoff-home']).toBeCloseTo(300_000, 2)
    expect(afterPayoff.expenses.debtService).toBe(0)
  })

  it('prices a today-dollar purchase from the realized inflation path without pre-acquisition drift', () => {
    const plan = basePlan()
    plan.accounts.push({
      ...futureCashHome(),
      value: 100_000,
      propertyTaxAnnual: 0,
      insuranceAnnual: 0,
      purchase: {
        year: 2028,
        purchasePrice: 100_000,
        purchasePriceBasis: 'todayDollars',
        financing: { type: 'cash' },
      },
    } as Account)
    const parsed = parsePlan(plan)
    if (!parsed.ok) throw new Error(parsed.issues.join('; '))

    const result = simulatePlan(parsed.plan, {
      startYear: 2026,
      taxCalculator: noTax,
      market: { inflationPct: [0, 10, 10] },
    })
    const before = result.years.find((entry) => entry.year === 2027)!
    const acquired = result.years.find((entry) => entry.year === 2028)!

    expect(before.balances['future-home'] ?? 0).toBe(0)
    expect(before.netWorth).toBeCloseTo(1_000_000, 2)
    expect(acquired.propertyAcquisitions?.[0]?.purchasePrice).toBeCloseTo(
      110_000,
      2,
    )
    expect(acquired.propertyAcquisitionOutlay).toBeCloseTo(110_000, 2)
    expect(acquired.balances['future-home']).toBeCloseTo(121_000, 2)
  })

  it('skips the whole acquisition batch when its cash requirement cannot be funded', () => {
    const plan = basePlan()
    const cash = plan.accounts.find((account) => account.type === 'cash')!
    if (cash.type !== 'cash') throw new Error('expected cash account')
    cash.balance = 100_000
    plan.accounts.push(futureCashHome())

    const year = run(plan).years.find((entry) => entry.year === 2028)!

    expect(year.propertyAcquisitionOutlay).toBe(0)
    expect(year.propertyAcquisitions).toEqual([
      {
        propertyAccountId: 'future-home',
        status: 'skippedInsufficientFunds',
        purchasePrice: 250_000,
        cashOutlay: 0,
        mortgagePrincipal: 0,
        mortgagePayment: 0,
        costBasis: 250_000,
      },
    ])
    expect(year.balances['future-home'] ?? 0).toBe(0)
    expect(year.propertyMortgageBalances).toEqual({})
    expect(year.expenses.propertyCosts).toBe(0)
    expect(year.expenses.debtService).toBe(0)
    expect(year.withdrawals.total).toBe(0)
    expect(year.shortfall).toBe(0)
    expect(year.requiredShortfall).toBe(0)
    expect(year.targetShortfall).toBe(0)
    expect(year.investableTotal).toBeCloseTo(100_000, 2)
    expect(year.netWorth).toBeCloseTo(100_000, 2)
  })

  it('repays the embedded mortgage and uses acquisition basis when the property is sold', () => {
    const plan = basePlan()
    plan.household.people[0]!.dob = '1976-03-15'
    plan.household.people[0]!.retirementAge = 50
    plan.household.people[0]!.longevity = { planningAge: 60, source: 'manual' }
    const cash = plan.accounts.find((account) => account.type === 'cash')!
    if (cash.type !== 'cash') throw new Error('expected cash account')
    cash.balance = 500_000
    plan.accounts.push({
      type: 'property',
      id: 'sale-home',
      name: 'Sale home',
      ownerPersonId: null,
      annualReturnPct: null,
      value: 300_000,
      plannedSaleYear: 2029,
      expectedNetProceeds: null,
      sellingCostPct: 0,
      purchase: {
        year: 2027,
        purchasePrice: 300_000,
        purchasePriceBasis: 'purchaseYearNominal',
        financing: {
          type: 'mortgage',
          downPaymentPct: 20,
          interestPct: 6,
          termYears: 30,
        },
      },
    } as Account)

    const result = run(plan)
    const acquired = result.years.find((entry) => entry.year === 2027)!
    const held = result.years.find((entry) => entry.year === 2028)!
    const sold = result.years.find((entry) => entry.year === 2029)!
    const annualPayment = acquired.propertyAcquisitions?.[0]?.mortgagePayment ?? 0
    const mortgageAtSale =
      ((240_000 * 1.06 - annualPayment) * 1.06) - annualPayment
    const expectedCashAfterSale =
      500_000 -
      60_000 -
      annualPayment * 2 +
      300_000 -
      mortgageAtSale

    expect(held.propertyMortgageBalances?.['sale-home']).toBeCloseTo(
      mortgageAtSale,
      2,
    )
    expect(sold.expenses.debtService).toBe(0)
    expect(sold.balances['sale-home']).toBe(0)
    expect(sold.propertyMortgageBalances).toEqual({})
    expect(sold.realizedGains).toBeCloseTo(0, 2)
    expect(sold.investableTotal).toBeCloseTo(expectedCashAfterSale, 2)
    expect(sold.netWorth).toBeCloseTo(expectedCashAfterSale, 2)
  })

  it('uses same-year property sale proceeds to fund a replacement purchase', () => {
    const plan = basePlan()
    plan.household.people[0]!.dob = '1976-03-15'
    plan.household.people[0]!.retirementAge = 50
    plan.household.people[0]!.longevity = { planningAge: 60, source: 'manual' }
    const cash = plan.accounts.find((account) => account.type === 'cash')!
    if (cash.type !== 'cash') throw new Error('expected cash account')
    cash.balance = 0
    plan.accounts.push(
      {
        type: 'property',
        id: 'old-home',
        name: 'Old home',
        ownerPersonId: null,
        annualReturnPct: null,
        value: 300_000,
        costBasis: 300_000,
        plannedSaleYear: 2028,
        expectedNetProceeds: null,
      } as Account,
      {
        ...futureCashHome(),
        propertyTaxAnnual: 0,
        insuranceAnnual: 0,
      } as Account,
    )

    const year = run(plan).years.find((entry) => entry.year === 2028)!

    expect(year.propertyAcquisitions?.[0]?.status).toBe('executed')
    expect(year.propertyAcquisitionOutlay).toBeCloseTo(250_000, 2)
    expect(year.withdrawals.total).toBe(0)
    expect(year.balances['old-home']).toBe(0)
    expect(year.balances['future-home']).toBeCloseTo(250_000, 2)
    expect(year.investableTotal).toBeCloseTo(50_000, 2)
    expect(year.netWorth).toBeCloseTo(300_000, 2)
  })

  it('executes or skips multiple same-year purchases as one deterministic batch', () => {
    const plan = basePlan()
    const cash = plan.accounts.find((account) => account.type === 'cash')!
    if (cash.type !== 'cash') throw new Error('expected cash account')
    cash.balance = 300_000
    for (const [id, price] of [['home-a', 200_000], ['home-b', 200_000]] as const) {
      plan.accounts.push({
        type: 'property',
        id,
        name: id,
        ownerPersonId: null,
        annualReturnPct: null,
        value: price,
        plannedSaleYear: null,
        expectedNetProceeds: null,
        purchase: {
          year: 2028,
          purchasePrice: price,
          purchasePriceBasis: 'purchaseYearNominal',
          financing: { type: 'cash' },
        },
      } as Account)
    }

    const year = run(plan).years.find((entry) => entry.year === 2028)!

    expect(year.propertyAcquisitions?.map((entry) => entry.status)).toEqual([
      'skippedInsufficientFunds',
      'skippedInsufficientFunds',
    ])
    expect(year.propertyAcquisitionOutlay).toBe(0)
    expect(year.balances['home-a'] ?? 0).toBe(0)
    expect(year.balances['home-b'] ?? 0).toBe(0)
    expect(year.investableTotal).toBeCloseTo(300_000, 2)
  })

  it('applies market-value property tax, insurance, and maintenance only while owned', () => {
    const plan = basePlan()
    const cash = plan.accounts.find((account) => account.type === 'cash')!
    if (cash.type !== 'cash') throw new Error('expected cash account')
    cash.balance = 2_000_000
    plan.accounts.push({
      type: 'property',
      id: 'serviced-home',
      name: 'Serviced home',
      ownerPersonId: null,
      annualReturnPct: null,
      value: 500_000,
      plannedSaleYear: 2030,
      expectedNetProceeds: null,
      propertyTax: { mode: 'marketValuePct', annualPct: 1 },
      insurance: { mode: 'propertyValuePct', annualPct: 0.5 },
      maintenance: { mode: 'propertyValuePct', annualPct: 1 },
      purchase: {
        year: 2028,
        purchasePrice: 500_000,
        purchasePriceBasis: 'purchaseYearNominal',
        financing: { type: 'cash' },
      },
    } as unknown as Account)

    const result = run(plan)
    const before = result.years.find((entry) => entry.year === 2027)!
    const acquired = result.years.find((entry) => entry.year === 2028)!
    const held = result.years.find((entry) => entry.year === 2029)!
    const sold = result.years.find((entry) => entry.year === 2030)!

    expect(before.expenses.propertyCosts).toBe(0)
    expect(acquired.expenses.propertyTax).toBeCloseTo(5_000, 2)
    expect(acquired.expenses.propertyInsurance).toBeCloseTo(2_500, 2)
    expect(acquired.expenses.propertyMaintenance).toBeCloseTo(5_000, 2)
    expect(acquired.expenses.propertyCosts).toBeCloseTo(12_500, 2)
    expect(held.expenses.propertyCosts).toBeCloseTo(12_500, 2)
    expect(sold.expenses.propertyCosts).toBe(0)
  })

  it('caps a Prop 13 factored assessment while market value grows faster', () => {
    const plan = basePlan()
    const cash = plan.accounts.find((account) => account.type === 'cash')!
    if (cash.type !== 'cash') throw new Error('expected cash account')
    cash.balance = 2_000_000
    plan.accounts.push({
      type: 'property',
      id: 'prop13-home',
      name: 'California home',
      ownerPersonId: null,
      annualReturnPct: null,
      value: 1_000_000,
      plannedSaleYear: null,
      expectedNetProceeds: null,
      propertyTax: {
        mode: 'prop13',
        annualInflationCapPct: 2,
        taxRatePct: 1.1,
      },
      purchase: {
        year: 2027,
        purchasePrice: 1_000_000,
        purchasePriceBasis: 'purchaseYearNominal',
        financing: { type: 'cash' },
      },
    } as Account)
    const parsed = parsePlan(plan)
    if (!parsed.ok) throw new Error(parsed.issues.join('; '))

    const result = simulatePlan(parsed.plan, {
      startYear: 2026,
      taxCalculator: noTax,
      market: { inflationPct: [0, 10, 10] },
    })
    const acquired = result.years.find((entry) => entry.year === 2027)!
    const held = result.years.find((entry) => entry.year === 2028)!

    expect(acquired.expenses.propertyTax).toBeCloseTo(11_000, 2)
    expect(acquired.balances['prop13-home']).toBeCloseTo(1_100_000, 2)
    expect(held.expenses.propertyTax).toBeCloseTo(11_220, 2)
    expect(held.expenses.propertyTax).toBeLessThan(1_100_000 * 0.011)
  })

  it('fails closed when a purchase event predates the projection horizon', () => {
    const plan = basePlan()
    plan.accounts.push({
      ...futureCashHome(),
      purchase: {
        year: 2025,
        purchasePrice: 250_000,
        purchasePriceBasis: 'purchaseYearNominal',
        financing: { type: 'cash' },
      },
    } as Account)
    const parsed = parsePlan(plan)
    if (!parsed.ok) throw new Error(parsed.issues.join('; '))

    expect(() => simulatePlan(parsed.plan, {
      startYear: 2026,
      taxCalculator: noTax,
    })).toThrow(/purchase year before the projection start/)
  })
})
