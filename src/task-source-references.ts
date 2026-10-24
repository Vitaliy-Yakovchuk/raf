interface SourceReference {
  readonly path: string;
  readonly details: string;
}

interface ReferenceToken {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

const sourcePath = /^(?:openspec|conf|skills|specs)\/[\p{L}\p{N}._~\/-]+(?:#[\p{L}\p{N}._~\/-]+)?$/u;

function withoutFencedCode(text: string): string {
  let fence: { marker: string; length: number } | undefined;
  return text.split(/(?<=\n)/).map(line => {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
    if (!fence && opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      return line.replace(/[^\n]/g, ' ');
    }
    if (!fence) return /^(?: {4}|\t)/.test(line) ? line.replace(/[^\n]/g, ' ') : line;
    if (opening && opening[1][0] === fence.marker && opening[1].length >= fence.length && !opening[2].trim()) fence = undefined;
    return line.replace(/[^\n]/g, ' ');
  }).join('');
}

function spanEnd(text: string, start: number): { content: string; end: number } | undefined {
  const delimiter = /^`+/.exec(text.slice(start))?.[0];
  if (!delimiter) return undefined;
  const runs = /`+/g;
  runs.lastIndex = start + delimiter.length;
  for (let match = runs.exec(text); match; match = runs.exec(text)) {
    if (match[0].length === delimiter.length) return { content: text.slice(start + delimiter.length, match.index), end: runs.lastIndex };
  }
  return undefined;
}

function closingBracket(text: string, start: number, opening: string, closing: string): number {
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '`') {
      const span = spanEnd(text, index);
      if (span) { index = span.end - 1; continue; }
    }
    if (text[index] === opening) depth++;
    if (text[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function linkAt(text: string, start: number): { path?: string; end: number } | undefined {
  const labelEnd = closingBracket(text, start, '[', ']');
  if (labelEnd < 0) return undefined;
  if (text[labelEnd + 1] === '[') {
    const referenceEnd = closingBracket(text, labelEnd + 1, '[', ']');
    return { end: referenceEnd < 0 ? labelEnd + 1 : referenceEnd + 1 };
  }
  if (text[labelEnd + 1] !== '(') return { end: labelEnd + 1 };
  const targetEnd = closingBracket(text, labelEnd + 1, '(', ')');
  if (targetEnd < 0) return { end: labelEnd + 1 };
  const target = text.slice(labelEnd + 2, targetEnd).trim();
  const destination = /^(?:<([^<>\n]+)>|([^\s]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\)))?$/.exec(target);
  const path = destination?.[1] ?? destination?.[2];
  return { path: path && sourcePath.test(path) ? path : undefined, end: targetEnd + 1 };
}

export function descriptionSourceReferences(description: string): readonly SourceReference[] {
  const text = withoutFencedCode(description);
  const references: ReferenceToken[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\') { index += 2; continue; }
    if (text[index] === '[') {
      const link = linkAt(text, index);
      if (link) {
        if (link.path && text[index - 1] !== '!') references.push({ path: link.path, start: index, end: link.end });
        index = link.end;
        continue;
      }
    }
    if (text[index] === '`') {
      const span = spanEnd(text, index);
      if (span) {
        if (sourcePath.test(span.content)) references.push({ path: span.content, start: index, end: span.end });
        index = span.end;
        continue;
      }
    }
    index++;
  }
  const tails = references.map((reference, index) => text.slice(reference.end, references[index + 1]?.start ?? text.length));
  return references.map((reference, index) => ({
    path: reference.path,
    details: (tails.slice(index).find(tail => /\s—\s/.test(tail)) ?? tails[index]).replace(/^[`\s)]+|[`\s]+$/g, '').trim(),
  }));
}
