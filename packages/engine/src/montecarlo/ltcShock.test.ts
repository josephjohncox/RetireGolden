import { describe, expect, it } from 'vitest'

import { DEFAULT_LTC_SHOCK, sampleCareEvents, type LtcShockParams } from './ltcShock.js'
import { createRng } from './rng.js'

const people = [{ id: 'p1', dob: '1960-01-01' }] // age 66 in 2026

describe('sampleCareEvents', () => {
  it('is deterministic for a given seed', () => {
    const a = sampleCareEvents(createRng(5), people, 2026, DEFAULT_LTC_SHOCK)
    const b = sampleCareEvents(createRng(5), people, 2026, DEFAULT_LTC_SHOCK)
    expect(a).toEqual(b)
  })

  it('triggers at roughly the configured per-person incidence over many draws', () => {
    const rng = createRng(99)
    const params: LtcShockParams = { ...DEFAULT_LTC_SHOCK, incidence: 0.5, incidenceScope: 'perPerson' }
    let hits = 0
    const N = 5_000
    for (let i = 0; i < N; i++) hits += sampleCareEvents(rng, people, 2026, params).length
    expect(hits / N).toBeGreaterThan(0.45)
    expect(hits / N).toBeLessThan(0.55)
  })

  it('interprets household incidence as the chance at least one person has an episode', () => {
    const rng = createRng(101)
    const couple = [
      { id: 'p1', dob: '1960-01-01' },
      { id: 'p2', dob: '1962-01-01' },
    ]
    const params: LtcShockParams = { ...DEFAULT_LTC_SHOCK, incidence: 0.5, incidenceScope: 'household' }
    let householdsWithCare = 0
    let peopleWithCare = 0
    const N = 10_000
    for (let i = 0; i < N; i++) {
      const events = sampleCareEvents(rng, couple, 2026, params)
      if (events.length > 0) householdsWithCare++
      peopleWithCare += events.length
    }
    expect(householdsWithCare / N).toBeGreaterThan(0.48)
    expect(householdsWithCare / N).toBeLessThan(0.52)
    expect(peopleWithCare / (N * couple.length)).toBeGreaterThan(0.28)
    expect(peopleWithCare / (N * couple.length)).toBeLessThan(0.31)
  })

  it('always produces care that is certain to fire at incidence 1, with valid bounds', () => {
    const rng = createRng(1)
    const params: LtcShockParams = { ...DEFAULT_LTC_SHOCK, incidence: 1 }
    for (let i = 0; i < 500; i++) {
      const [event] = sampleCareEvents(rng, people, 2026, params)
      expect(event).toBeDefined()
      expect(event!.startAge).toBeGreaterThanOrEqual(params.minOnsetAge)
      expect(event!.startAge).toBeLessThanOrEqual(params.maxOnsetAge)
      expect(params.durations.map((d) => d.years)).toContain(event!.durationYears)
      expect(event!.annualCost).toBe(params.annualCost)
    }
  })

  it('never produces care below incidence 0', () => {
    const events = sampleCareEvents(createRng(3), people, 2026, { ...DEFAULT_LTC_SHOCK, incidence: 0 })
    expect(events).toHaveLength(0)
  })
})
