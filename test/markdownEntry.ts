/**
 * Browser entry for test/markdownCheck.ts. Vite bundles this into an IIFE
 * exposing `MarkdownUnderTest.renderMarkdown` so the real markdown pipeline —
 * marked + highlight.js + DOMPurify, exactly as shipped — runs against a real
 * DOM in an offscreen window. Not part of the app.
 */
export { renderMarkdown, splitStreamingMarkdown } from '../src/renderer/src/lib/markdown'
