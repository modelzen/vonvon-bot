/** The `vonvon …` lines a skill teaches: each line of its fenced blocks that starts with `vonvon `. */
export function skillCommands(body: string): string[] {
  const blocks = body.split('```').filter((_, index) => index % 2 === 1);
  return blocks.flatMap(block => block.split('\n').map(line => line.trim()).filter(line => line.startsWith('vonvon ')));
}

/** A line split as sh splits it, for lines with no expansion but `"$VAR"` (kept as one word) and quotes. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '', open: '"' | "'" | undefined, started = false;
  for (const char of line) {
    if (open) {
      if (char === open) open = undefined;
      else word += char;
    } else if (char === '"' || char === "'") { open = char; started = true; }
    else if (/\s/.test(char)) { if (started || word) words.push(word); word = ''; started = false; }
    else word += char;
  }
  if (open) throw new Error(`unclosed quote in: ${line}`);
  if (started || word) words.push(word);
  return words;
}
