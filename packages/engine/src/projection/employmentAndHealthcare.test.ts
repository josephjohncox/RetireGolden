import { describe, expect, it } from 'vitest'

import { createEmptyPlan, parsePlan, type Plan } from '../model/plan.js'
import { createFlatTaxCalculator } from './flatTax.js'
import { simulatePlan } from './simulate.js'

let counter = 0
const ids = () => `employment-${++counter}`
const noTax = createFlatTaxCalculator(0)

function basePlan(): Plan {
  const plan = createEmptyPlan({
    newId: ids,
    now: () => new Date('2026-06-11T00:00:00.000Z'),
  })
  plan.household.people[0] = {
    id: 'p1',
    name: 'Pat',
    dob: '1986-03-15',
    sex: 'average',
    retirementAge: null,
    longevity: { planningAge: 80, source: 'manual' },
  }
  plan.assumptions.inflationPct = 0
  plan.assumptions.healthcareExtraInflationPct = 0
  plan.assumptions.defaultReturnPct = 0
  plan.expenses.baseAnnual = 0
  plan.expenses.healthcare = {
    pre65MonthlyPremiumPerPerson: 0,
    applyAcaCredit: false,
    medicareExtrasMonthlyPerPerson: 0,
  }
  return plan
}

function run(plan: Plan) {
  const parsed = parsePlan(plan)
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  return simulatePlan(parsed.plan, {
    startYear: 2026,
    taxCalculator: noTax,
  })
}

describe('dated W-2 employment', () => {
  it('starts and ends multiple wage streams on inclusive calendar-year boundaries', () => {
    const plan = basePlan()
    plan.incomes = [
      {
        type: 'wages',
        id: 'hadrian',
        personId: 'p1',
        annualGross: 475_000,
        startYear: 2026,
        endYear: 2035,
        endAge: null,
        realGrowthPct: 0,
      },
      {
        type: 'wages',
        id: 'consulting',
        personId: 'p1',
        annualGross: 300_000,
        startYear: 2036,
        endYear: 2053,
        endAge: null,
        realGrowthPct: 0,
      },
    ] as Plan['incomes']

    const years = run(plan).years
    expect(years.find((year) => year.year === 2035)?.incomes.wages).toBe(
      475_000,
    )
    expect(years.find((year) => year.year === 2036)?.incomes.wages).toBe(
      300_000,
    )
    expect(years.find((year) => year.year === 2053)?.incomes.wages).toBe(
      300_000,
    )
    expect(years.find((year) => year.year === 2054)?.incomes.wages).toBe(0)
  })

  it('ties employer family coverage to the job window with explicit Medicare coordination', () => {
    const plan = basePlan()
    plan.household.people = [
      {
        id: 'p1',
        name: 'Pat',
        dob: '1963-03-15',
        sex: 'average',
        retirementAge: null,
        longevity: { planningAge: 80, source: 'manual' },
      },
      {
        id: 'p2',
        name: 'Sam',
        dob: '1970-08-15',
        sex: 'average',
        retirementAge: null,
        longevity: { planningAge: 80, source: 'manual' },
      },
    ]
    plan.household.filingStatus = 'marriedFilingJointly'
    plan.expenses.healthcare = {
      pre65MonthlyPremiumPerPerson: 1_000,
      applyAcaCredit: false,
      medicareExtrasMonthlyPerPerson: 0,
    }
    plan.incomes = [
      {
        type: 'wages',
        id: 'job',
        personId: 'p1',
        annualGross: 100_000,
        startYear: 2026,
        endYear: 2030,
        endAge: null,
        realGrowthPct: 0,
        healthCoverage: {
          annualEmployeePremium: 10_000,
          coveredPersonIds: ['p1', 'p2'],
          premiumTaxTreatment: 'afterTax',
          medicareCoordination: 'employerPrimary',
        },
      },
    ] as Plan['incomes']

    const years = run(plan).years
    const age65Year = years.find((year) => year.year === 2028)!
    const finalJobYear = years.find((year) => year.year === 2030)!
    const afterJob = years.find((year) => year.year === 2031)!

    expect(age65Year.expenses.employerHealthPremiums).toBeCloseTo(10_000, 2)
    expect(age65Year.medicarePremiums).toBe(0)
    expect(age65Year.expenses.healthcare).toBeCloseTo(10_000, 2)
    expect(finalJobYear.expenses.employerHealthPremiums).toBeCloseTo(10_000, 2)
    expect(afterJob.expenses.employerHealthPremiums).toBe(0)
    expect(afterJob.medicarePremiums).toBeGreaterThan(0)
    expect(afterJob.expenses.healthcare).toBeGreaterThan(12_000)
  })

  it('charges Medicare alongside employer coverage when Medicare is primary', () => {
    const plan = basePlan()
    plan.household.people[0]!.dob = '1963-03-15'
    plan.incomes = [
      {
        type: 'wages',
        id: 'job',
        personId: 'p1',
        annualGross: 100_000,
        startYear: 2026,
        endYear: 2030,
        endAge: null,
        realGrowthPct: 0,
        healthCoverage: {
          annualEmployeePremium: 10_000,
          coveredPersonIds: ['p1'],
          premiumTaxTreatment: 'afterTax',
          medicareCoordination: 'medicarePrimary',
        },
      },
    ] as Plan['incomes']

    const year = run(plan).years.find((entry) => entry.year === 2028)!
    expect(year.expenses.employerHealthPremiums).toBeCloseTo(10_000, 2)
    expect(year.medicarePremiums).toBeGreaterThan(0)
    expect(year.expenses.healthcare).toBeCloseTo(
      10_000 + year.medicarePremiums,
      2,
    )
  })

  it('treats a pre-tax employee premium as a wage-income exclusion', () => {
    const plan = basePlan()
    plan.incomes = [
      {
        type: 'wages',
        id: 'job',
        personId: 'p1',
        annualGross: 100_000,
        startYear: 2026,
        endYear: 2026,
        endAge: null,
        realGrowthPct: 0,
        healthCoverage: {
          annualEmployeePremium: 10_000,
          coveredPersonIds: ['p1'],
          premiumTaxTreatment: 'preTax',
          medicareCoordination: 'employerPrimary',
        },
      },
    ] as Plan['incomes']

    const year = run(plan).years.find((entry) => entry.year === 2026)!
    expect(year.incomes.wages).toBe(100_000)
    expect(year.magi).toBeCloseTo(90_000, 2)
    expect(year.expenses.healthcare).toBeCloseTo(10_000, 2)
  })
})
