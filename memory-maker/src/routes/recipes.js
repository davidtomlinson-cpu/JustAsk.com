const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId } = require('../helpers');
const { generateRecipe } = require('../ai');
const { assertFamilyMember } = require('./families');

const router = express.Router();

function present(row) {
  return { ...row, ingredients: JSON.parse(row.ingredients || '[]') };
}

router.get('/recipes', ah(async (req, res) => {
  const { familyId, liked } = req.query;
  if (!familyId) return res.status(400).json({ error: 'familyId is required' });
  if (!(await assertFamilyMember(req, res, familyId))) return;
  let where = '"familyId" = $1';
  const params = [familyId];
  if (liked === 'true') where += ' AND liked = true';
  const rows = await dbAll(`SELECT * FROM recipes WHERE ${where} ORDER BY "createdAt" DESC`, params);
  res.json({ recipes: rows.map(present) });
}));

// AI recipe generation from a short prompt — e.g. "chicken thigh recipe for
// 4 people with a tomato sauce". Doesn't save it; the user reviews first and
// saves separately (same "generate then like/save" flow as everything else).
router.post('/recipes/generate', ah(async (req, res) => {
  const prompt = (req.body || {}).prompt;
  if (!isNonEmptyString(prompt)) return res.status(400).json({ error: 'A prompt describing what to cook is required' });
  const generated = await generateRecipe(prompt);
  res.json({ recipe: generated });
}));

router.post('/recipes', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.familyId)) return res.status(400).json({ error: 'familyId is required' });
  if (!isNonEmptyString(b.title)) return res.status(400).json({ error: 'A title is required' });
  if (!(await assertFamilyMember(req, res, b.familyId))) return;

  const id = newId('rcp');
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO recipes (id,"familyId","createdBy",title,servings,ingredients,instructions,"sourceType","sourceUrl",liked,"createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, b.familyId, req.user.id, b.title.trim(), b.servings || null, JSON.stringify(b.ingredients || []),
      b.instructions || null, ['ai', 'link', 'manual'].includes(b.sourceType) ? b.sourceType : 'manual',
      b.sourceUrl || null, !!b.liked, now]
  );
  const recipe = await dbGet('SELECT * FROM recipes WHERE id = $1', [id]);
  res.status(201).json({ recipe: present(recipe) });
}));

async function loadRecipe(req, res) {
  const recipe = await dbGet('SELECT * FROM recipes WHERE id = $1', [req.params.id]);
  if (!recipe) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!(await assertFamilyMember(req, res, recipe.familyId))) return null;
  return recipe;
}

router.patch('/recipes/:id', ah(async (req, res) => {
  const recipe = await loadRecipe(req, res);
  if (!recipe) return;
  const b = req.body || {};
  await dbRun(
    `UPDATE recipes SET title=$1, servings=$2, ingredients=$3, instructions=$4, liked=$5, "timesCooked"=$6 WHERE id=$7`,
    [b.title || recipe.title, b.servings !== undefined ? b.servings : recipe.servings,
      JSON.stringify(b.ingredients !== undefined ? b.ingredients : JSON.parse(recipe.ingredients || '[]')),
      b.instructions !== undefined ? b.instructions : recipe.instructions,
      b.liked !== undefined ? !!b.liked : recipe.liked,
      b.cookedAgain ? recipe.timesCooked + 1 : recipe.timesCooked, recipe.id]
  );
  const updated = await dbGet('SELECT * FROM recipes WHERE id = $1', [recipe.id]);
  res.json({ recipe: present(updated) });
}));

router.delete('/recipes/:id', ah(async (req, res) => {
  const recipe = await loadRecipe(req, res);
  if (!recipe) return;
  await dbRun('DELETE FROM recipes WHERE id = $1', [recipe.id]);
  res.json({ ok: true });
}));

module.exports = { router };
