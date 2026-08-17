import type { Account, PropertyRecurringCost } from '../model/plan.js'

type PropertyAccount = Extract<Account, { type: 'property' }>

export interface AnnualPropertyCostInput {
  account: PropertyAccount
  /** Opening market value for this simulation year. */
  marketValue: number
  /** General inflation from the projection start through this year's opening. */
  inflationScale: number
  /** Current Prop 13 factored base-year value, when that policy is selected. */
  factoredBaseYearValue?: number
}

export interface AnnualPropertyCostResult {
  propertyTax: number
  insurance: number
  maintenance: number
  total: number
}

function recurringCost(
  policy: PropertyRecurringCost | undefined,
  legacyAnnual: number | undefined,
  marketValue: number,
  inflationScale: number,
): number {
  if (policy?.mode === 'fixedAnnual') {
    return policy.annualAmount * inflationScale
  }
  if (policy?.mode === 'propertyValuePct') {
    return marketValue * (policy.annualPct / 100)
  }
  return (legacyAnnual ?? 0) * inflationScale
}

/**
 * Price one owned property's annual carrying costs.
 *
 * The Prop 13 policy is planning-grade: acquisition establishes the base;
 * positive annual inflation grows the factored base subject to the configured
 * cap; taxable assessment is the lower of that base and opening market value
 * (the Proposition 8 decline-in-value arm). Exclusions, partial ownership
 * changes, supplemental assessments, new construction, and portability require
 * explicit future model extensions rather than silent assumptions here.
 */
export function annualPropertyCosts(
  input: AnnualPropertyCostInput,
): AnnualPropertyCostResult {
  const { account, marketValue, inflationScale } = input
  let propertyTax: number
  if (account.propertyTax?.mode === 'fixedAnnual') {
    propertyTax = account.propertyTax.annualAmount * inflationScale
  } else if (account.propertyTax?.mode === 'marketValuePct') {
    propertyTax = marketValue * (account.propertyTax.annualPct / 100)
  } else if (account.propertyTax?.mode === 'prop13') {
    const factoredBase = input.factoredBaseYearValue ?? marketValue
    propertyTax = Math.min(factoredBase, marketValue) *
      (account.propertyTax.taxRatePct / 100)
  } else {
    propertyTax = (account.propertyTaxAnnual ?? 0) * inflationScale
  }

  const insurance = recurringCost(
    account.insurance,
    account.insuranceAnnual,
    marketValue,
    inflationScale,
  )
  const maintenance = recurringCost(
    account.maintenance,
    undefined,
    marketValue,
    inflationScale,
  )

  return {
    propertyTax,
    insurance,
    maintenance,
    total: propertyTax + insurance + maintenance,
  }
}
