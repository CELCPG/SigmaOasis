import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeShopping, shoppingSubject } from '../src/renderer/src/lib/shopping'

/**
 * Shopping intent (DESIGN-private-shopping §2e). The positives are drawn from
 * a real v1.3 session in which an entirely shopping-shaped conversation never
 * produced a single price check, and the model filled the gap with an invented
 * range. The negatives matter just as much: this gate spends outbound requests
 * to commercial sites, so a question that only wants an explanation must not
 * trip it.
 */

describe('looksLikeShopping · positives', () => {
  const shopping = [
    'i need to buy some new underwear',
    'im trying to find a good deal for a toyota corolla',
    'how much does the sony wh-1000xm5 cost',
    'where can i buy an all-terrain pet stroller',
    'cheapest 27 inch monitor with usb-c',
    'is the MSI Titan 18 HX on sale anywhere',
    'best value mattress for a guest room',
    'recommend a laptop for video editing',
    'which stroller should i get',
    'are these headphones in stock'
  ]
  for (const text of shopping) {
    test(`"${text}"`, () => assert.equal(looksLikeShopping(text), true))
  }
})

describe('looksLikeShopping · negatives', () => {
  const notShopping = [
    // Explanation, not acquisition — a comparison table is the wrong answer.
    'how does noise cancelling actually work',
    'what is the difference between OLED and QLED',
    'why are mattresses so expensive',
    'explain how car loan interest is calculated',
    // Already owned.
    'my dishwasher wont start, how do i fix it',
    'how do i clean my espresso machine',
    'is it worth it to repair my old laptop',
    // Not commerce at all.
    'write me a poem about the sea',
    'teach me basic first aid',
    'summarize this document'
  ]
  for (const text of notShopping) {
    test(`"${text}"`, () => assert.equal(looksLikeShopping(text), false))
  }

  test('too short to classify', () => {
    assert.equal(looksLikeShopping('buy'), false)
  })
})

describe('shoppingSubject', () => {
  test('a self-contained request is its own subject', () => {
    assert.equal(
      shoppingSubject('cheapest 27 inch monitor with usb-c'),
      'cheapest 27 inch monitor with usb-c'
    )
  })

  test('a follow-up borrows the subject from the previous message', () => {
    // "find the best reviewed product" names nothing on its own — the measured
    // failure mode, where the search came back about something unrelated.
    const subject = shoppingSubject(
      'find the best reviewed product',
      'im looking for a thong made from organic cotton and made in the usa'
    )
    assert.ok(subject)
    assert.match(subject!, /organic cotton/)
  })

  test('with no previous message a bare follow-up still yields something', () => {
    assert.ok(shoppingSubject('find the best one'))
  })

  test('the subject is capped so it stays a query', () => {
    const subject = shoppingSubject('buy ' + 'widget '.repeat(100))
    assert.ok(subject!.length <= 240)
  })
})
