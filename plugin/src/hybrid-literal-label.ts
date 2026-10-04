/** Inert in both Markdown guards and the wikilink grammar; never use backslash escapes here. */
export function encodeWikilinkLabel(value: string): string {
  return value.replace(/[&|\[\]<>\\`$%{}*_~()!#]/g, character => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    return `&#${character.charCodeAt(0)};`;
  });
}

/** Undo one layer of our delimiter quoting, never recursively or via an HTML/DOM parser. */
export function decodeWikilinkLabel(value: string): string {
  return value.replace(/&(amp|lt|gt|#\d{1,3}|#x[0-9a-f]{1,2});/gi, (entity, token: string) => {
    if (token === 'amp') return '&';
    if (token === 'lt') return '<';
    if (token === 'gt') return '>';
    const code = token[1]?.toLowerCase() === 'x' ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    const character = String.fromCharCode(code);
    return '&|[]<>\\`$%{}*_~()!#'.includes(character) ? character : entity;
  });
}
