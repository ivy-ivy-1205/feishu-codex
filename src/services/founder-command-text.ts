/**
 * Founders naturally @-mention the bot, and Feishu keeps that mention in the text as a placeholder
 * such as `@_user_1`. Commands are parsed from this cleaned form; the stored source text is never altered.
 */
export function founderCommandText(text: string, normalize = true): string {
  return (normalize ? text.normalize('NFKC') : text)
    .replace(/@_(?:user_\d+|all)\b/gu, ' ')
    .split('\n').map((line) => line.replace(/[ \t　]+/gu, ' ').trim()).join('\n')
    .replace(/\n{2,}/gu, '\n').trim()
    .replace(/[。．.!！~～]+$/u, '').trim();
}
