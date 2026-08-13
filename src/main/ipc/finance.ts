/**
 * Exact finance math for the finance_calculator tool.
 *
 * Local models are genuinely bad at mental arithmetic, and a financial
 * literacy tool that estimates compound growth in its head teaches wrong
 * numbers with confidence. Every calculation the model might want lives here
 * instead: the model supplies inputs and explains the verified outputs.
 *
 * Pure and synchronous — no I/O, no network — so it is tested directly and
 * runs entirely on the user's machine. Rates are accepted as percentages
 * (7 means 7%), money is rounded to cents, and zero interest is handled
 * linearly rather than dividing by zero.
 */

export interface FinanceArgs {
  operation?: unknown
  principal?: unknown
  annual_rate?: unknown
  years?: unknown
  compounds_per_year?: unknown
  monthly_contribution?: unknown
  target_amount?: unknown
  extra_monthly_payment?: unknown
  direction?: unknown
  /** channel_margin: the retailer's gross margin percentage on the shelf price. */
  retailer_margin?: unknown
  /** channel_margin: the supplier's own target margin on landed cost, if any. */
  supplier_margin?: unknown
  /** channel_margin: units in a case, to report case economics as well. */
  units_per_case?: unknown
}

export interface FinanceResult {
  ok: boolean
  output?: string
  error?: string
}

function num(value: unknown, name: string, { min = 0, required = true } = {}): number | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`"${name}" is required for this operation.`)
    return null
  }
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number, got ${JSON.stringify(value)}.`)
  if (n < min) throw new Error(`"${name}" must be at least ${min}, got ${n}.`)
  return n
}

function money(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Round for display without floating-point tails like 0.30000000004. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Future value of a lump sum: P(1 + r/n)^(nt). */
function compoundLumpSum(principal: number, periodicRate: number, periods: number): number {
  return principal * Math.pow(1 + periodicRate, periods)
}

/** Future value of end-of-period contributions: PMT · [((1+i)^N − 1) / i]. */
function compoundContributions(pmt: number, periodicRate: number, periods: number): number {
  if (periodicRate === 0) return pmt * periods
  return pmt * ((Math.pow(1 + periodicRate, periods) - 1) / periodicRate)
}

function compoundInterest(args: FinanceArgs): string {
  const principal = num(args.principal, 'principal')!
  const ratePct = num(args.annual_rate, 'annual_rate')!
  const years = num(args.years, 'years', { min: 0.01 })!
  const n = num(args.compounds_per_year, 'compounds_per_year', { required: false, min: 1 }) ?? 12
  const pmt = num(args.monthly_contribution, 'monthly_contribution', { required: false }) ?? 0

  const i = ratePct / 100 / n
  const periods = Math.round(n * years)
  const fvLump = compoundLumpSum(principal, i, periods)
  const fvContrib = compoundContributions(pmt, i, periods)
  const futureValue = fvLump + fvContrib
  const contributed = principal + pmt * periods
  const interest = futureValue - contributed

  const lines = [
    `Compound interest projection`,
    `Initial principal: $${money(principal)}`,
    `Annual rate: ${ratePct}% compounded ${n}×/year over ${years} year(s) (${periods} periods)`,
    pmt > 0 ? `Monthly contribution: $${money(pmt)}` : `No ongoing contributions`,
    ``,
    `Future value: $${money(futureValue)}`,
    `Total you put in: $${money(contributed)}`,
    `Growth from interest: $${money(interest)} (${round2((interest / Math.max(contributed, 0.01)) * 100)}% on top of contributions)`
  ]

  // A yearly balance table is the teaching moment: compounding is visible.
  if (years >= 1 && n === 12 && years <= 40) {
    lines.push(``, `Year-end balances:`)
    for (let y = 1; y <= Math.floor(years); y++) {
      const p = 12 * y
      const bal = compoundLumpSum(principal, i, p) + compoundContributions(pmt, i, p)
      lines.push(`  Year ${y}: $${money(bal)}`)
    }
  }
  return lines.join('\n')
}

function loanAmortization(args: FinanceArgs): string {
  const principal = num(args.principal, 'principal', { min: 0.01 })!
  const ratePct = num(args.annual_rate, 'annual_rate')!
  const years = num(args.years, 'years', { min: 0.01 })!
  const extra = num(args.extra_monthly_payment, 'extra_monthly_payment', { required: false }) ?? 0

  const i = ratePct / 100 / 12
  const months = Math.round(years * 12)
  const payment =
    i === 0 ? principal / months : (principal * i) / (1 - Math.pow(1 + i, -months))
  const totalPaid = payment * months
  const totalInterest = totalPaid - principal

  const lines = [
    `Loan amortization`,
    // Restating the inputs is what makes a wrong argument visible: a "loan
    // amount" equal to the sticker price means the down payment was not
    // subtracted, and the model can see that and call again.
    `Loan amount: $${money(principal)} at ${ratePct}% for ${years} year(s) (${months} payments)`,
    `(If a down payment or trade-in applies, the loan amount above must already exclude it.)`,
    ``,
    `Monthly payment: $${money(payment)}`,
    `Total paid: $${money(totalPaid)}`,
    `Total interest: $${money(totalInterest)} (${round2((totalInterest / principal) * 100)}% of the loan amount)`,
    ``,
    `Report these figures exactly as written. Do not recompute or adjust them — if an input was ` +
      `wrong, call this tool again with corrected arguments.`
  ]

  if (extra > 0) {
    // Walk the balance month by month with the extra payment applied.
    let balance = principal
    let m = 0
    let interestPaid = 0
    while (balance > 0.005 && m < months * 3) {
      const monthInterest = balance * i
      interestPaid += monthInterest
      balance = balance + monthInterest - payment - extra
      m++
    }
    lines.push(
      ``,
      `With an extra $${money(extra)}/month:`,
      `  Paid off in ${m} months (${round2(m / 12)} years) instead of ${months}`,
      `  Interest paid: $${money(interestPaid)} — saves $${money(totalInterest - interestPaid)}`
    )
  } else {
    lines.push(
      ``,
      `Tip: pass extra_monthly_payment to see how much interest and time a larger payment saves.`
    )
  }
  return lines.join('\n')
}

function savingsGoal(args: FinanceArgs): string {
  const target = num(args.target_amount, 'target_amount', { min: 0.01 })!
  const ratePct = num(args.annual_rate, 'annual_rate')!
  const principal = num(args.principal, 'principal', { required: false }) ?? 0
  const years = num(args.years, 'years', { required: false })
  const pmt = num(args.monthly_contribution, 'monthly_contribution', { required: false })

  const i = ratePct / 100 / 12

  if (years !== null && years > 0) {
    // Solve the monthly contribution that reaches the target in `years`.
    const months = Math.round(years * 12)
    const fvFromPrincipal = compoundLumpSum(principal, i, months)
    const remaining = target - fvFromPrincipal
    if (remaining <= 0) {
      return [
        `Savings goal`,
        `$${money(principal)} alone grows to $${money(fvFromPrincipal)} in ${years} year(s) at ${ratePct}% —`,
        `past the $${money(target)} goal with no monthly contributions needed.`
      ].join('\n')
    }
    const needed = i === 0 ? remaining / months : (remaining * i) / (Math.pow(1 + i, months) - 1)
    return [
      `Savings goal`,
      `Goal: $${money(target)} in ${years} year(s) at ${ratePct}% annual return` +
        (principal > 0 ? `, starting with $${money(principal)}` : ''),
      ``,
      `Required monthly contribution: $${money(needed)}`,
      `Total you would put in: $${money(principal + needed * months)}`,
      `Growth from returns: $${money(target - principal - needed * months)}`
    ].join('\n')
  }

  if (pmt !== null && pmt > 0) {
    // Solve the time needed with a fixed monthly contribution.
    if (principal >= target) {
      return `You already have $${money(principal)} — the $${money(target)} goal is met.`
    }
    let months: number
    if (i === 0) {
      months = Math.ceil((target - principal) / pmt)
    } else {
      // (1+i)^N = (FV + PMT/i) / (P + PMT/i)
      const ratio = (target + pmt / i) / (principal + pmt / i)
      months = Math.ceil(Math.log(ratio) / Math.log(1 + i))
    }
    const fvCheck = compoundLumpSum(principal, i, months) + compoundContributions(pmt, i, months)
    return [
      `Savings goal`,
      `Goal: $${money(target)} contributing $${money(pmt)}/month at ${ratePct}% annual return` +
        (principal > 0 ? `, starting with $${money(principal)}` : ''),
      ``,
      `Time to goal: ${months} months (${round2(months / 12)} years)`,
      `Balance then: $${money(fvCheck)} (contributions $${money(principal + pmt * months)}, growth $${money(fvCheck - principal - pmt * months)})`
    ].join('\n')
  }

  throw new Error(
    'savings_goal needs either "years" (to solve the monthly contribution) or "monthly_contribution" (to solve the time needed).'
  )
}

function inflationAdjust(args: FinanceArgs): string {
  const amount = num(args.principal ?? args.target_amount, 'principal', { min: 0.01 })!
  const ratePct = num(args.annual_rate, 'annual_rate')!
  const years = num(args.years, 'years', { min: 0.01 })!
  const direction = String(args.direction ?? 'future_cost')

  const factor = Math.pow(1 + ratePct / 100, years)
  if (direction === 'present_value') {
    const pv = amount / factor
    return [
      `Inflation adjustment (present value)`,
      `$${money(amount)} received in ${years} year(s), at ${ratePct}% annual inflation,`,
      `has the buying power of $${money(pv)} today — a loss of $${money(amount - pv)}.`
    ].join('\n')
  }
  const fv = amount * factor
  return [
    `Inflation adjustment (future cost)`,
    `Something costing $${money(amount)} today will cost about $${money(fv)} in ${years} year(s)`,
    `at ${ratePct}% annual inflation — $${money(fv - amount)} more.`,
    `Savings that earn less than ${ratePct}% lose real buying power over that span.`
  ].join('\n')
}

/**
 * Channel pricing: cost in, shelf price out, with every party's margin named.
 *
 * v1.4.5, and it exists because of one measured conversation. The user said
 * "Costco works off a 15% GM while Sam's Club works off 20% GM" and gave a
 * landed cost of $2.51. The model computed *its own* margin on that cost, then
 * printed the result as the shelf price — so a supplier who read the answer
 * would have quoted a number that leaves the retailer no margin at all and
 * their own business nothing. Every table in the rest of that session, a P&L
 * and a ten-slide buyer deck included, inherited the error.
 *
 * The distinction the arithmetic turns on:
 *
 *   margin = (price − cost) / price      what retailers mean by "GM"
 *   markup = (price − cost) / cost       what the same numbers look like from below
 *
 * A 20% margin is a 25% markup. Confusing them is the oldest error in trade
 * pricing, and a model doing it in its head will confuse them every time.
 *
 * Both are always reported, and so is the whole chain from landed cost to
 * shelf, because the useful answer to "what do I quote?" is a wholesale price
 * — and the useful sanity check is what that becomes on the shelf.
 */
function channelMargin(args: FinanceArgs): string {
  const cost = num(args.principal, 'principal')! // landed/unit cost
  const retailerPct = num(args.retailer_margin, 'retailer_margin', { min: 0 })!
  const supplierPct = num(args.supplier_margin, 'supplier_margin', { min: 0, required: false })
  if (retailerPct >= 100) {
    throw new Error(`"retailer_margin" must be below 100%, got ${retailerPct}.`)
  }
  if (supplierPct !== null && supplierPct >= 100) {
    throw new Error(`"supplier_margin" must be below 100%, got ${supplierPct}.`)
  }
  const units = num(args.units_per_case, 'units_per_case', { min: 1, required: false })

  // What the supplier sells to the retailer for. With no target of their own,
  // the cost is the floor and the answer is what the shelf has to be to leave
  // the retailer whole.
  const wholesale = supplierPct === null ? cost : cost / (1 - supplierPct / 100)
  const shelf = wholesale / (1 - retailerPct / 100)
  const supplierMarkup = cost > 0 ? ((wholesale - cost) / cost) * 100 : 0
  const retailerMarkup = ((shelf - wholesale) / wholesale) * 100

  const lines = [
    'Channel pricing (per unit)',
    `Landed cost:        $${money(cost)}`,
    supplierPct === null
      ? `Wholesale price:    $${money(wholesale)} (at cost — no supplier margin requested)`
      : `Wholesale price:    $${money(wholesale)} — your ${round2(supplierPct)}% margin, a ${round2(supplierMarkup)}% markup on cost`,
    `Shelf price:        $${money(shelf)} — retailer's ${round2(retailerPct)}% margin, a ${round2(retailerMarkup)}% markup on wholesale`,
    '',
    `Retailer keeps      $${money(shelf - wholesale)} per unit.`,
    supplierPct === null
      ? `You keep            $0.00 per unit at this wholesale price.`
      : `You keep            $${money(wholesale - cost)} per unit.`
  ]

  if (units !== null) {
    lines.push(
      '',
      `Per ${units}-unit case:`,
      `  Case cost:        $${money(cost * units)}`,
      `  Case wholesale:   $${money(wholesale * units)}`,
      `  Case shelf price: $${money(shelf * units)}`
    )
  }

  lines.push(
    '',
    'Margin is on the selling price; markup is on the cost. A 20% margin is a 25% markup —',
    'quoting the markup as the margin underprices the case.'
  )
  return lines.join('\n')
}

/** Entry point used by the tool dispatcher. Throws become clean tool errors. */
export function runFinanceCalculation(args: FinanceArgs): FinanceResult {
  try {
    switch (String(args.operation ?? '')) {
      case 'compound_interest':
        return { ok: true, output: compoundInterest(args) }
      case 'loan_amortization':
        return { ok: true, output: loanAmortization(args) }
      case 'savings_goal':
        return { ok: true, output: savingsGoal(args) }
      case 'inflation_adjust':
        return { ok: true, output: inflationAdjust(args) }
      case 'channel_margin':
        return { ok: true, output: channelMargin(args) }
      default:
        return {
          ok: false,
          error:
            `Unknown operation ${JSON.stringify(args.operation)}. Use one of: ` +
            'compound_interest, loan_amortization, savings_goal, inflation_adjust, channel_margin.'
        }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
