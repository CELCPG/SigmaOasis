import type { ToolMeta } from '../types'

// Off by default, all three: these initiate outbound requests to commercial
// sites that log them. That should be a choice the user makes on purpose.
export const shoppingToolDefs = [
  {
    name: 'shop_requirements',
    label: 'Shopping requirements (works out what you need — fully local, sends nothing)',
    description:
      'Work out what the user actually needs before shopping for it. Runs entirely on this machine — ' +
      'nothing is sent anywhere.\n' +
      'Use when: the user wants to buy something and has not stated hard specifications ' +
      '("I need a new laptop", "looking for headphones for flights").\n' +
      'Do not use when: they named an exact product (go straight to shop_compare), or the question is ' +
      'about how something works rather than which to buy — answer that directly.\n' +
      'Call it twice: once with only `need` to get the questions, then again with the user\'s `answers`. ' +
      'Show the derived requirements to the user for correction BEFORE searching.\n' +
      'Example: {"need": "laptop", "answers": {"primary_use": "video or photo editing", "portability": "constant travel"}}',
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'What the user wants to buy, in their words' },
        answers: {
          type: 'object',
          description: 'The user\'s answers keyed by the question ids returned by the first call',
          additionalProperties: { type: 'string' }
        }
      },
      required: ['need']
    },
    toggleDefault: false,
    turnBudget: 2
  },
  {
    name: 'shop_compare',
    label: 'Shopping comparison (contacts retailers; prices carry a source and a timestamp)',
    description:
      'Compare what sellers currently charge for a product, with every price extracted from page data ' +
      'and carrying a source and a timestamp. Returns a table — do not restate the numbers, write your ' +
      'recommendation around them.\n' +
      'Use when: you have a product and its specifications, ideally after shop_requirements.\n' +
      'Do not use when: the query would contain who the user is rather than what the product is — ' +
      'personal framing is refused at egress. Search specifications and a price ceiling only.\n' +
      'Never claim a product meets a requirement the table marks unverifiable.\n' +
      'Example: {"product": "laptop 32GB RAM 1TB discrete GPU under 2000", "maxSellers": 4}',
    parameters: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description:
            'Product and specifications only — no first-person framing, no sentences, max 14 words'
        },
        maxSellers: { type: 'number', description: 'Sellers to check (1–5, default 4)' },
        brands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Brand names in play, so manufacturer sites are recognized as authoritative for specs'
        }
      },
      required: ['product']
    },
    toggleDefault: false,
    turnBudget: 2
  },
  {
    name: 'price_watch',
    label: 'Price watch (local watchlist — no service is told what is on it)',
    description:
      'Track a product price locally. The watchlist is a file on this machine; no service is told what ' +
      'is on it.\n' +
      'Use when: the user wants to be told if something drops, or asks what they are tracking.\n' +
      'Do not use for: fetching a current price (that is shop_compare).\n' +
      'Example: {"action": "add", "url": "https://example.com/product/123", "targetPrice": 250}',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'What to do' },
        url: { type: 'string', description: 'Product URL (required for add/remove)' },
        name: { type: 'string', description: 'Short label for the item' },
        targetPrice: { type: 'number', description: 'Notify below this price' }
      },
      required: ['action']
    },
    toggleDefault: false
  }
] as const satisfies readonly ToolMeta[]
