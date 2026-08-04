# Sigma Oasis v1.2.1

A patch release fixing three parser failures measured in a live session with the gemma-4-e4b agentic fine-tune family, plus one tooling cleanup. Every claim below is pinned by the test suite (750 checks, 19 of them new).

## Bare tool calls parse — the "stall" is gone

- **A fourth call format, gated by the tool list.** gemma-4-e4b agentic fine-tunes can emit a call with no wrapper at all — `memory_search{query: "…"}`, unquoted keys and all — which the extractor passed through as visible text: nothing executed, and the turn looked stalled. Bare calls now parse when the name is one of the tools actually offered this turn (strict JSON first, then the lenient unquoted-key grammar), with the same chunk-boundary and truncation discipline as the markup formats. An unlisted name, a name glued to a word, and arguments broken beyond both grammars stay prose and never execute.

## Thought delimiters no longer leak

- **`<|thought>` / `</thought>` / `<|response>` / `<response>` handled.** The e4b fine-tune family's thought/response spellings (observed on gemma-4-e4b-agentic and google/gemma-4-12b-qat) rendered verbatim inside replies. The reasoning splitter now recognizes them as proper thinking blocks, and the stray-token pass strips any that appear mid-answer.

## Proxy failures explain themselves

- **`net::ERR_PROXY_CONNECTION_FAILED` → plain English.** When a configured proxy (Tor on 127.0.0.1:9050, say) is down, the error — in the network activity log and in the tool result the model sees — now says which proxy refused the connection and where the switch is (Settings → Connection), instead of a raw Chromium code the model had to narrate around.

## Tooling

- `search.ts` no longer contains literal NUL bytes (the cache-key separators are now `\u001f` escapes), so the file stops reading as binary to editors and tooling.

## Upgrade notes

- **Auto-update:** if you're running v1.2.0, this release appears as an update automatically.
- **No settings migration needed** — model slots, tools, and privacy settings are untouched.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.2.0...v1.2.1
