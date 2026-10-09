/**
 * How a reply is laid out in a Steam chat window, decided in one place.
 *
 * Steam chat reads a few slash commands at the start of a message. `/pre`
 * shows the rest in a fixed-width font with its spaces and line breaks kept,
 * which is the only way to make a list of commands or a set of figures line
 * up. `/me` shows a line as an action of the sender, which reads as a status
 * rather than an answer.
 *
 * Blocks are `/pre`, never `/code`. Steam's own chat client (friends.js)
 * draws a `[code]` block as `<pre class="prettyprint">` and runs Google's
 * code prettifier over it, which guesses a language from the text and colours
 * every keyword it knows ("from", "not", "this", "in", "for", ...) and every
 * word that starts with a capital ("To", "Experience"), since in code that is
 * a type name. The class is fixed, so no language hint can be passed, and no
 * English sentence survives it. A `[pre]` block is drawn as a plain `<pre>`
 * with no prettifier at all, which Steam describes as "Formats text in a
 * fixed-width font, preserving whitespace". Nothing in it is ever coloured.
 *
 * Handlers write plain text and say whether it is a list. Everything about
 * the prefixes, and about keeping them when a long reply has to be cut into
 * several messages, lives here, so no handler and no transport has to know.
 */

export const BLOCK_PREFIX = "/pre ";
export const EMOTE_PREFIX = "/me ";

/** A reply this many lines long reads better as a block, whatever it says. */
const BLOCK_FROM_LINES = 3;

/**
 * The text to send for a reply.
 *
 * A one line answer stays plain, because a block around a sentence looks
 * like an error message. A list, or anything three lines or longer, becomes a
 * fixed-width block so its columns and line breaks survive.
 */
export function formatReply(reply: string, options: { readonly list?: boolean } = {}): string {
  if (reply === "" || reply.startsWith(BLOCK_PREFIX)) return reply;
  const lines = reply.split("\n").length;
  return options.list === true || lines >= BLOCK_FROM_LINES ? `${BLOCK_PREFIX}${reply}` : reply;
}

/* Characters that change how text around them shows without being seen:
   bidirectional overrides and isolates (which can make a link read
   backwards), zero widths, the soft hyphen and the byte order mark. */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
/* Control characters and line separators other than a plain line break and tab, including NEL (U+0085). */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Text fit to send in Steam chat, whoever wrote it.
 *
 * Steam chat reads markup in square brackets: `[url=...]` makes a link with
 * any words on it, `[spoiler]`, `[quote]` and `[code]` change how the rest
 * shows. The bot itself never writes any, so every bracket is turned into a
 * round one, and no name, error message or service's words that end up in a
 * reply can become a link or break a block. Invisible formatting characters
 * are dropped and stray control characters become spaces; line breaks stay.
 * Applied to every message the bot sends.
 */
export function chatSafe(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(CONTROL, " ").replace(/\[/g, "(").replace(/\]/g, ")");
}

/** A one line status, shown as something the bot is doing. */
export function emote(text: string): string {
  return `${EMOTE_PREFIX}${text.replace(/\n/g, " ")}`;
}

/**
 * Cuts a message into parts of at most `max` characters.
 *
 * Cuts fall on line breaks, so no line is split unless it is longer than a
 * whole message on its own. A block keeps its prefix on every part,
 * because Steam reads the prefix per message: a second part without it would
 * show as plain text with its columns collapsed. A block is also cut
 * between sections (blank lines) where it can be, so a heading is never left
 * at the bottom of one message with its lines in the next.
 */
export function splitChatMessage(text: string, max: number): string[] {
  if (!text.startsWith(BLOCK_PREFIX)) return packLines(text.split("\n"), max);

  const room = max - BLOCK_PREFIX.length;
  const out: string[] = [];
  let current = "";
  for (const section of text.slice(BLOCK_PREFIX.length).split("\n\n")) {
    if (section.length > room) {
      if (current) { out.push(current); current = ""; }
      out.push(...packLines(section.split("\n"), room));
      continue;
    }
    if (current && current.length + 2 + section.length > room) { out.push(current); current = ""; }
    current = current ? `${current}\n\n${section}` : section;
  }
  if (current) out.push(current);
  return out.filter((part) => part.trim() !== "").map((part) => `${BLOCK_PREFIX}${part}`);
}

/** Packs whole lines into parts, cutting a line only when it alone is too long. */
function packLines(lines: readonly string[], max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + 1 + line.length > max) { out.push(current); current = ""; }
    if (line.length > max) {
      for (let i = 0; i < line.length; i += max) {
        if (current) { out.push(current); current = ""; }
        current = line.slice(i, i + max);
      }
      continue;
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out;
}
