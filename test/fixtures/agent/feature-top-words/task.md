Add `topWords(text, n)` to `src/textstats.js` and export it beside `wordCount`.

It returns the `n` most frequent words as `[word, count]` pairs, most frequent first, with ties in alphabetical order. Words are compared lowercased, and a word is a run of letters, digits or apostrophes — punctuation is not part of a word. If there are fewer than `n` distinct words, return them all.

Add tests for it and run the test suite.
