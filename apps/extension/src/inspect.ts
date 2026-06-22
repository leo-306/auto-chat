const GENERATING_TEXT_PATTERN = /Thinking|Generating a more detailed image|hang tight|正在生成|生成中/i;
const NOT_GENERATING_TEXT_PATTERN = /Stopped thinking/i;

export function hasGeneratingText(text: string): boolean {
  return GENERATING_TEXT_PATTERN.test(text) && !NOT_GENERATING_TEXT_PATTERN.test(text);
}
