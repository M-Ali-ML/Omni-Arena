const lexicalTokenPattern = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*|[^\s]/gu;
const markdownBlockMarkerPattern =
  /(?:^|\n)\s{0,3}(?:#{1,6}\s|>\s|[-+*]\s|\d+\.\s)/gu;
const markdownInlineMarkerPattern = /[*_`]|~~/gu;
const markdownLinkPattern = /!?\[[^\]\n]*\]\([^)\n]*\)/gu;

export function estimateTokenCount(content: string): number {
  return content.match(lexicalTokenPattern)?.length ?? 0;
}

export function calculateMarkdownDensity(content: string): number {
  const nonWhitespaceLength = content.replace(/\s/gu, "").length;
  if (nonWhitespaceLength === 0) {
    return 0;
  }

  const blockMarkerLength = [
    ...content.matchAll(markdownBlockMarkerPattern),
  ].reduce(
    (total, match) => total + match[0].replace(/\s/gu, "").length,
    0,
  );
  const inlineMarkerLength = [
    ...content.matchAll(markdownInlineMarkerPattern),
  ].reduce((total, match) => total + match[0].length, 0);
  const linkMarkerLength = [...content.matchAll(markdownLinkPattern)].reduce(
    (total, match) => total + (match[0].startsWith("!") ? 5 : 4),
    0,
  );
  const markerLength =
    blockMarkerLength + inlineMarkerLength + linkMarkerLength;
  return Math.min(1, markerLength / nonWhitespaceLength);
}
