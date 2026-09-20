// Frontend-only pricing. URL and OpenAI callers keep their existing prices.
export function frontendGenerationCost(sizeCost, model, steps) {
  const extra = steps > 45 ? 8 : steps > 35 ? 6 : steps > 28 ? 4 : 0;
  if (sizeCost > 1) return sizeCost + extra;
  if (model === 'nai-diffusion-5-full') return 8 + extra;
  return extra ? 2 + extra : 1;
}
