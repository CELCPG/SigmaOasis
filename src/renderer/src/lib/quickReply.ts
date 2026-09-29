import { THINK_TAG_MODELS } from '../../../shared/thinking'

/**
 * v3.1: a greeting is answered without thinking first.
 *
 * Measured on this app's own history, 2026-09-28, VIBE on a 12 GB GPU: "yo
 * whats up?" thought for 2.2 s before its first word on a 9B, and "what is up
 * my dude?" 12.8 s on a 35B-A3B before it stalled. On a 27B that did not fit
 * the card, "how many cm is 6 foot 3" thought for 3,795 tokens — nine minutes
 * at six tokens a second — before one sentence of answer. A greeting has
 * nothing to reason about, and a local reasoning model reasons anyway.
 *
 * The lever is the one already measured for this job: the assistant turn
 * begins with a closed thinking block (shared/thinking.ts), which LM Studio
 * honours where `enable_thinking`, `/no_think` and `reasoning_effort` were all
 * inert. It rides the first round only — lib/agentLoop.ts `quickReply` — so
 * the tools stay on the wire and a round after a tool call thinks as usual.
 *
 * Deliberately narrow. The whole message has to be small talk: pleasantries,
 * a name, punctuation, an emoji. "hey, what time is it?" is a question with a
 * greeting in front and thinks as before; so does anything with a digit in it.
 * "ok", "sounds good" and "great" are left out on purpose: after "shall I
 * write it?" they are a go-ahead, and the work that follows needs its plan.
 * A turn misjudged as small talk is a model answering "hello" without a plan,
 * which is the whole of what a greeting needs; the other way round costs a
 * few seconds of thinking, which is what every turn cost before.
 */

/** Words that make up a message which is only small talk, longest first where they overlap. */
const PLEASANTRIES = [
  'good morning', 'good afternoon', 'good evening', 'good night', 'goodnight', 'good day',
  'how are you doing', 'how are you', 'how are u', 'how r u', "how's it going", 'hows it going', 'how is it going',
  "how's everything", 'how you doing', "how ya doin", "what's up", 'whats up', 'what is up', 'wassup', 'wazzup',
  "what's good", 'whats good', "what's new", 'whats new', 'long time no see', 'nice to meet you',
  'thank you so much', 'thank you', 'thanks a lot', 'thanks so much', 'thanks', 'thx', 'ty', 'cheers', 'much appreciated',
  'see you later', 'see you', 'see ya', 'talk later', 'catch you later', 'goodbye', 'bye', 'later',
  'hello there', 'hi there', 'hey there', 'hello', 'hiya', 'hi', 'hey', 'heya', 'howdy', 'yo', 'sup', 'hola', 'gm', 'gn',
  'lol', 'haha', 'lmao',
  'my dude', 'dude', 'man', 'bro', 'buddy', 'friend', 'mate', 'fam', 'again', 'everyone', 'there',
  'sigma', 'oasis', 'sigma oasis'
]

const SEPARATORS = String.raw`[\s,.!?~:;()'"\-]*`
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SMALL_TALK = new RegExp(
  `^${SEPARATORS}(?:(?:${[...PLEASANTRIES].sort((a, b) => b.length - a.length).map(escape).join('|')})${SEPARATORS})+$`,
  'i'
)
/** Emoji and emoticons carry tone, not content. */
const DECORATION = /[\p{Extended_Pictographic}‍️]|[:;]-?[)(DPp]|<3/gu

/** Longer than this is not a greeting, whatever words it uses. */
const MAX_SMALL_TALK_CHARS = 60

/** Is the whole message small talk — nothing in it to reason about? */
export function isSmallTalk(text: string | undefined): boolean {
  const t = (text ?? '').replace(DECORATION, ' ').trim()
  if (!t || t.length > MAX_SMALL_TALK_CHARS || /\d/.test(t)) return false
  return SMALL_TALK.test(t.replace(/[’‘]/g, "'"))
}

/**
 * Does this turn skip the model's thinking on its first round? Only for small
 * talk, and only on a model whose thinking is `<think>`-delimited — the
 * families the closed block is measured to work on. A model outside them (a
 * name the pattern does not know) is left to think: prefilling the wrong
 * family's delimiters is noise it has to talk around.
 */
export function quickReplyFor(modelId: string, text: string | undefined): boolean {
  return THINK_TAG_MODELS.test(modelId) && isSmallTalk(text)
}
