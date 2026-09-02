

// v2.4: the 4,000-line file this was is now lib/groundingChecks/<section>.ts, one module per
// section marker, split mechanically with the compiler resolving cross-references. This
// barrel keeps every import site and test exactly as it was.
export * from './groundingChecks/report'
export * from './groundingChecks/correction'
export * from './groundingChecks/figures'
export * from './groundingChecks/measurementSources'
export * from './groundingChecks/conflicts'
export * from './groundingChecks/contacts'
export * from './groundingChecks/addresses'
export * from './groundingChecks/origin'
export * from './groundingChecks/claimedTools'
export * from './groundingChecks/toolCounts'
export * from './groundingChecks/deniedWork'
export * from './groundingChecks/retrieval'
export * from './groundingChecks/quotations'
export * from './groundingChecks/arguments'
export * from './groundingChecks/attributions'
export * from './groundingChecks/links'
export * from './groundingChecks/pass'
