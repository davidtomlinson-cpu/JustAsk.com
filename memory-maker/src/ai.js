// Recipe generation via Claude — entirely optional, gated on
// ANTHROPIC_API_KEY, same silent-501-until-configured pattern as the
// sibling JustAsk backend's staff item-sourcing search.

async function generateRecipe(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('Recipe generation is not configured on this server yet.');
    err.status = 501;
    throw err;
  }

  const systemPrompt = 'You are a home-cooking recipe assistant inside a family planner app. ' +
    'Given a short prompt describing what someone wants to cook, invent one clear, practical, ' +
    'triple-tested-feeling recipe that matches it as closely as possible (servings, main ingredient, ' +
    'style, etc). Respond with ONLY valid JSON (no markdown fences, no commentary) in exactly this shape: ' +
    '{"title":string,"servings":number,"ingredients":[{"item":string,"quantity":string,"unit":string}],' +
    '"instructions":string,"minutes":number}. ' +
    '"instructions" should be numbered steps separated by newlines. Keep ingredient quantities sensible ' +
    'for the servings requested.';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let apiRes;
  try {
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!apiRes.ok) {
    const errBody = await apiRes.text().catch(() => '');
    console.error('generateRecipe: Anthropic API error', apiRes.status, errBody);
    const err = new Error('The recipe service returned an error. Try again in a moment.');
    err.status = 502;
    throw err;
  }

  const data = await apiRes.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('generateRecipe: could not parse model output', text);
    const err = new Error('Got a response back but could not read it as a recipe. Try again.');
    err.status = 502;
    throw err;
  }
  return parsed;
}

module.exports = { generateRecipe };
