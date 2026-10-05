/** User image blocks are sent only when `model.input` lists `image`. No separate vision flag. */
export function imageInputRefusal(
  model: { id: string; input: readonly string[] },
  content: readonly { type: string }[],
): string | undefined {
  if (!content.some((block) => block.type === "image")) return undefined;
  if (model.input.includes("image")) return undefined;
  return `Model ${model.id} does not accept image input`;
}
