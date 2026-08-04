import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runFinanceCalculation } from '../src/main/ipc/finance'

/**
 * Every case compares against a figure computed by hand from the standard
 * formulas. A financial literacy tool that drifts on arithmetic teaches
 * wrong numbers confidently, so the outputs are pinned, not approximated.
 */

function out(args: Parameters<typeof runFinanceCalculation>[0]): string {
  const result = runFinanceCalculation(args)
  assert.equal(result.ok, true, result.error)
  return result.output!
}

describe('compound_interest', () => {
  test('lump sum with monthly compounding', () => {
    // 1000 at 12% (1%/mo) for 1 year: 1000 * 1.01^12 = 1126.83
    const text = out({ operation: 'compound_interest', principal: 1000, annual_rate: 12, years: 1 })
    assert.match(text, /Future value: \$1,126\.83/)
    assert.match(text, /Growth from interest: \$126\.83/)
  })

  test('monthly contributions with no principal', () => {
    // 100/mo at 1%/mo for 12 months: 100 * (1.01^12 - 1)/0.01 = 1268.25
    const text = out({
      operation: 'compound_interest',
      principal: 0,
      annual_rate: 12,
      years: 1,
      monthly_contribution: 100
    })
    assert.match(text, /Future value: \$1,268\.25/)
    assert.match(text, /Total you put in: \$1,200\.00/)
  })

  test('zero interest is linear, not a division by zero', () => {
    const text = out({
      operation: 'compound_interest',
      principal: 1000,
      annual_rate: 0,
      years: 2,
      monthly_contribution: 50
    })
    assert.match(text, /Future value: \$2,200\.00/)
    assert.match(text, /Growth from interest: \$0\.00/)
  })

  test('a year-end balance table is included for teaching', () => {
    const text = out({ operation: 'compound_interest', principal: 1000, annual_rate: 12, years: 3 })
    assert.match(text, /Year-end balances:/)
    assert.match(text, /Year 1: \$1,126\.83/)
    assert.match(text, /Year 3: \$1,430\.77/)
  })
})

describe('loan_amortization', () => {
  test('a standard one-year loan', () => {
    // 10000 at 6% for 12 months: payment = 50/(1 - 1.005^-12) = 860.66
    const text = out({ operation: 'loan_amortization', principal: 10000, annual_rate: 6, years: 1 })
    assert.match(text, /Monthly payment: \$860\.66/)
    assert.match(text, /Total interest: \$327\.97/)
  })

  test('interest-free loan is just principal over months', () => {
    const text = out({ operation: 'loan_amortization', principal: 1200, annual_rate: 0, years: 1 })
    assert.match(text, /Monthly payment: \$100\.00/)
    assert.match(text, /Total interest: \$0\.00/)
  })

  test('extra payments shorten the loan and save interest', () => {
    const text = out({
      operation: 'loan_amortization',
      principal: 10000,
      annual_rate: 6,
      years: 1,
      extra_monthly_payment: 200
    })
    assert.match(text, /Paid off in 10 months/)
    assert.match(text, /saves \$58\.43/)
  })
})

describe('savings_goal', () => {
  test('solves the monthly contribution for a target date', () => {
    // Zero rate: 10000 over 24 months = 416.67/month
    const text = out({ operation: 'savings_goal', target_amount: 10000, annual_rate: 0, years: 2 })
    assert.match(text, /Required monthly contribution: \$416\.67/)
  })

  test('solves the time needed for a fixed contribution', () => {
    const text = out({
      operation: 'savings_goal',
      target_amount: 1200,
      annual_rate: 0,
      monthly_contribution: 100
    })
    assert.match(text, /Time to goal: 12 months/)
  })

  test('principal that already beats the goal says so', () => {
    const text = out({
      operation: 'savings_goal',
      target_amount: 1000,
      annual_rate: 5,
      years: 1,
      principal: 2000
    })
    assert.match(text, /no monthly contributions needed/)
  })

  test('asks for the missing input instead of guessing', () => {
    const result = runFinanceCalculation({ operation: 'savings_goal', target_amount: 5000, annual_rate: 4 })
    assert.equal(result.ok, false)
    assert.match(result.error!, /either "years".*"monthly_contribution"/)
  })
})

describe('inflation_adjust', () => {
  test('future cost of today\'s money', () => {
    // 100 * 1.05^10 = 162.89
    const text = out({ operation: 'inflation_adjust', principal: 100, annual_rate: 5, years: 10 })
    assert.match(text, /\$162\.89/)
  })

  test('present value of future money', () => {
    // 100 / 1.05^10 = 61.39
    const text = out({
      operation: 'inflation_adjust',
      principal: 100,
      annual_rate: 5,
      years: 10,
      direction: 'present_value'
    })
    assert.match(text, /buying power of \$61\.39/)
  })
})

describe('input validation', () => {
  test('unknown operations are rejected with the valid list', () => {
    const result = runFinanceCalculation({ operation: 'day_trade' })
    assert.equal(result.ok, false)
    assert.match(result.error!, /compound_interest, loan_amortization, savings_goal, inflation_adjust/)
  })

  test('missing required inputs name the missing field', () => {
    const result = runFinanceCalculation({ operation: 'compound_interest', annual_rate: 5, years: 1 })
    assert.equal(result.ok, false)
    assert.match(result.error!, /"principal" is required/)
  })

  test('negative and non-numeric inputs are rejected', () => {
    assert.equal(
      runFinanceCalculation({ operation: 'loan_amortization', principal: -5, annual_rate: 6, years: 1 }).ok,
      false
    )
    assert.equal(
      runFinanceCalculation({ operation: 'loan_amortization', principal: 'a lot', annual_rate: 6, years: 1 }).ok,
      false
    )
  })
})
