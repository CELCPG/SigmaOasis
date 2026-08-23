import type { ToolMeta } from '../types'

export const calculatorToolDefs = [
  {
    name: 'finance_calculator',
    label: 'Finance calculator (loans, savings, compound growth — exact, fully local)',
    description:
      'Compute exact personal-finance figures locally: compound interest and investment ' +
      'growth, loan and mortgage amortization (including the effect of extra payments), ' +
      'savings-goal planning, and inflation adjustment. Runs entirely on this machine; ' +
      'nothing is sent anywhere.\n' +
      'Use when: ANY question involves these numbers — your explanations are only trustworthy ' +
      'when the math is, so never estimate or do mental arithmetic.\n' +
      'Do not use when: the question is conceptual (what compound interest means, how ' +
      'amortization works) — answer that directly.\n' +
      'Rates are percentages (7 means 7%).\n' +
      'For loan_amortization, principal is the amount BORROWED — subtract any down payment ' +
      'or trade-in from the purchase price first ($20,000 car with $5,000 down is 15000).\n' +
      'For channel_margin, principal is the LANDED COST per unit, and retailer_margin is the ' +
      'retailer\'s own margin — "Costco works off 15% GM" is retailer_margin 15, never your ' +
      'margin. Margin is on the selling price, markup is on the cost, and a 20% margin is a ' +
      '25% markup: do not compute either in your head.\n' +
      'Report the figures this tool returns verbatim. Never recompute, adjust, or round them ' +
      'into different numbers; if the arguments were wrong, call it again with the right ones.\n' +
      'Example: {"operation": "compound_interest", "principal": 0, "monthly_contribution": 500, "annual_rate": 7, "years": 20}',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'compound_interest',
            'loan_amortization',
            'savings_goal',
            'inflation_adjust',
            'channel_margin'
          ],
          description: 'Which calculation to run'
        },
        principal: {
          type: 'number',
          description:
            'Starting amount in dollars: initial investment, current savings, or — for ' +
            'loan_amortization — the amount actually borrowed, i.e. purchase price minus any ' +
            'down payment and trade-in. For inflation_adjust, the amount to convert.'
        },
        annual_rate: {
          type: 'number',
          description: 'Annual rate as a percentage: return rate, loan APR, or inflation rate.'
        },
        years: { type: 'number', description: 'Time span in years.' },
        compounds_per_year: {
          type: 'number',
          description: 'compound_interest only: compounding frequency (default 12, monthly).'
        },
        monthly_contribution: {
          type: 'number',
          description:
            'compound_interest: amount added monthly. savings_goal: fixed monthly amount, ' +
            'to solve the time needed to reach the goal.'
        },
        target_amount: {
          type: 'number',
          description: 'savings_goal: the amount to reach.'
        },
        extra_monthly_payment: {
          type: 'number',
          description: 'loan_amortization: extra paid monthly, to show interest and time saved.'
        },
        direction: {
          type: 'string',
          enum: ['future_cost', 'present_value'],
          description:
            'inflation_adjust only: what today\'s money will cost later (default), or what a ' +
            'future amount is worth today.'
        },
        retailer_margin: {
          type: 'number',
          description:
            'channel_margin: the retailer\'s gross margin percentage, taken on the shelf ' +
            'price. "Costco works off 15%" means 15 here.'
        },
        supplier_margin: {
          type: 'number',
          description:
            'channel_margin: your own target margin percentage on landed cost. Omit to see ' +
            'the shelf price implied by selling at cost.'
        },
        units_per_case: {
          type: 'number',
          description: 'channel_margin: units in a case, to report case economics too.'
        }
      },
      required: ['operation']
    },
    toggleDefault: true,
    isSource: true
  },
  {
    name: 'geo_locate',
    label: 'Places and distances (looks up a place on OpenStreetMap; straight-line distances only)',
    description:
      'Find where a place actually is, how far apart two places are, and a sensible order to ' +
      'visit several — using OpenStreetMap.\n' +
      'Use when: ANY question about location, distance, "how far", "closest", "within a N ' +
      'minute walk", or the order of stops on a trip. Never estimate a distance or a walking ' +
      'time yourself, and never state an address you have not looked up.\n' +
      'Distances come back straight-line, with an approximate walking time. Drive and ' +
      'ride-hail times are NOT available from this tool and must not be stated at all — ' +
      'traffic decides them, and a number invented for one is worse than no number.\n' +
      'Contacts OpenStreetMap with the place name. No personal addresses.\n' +
      'Example: {"operation": "distance", "from": "Penn Station, New York", "to": "Le Bernardin, New York"}',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['find', 'distance', 'order'],
          description:
            'find one place (default), the distance between two, or a nearest-neighbour ' +
            'order for a list of stops.'
        },
        place: { type: 'string', description: 'find only: the place to locate. Include the city.' },
        from: {
          type: 'string',
          description: 'distance/order: the first place, or the starting point of the route.'
        },
        to: { type: 'string', description: 'distance only: the second place.' },
        stops: {
          type: 'array',
          items: { type: 'string' },
          description: 'order only: the places to visit, in any order. Include each city.'
        }
      }
    },
    toggleDefault: true
  },
  {
    name: 'date_calculator',
    label: 'Date calculator (day of the week, "next Saturday", date spans — exact, fully local)',
    description:
      'Work out any date, exactly and locally: what day of the week a date falls on, what ' +
      '"next Saturday" or "tomorrow" resolves to, and how far apart two dates are.\n' +
      'Use when: ANY date or day-of-week question comes up, including relative phrases in the ' +
      "user's own words. Never work a date out in your head and never web-search for one — a " +
      'calendar is exact and your arithmetic is not.\n' +
      'With no expression it returns today, so this also answers "what is today".\n' +
      'Understood: today, tomorrow, yesterday, "next Saturday", "this weekend", "in 3 weeks", ' +
      '"2 days ago", 2026-10-01, "1 October 2026", "October 1 2026".\n' +
      'Ambiguous phrases come back with both readings — pass the note on rather than choosing ' +
      'silently.\n' +
      'Example: {"operation": "resolve", "expression": "next saturday"}',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['resolve', 'difference'],
          description: 'resolve one date (default), or the span between two.'
        },
        expression: {
          type: 'string',
          description: 'The date or phrase to resolve. Omit for today.'
        },
        from: { type: 'string', description: 'difference only: the earlier date or phrase.' },
        to: { type: 'string', description: 'difference only: the later date or phrase.' },
        relative_to: {
          type: 'string',
          description:
            'resolve only: treat this date as "today". Omit unless the user anchored to a ' +
            'date other than the present.'
        }
      }
    },
    toggleDefault: true,
    // v1.4.6: date_calculator takes the always-on slot that get_current_datetime
    // held, because it is a superset — with no expression it returns today — and
    // because the failures were never "what time is it". They were "what day is
    // October 1st 2026" and "next Saturday", asked on turns where the clock tool
    // was present, ignored, and web-searched around. A tool that can answer the
    // question is only useful if it is there when the question is asked.
    alwaysOn: true
  },
  {
    name: 'get_current_datetime',
    label: 'Get current date/time',
    description:
      'Get the current local date and time.\n' +
      'Use when: the user asks what time, day, or date it is, or an answer depends on today\'s date.\n' +
      'Do not use when: the current date is already visible in the conversation — check first.\n' +
      'Example: {}',
    parameters: { type: 'object', properties: {} },
    toggleDefault: true
  }
] as const satisfies readonly ToolMeta[]
