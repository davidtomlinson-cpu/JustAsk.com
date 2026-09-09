const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId, newToken, baseUrlFromReq, DAYS, DAY_LABELS } = require('../helpers');
const { sendSms } = require('../sms');
const { assertFamilyMember } = require('./families');

const router = express.Router();
const publicRouter = express.Router();

// ---- Weekly meal days (which recipe is planned for which day) ----

router.get('/weekly-meal-days', ah(async (req, res) => {
  const { familyId, weekStart } = req.query;
  if (!familyId || !weekStart) return res.status(400).json({ error: 'familyId and weekStart are required' });
  if (!(await assertFamilyMember(req, res, familyId))) return;
  const rows = await dbAll(
    `SELECT weekly_meal_days.*, recipes.title as "recipeTitle" FROM weekly_meal_days
     LEFT JOIN recipes ON recipes.id = weekly_meal_days."recipeId"
     WHERE weekly_meal_days."familyId" = $1 AND weekly_meal_days."weekStart" = $2`,
    [familyId, weekStart]
  );
  res.json({ days: rows });
}));

router.put('/weekly-meal-days', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.familyId) || !isNonEmptyString(b.weekStart) || !DAYS.includes(b.day)) {
    return res.status(400).json({ error: 'familyId, weekStart and a valid day are required' });
  }
  if (!(await assertFamilyMember(req, res, b.familyId))) return;
  const id = newId('wmd');
  await dbRun(
    `INSERT INTO weekly_meal_days (id,"familyId","weekStart",day,"recipeId",notes,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT ("familyId","weekStart",day) DO UPDATE SET "recipeId" = $5, notes = $6`,
    [id, b.familyId, b.weekStart, b.day, b.recipeId || null, b.notes || null, new Date().toISOString()]
  );
  const row = await dbGet('SELECT * FROM weekly_meal_days WHERE "familyId"=$1 AND "weekStart"=$2 AND day=$3', [b.familyId, b.weekStart, b.day]);
  res.json({ day: row });
}));

// ---- Shopping list ----

function normalizeIngredientKey(item) {
  return String(item || '').trim().toLowerCase();
}

router.post('/shopping-list/generate', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.familyId) || !isNonEmptyString(b.weekStart)) {
    return res.status(400).json({ error: 'familyId and weekStart are required' });
  }
  if (!(await assertFamilyMember(req, res, b.familyId))) return;

  const mealDays = await dbAll(
    `SELECT weekly_meal_days.day, recipes.id as "recipeId", recipes.title, recipes.ingredients
     FROM weekly_meal_days JOIN recipes ON recipes.id = weekly_meal_days."recipeId"
     WHERE weekly_meal_days."familyId" = $1 AND weekly_meal_days."weekStart" = $2 AND weekly_meal_days."recipeId" IS NOT NULL`,
    [b.familyId, b.weekStart]
  );

  const existing = await dbAll('SELECT * FROM shopping_list_items WHERE "familyId" = $1 AND "weekStart" = $2', [b.familyId, b.weekStart]);
  const existingChecked = new Map(existing.map((i) => [normalizeIngredientKey(i.ingredient), i.checked]));

  const aggregated = new Map(); // key -> { ingredient, quantities:[], unit, days:Set, recipeIds:Set }
  for (const md of mealDays) {
    let ingredients = [];
    try { ingredients = JSON.parse(md.ingredients || '[]'); } catch (e) { ingredients = []; }
    for (const ing of ingredients) {
      if (!ing || !isNonEmptyString(ing.item)) continue;
      const key = normalizeIngredientKey(ing.item);
      if (!aggregated.has(key)) aggregated.set(key, { ingredient: ing.item.trim(), quantities: [], days: new Set(), recipeIds: new Set() });
      const entry = aggregated.get(key);
      const qtyStr = [ing.quantity, ing.unit].filter(Boolean).join(' ').trim();
      if (qtyStr) entry.quantities.push(qtyStr);
      entry.days.add(md.day);
      entry.recipeIds.add(md.recipeId);
    }
  }

  await dbRun('DELETE FROM shopping_list_items WHERE "familyId" = $1 AND "weekStart" = $2', [b.familyId, b.weekStart]);
  const now = new Date().toISOString();
  for (const [key, entry] of aggregated) {
    await dbRun(
      `INSERT INTO shopping_list_items (id,"familyId","weekStart",ingredient,quantity,unit,days,"recipeIds",checked,"createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [newId('sli'), b.familyId, b.weekStart, entry.ingredient, entry.quantities.join(' + '), null,
        JSON.stringify(Array.from(entry.days)), JSON.stringify(Array.from(entry.recipeIds)),
        existingChecked.get(key) || false, now]
    );
  }

  const items = await dbAll('SELECT * FROM shopping_list_items WHERE "familyId" = $1 AND "weekStart" = $2 ORDER BY ingredient ASC', [b.familyId, b.weekStart]);
  res.json({ items: items.map((i) => ({ ...i, days: JSON.parse(i.days), recipeIds: JSON.parse(i.recipeIds), dayLabels: JSON.parse(i.days).map((d) => DAY_LABELS[d]) })) });
}));

router.get('/shopping-list', ah(async (req, res) => {
  const { familyId, weekStart } = req.query;
  if (!familyId || !weekStart) return res.status(400).json({ error: 'familyId and weekStart are required' });
  if (!(await assertFamilyMember(req, res, familyId))) return;
  const items = await dbAll('SELECT * FROM shopping_list_items WHERE "familyId" = $1 AND "weekStart" = $2 ORDER BY checked ASC, ingredient ASC', [familyId, weekStart]);
  res.json({ items: items.map((i) => ({ ...i, days: JSON.parse(i.days), recipeIds: JSON.parse(i.recipeIds), dayLabels: JSON.parse(i.days).map((d) => DAY_LABELS[d]) })) });
}));

// Unchecking/checking an item is the "I already have this in the
// cupboard/fridge" interaction — checked = leave it off the real list.
router.patch('/shopping-list/:id', ah(async (req, res) => {
  const item = await dbGet('SELECT * FROM shopping_list_items WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!(await assertFamilyMember(req, res, item.familyId))) return;
  await dbRun('UPDATE shopping_list_items SET checked = $1 WHERE id = $2', [!!(req.body || {}).checked, item.id]);
  res.json({ ok: true });
}));

// ---- Post-meal ratings ----

router.post('/weekly-meal-days/:id/send-ratings', ah(async (req, res) => {
  const mealDay = await dbGet('SELECT * FROM weekly_meal_days WHERE id = $1', [req.params.id]);
  if (!mealDay) return res.status(404).json({ error: 'Not found' });
  if (!(await assertFamilyMember(req, res, mealDay.familyId))) return;
  if (!mealDay.recipeId) return res.status(400).json({ error: 'No recipe is assigned to this day yet' });

  const poll = await dbGet('SELECT * FROM dinner_polls WHERE "familyId" = $1 AND "weekStart" = $2 ORDER BY "createdAt" DESC LIMIT 1',
    [mealDay.familyId, mealDay.weekStart]);
  if (!poll) return res.status(400).json({ error: 'No dinner poll found for this week — run one first so we know who ate' });

  const recipients = await dbAll(
    `SELECT dinner_poll_recipients.id as "recipientId", users.id as "userId", users.name, users.phone, users."smsOptIn"
     FROM dinner_poll_recipients
     JOIN dinner_poll_responses ON dinner_poll_responses."recipientId" = dinner_poll_recipients.id
     JOIN users ON users.id = dinner_poll_recipients."userId"
     WHERE dinner_poll_recipients."pollId" = $1 AND dinner_poll_responses.day = $2 AND dinner_poll_responses."inFor" = true`,
    [poll.id, mealDay.day]
  );

  const baseUrl = baseUrlFromReq(req);
  const now = new Date().toISOString();
  const created = [];
  for (const r of recipients) {
    const token = newToken();
    const id = newId('mr');
    await dbRun(
      `INSERT INTO meal_ratings (id,"weeklyMealDayId","recipientId",token,"createdAt") VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT ("weeklyMealDayId","recipientId") DO NOTHING`,
      [id, mealDay.id, r.recipientId, token, now]
    );
    created.push({ userId: r.userId, name: r.name });
    if (r.smsOptIn && r.phone) {
      sendSms(r.phone, `The Memory Maker: how was tonight's dinner? Rate it here: ${baseUrl}/rate/${token}`);
    }
  }
  res.json({ sentTo: created });
}));

router.get('/weekly-meal-days/:id/ratings', ah(async (req, res) => {
  const mealDay = await dbGet('SELECT * FROM weekly_meal_days WHERE id = $1', [req.params.id]);
  if (!mealDay) return res.status(404).json({ error: 'Not found' });
  if (!(await assertFamilyMember(req, res, mealDay.familyId))) return;
  const ratings = await dbAll(
    `SELECT meal_ratings.rating, meal_ratings."respondedAt", users.name FROM meal_ratings
     JOIN dinner_poll_recipients ON dinner_poll_recipients.id = meal_ratings."recipientId"
     JOIN users ON users.id = dinner_poll_recipients."userId"
     WHERE meal_ratings."weeklyMealDayId" = $1`,
    [mealDay.id]
  );
  res.json({ ratings });
}));

// ---- Public, no-login meal rating response ----

const RATING_VALUES = ['delicious', 'edible', 'takeaway_next_time'];

publicRouter.get('/meal-rating/:token', ah(async (req, res) => {
  const row = await dbGet(
    `SELECT meal_ratings.*, weekly_meal_days.day, recipes.title as "recipeTitle" FROM meal_ratings
     JOIN weekly_meal_days ON weekly_meal_days.id = meal_ratings."weeklyMealDayId"
     LEFT JOIN recipes ON recipes.id = weekly_meal_days."recipeId"
     WHERE meal_ratings.token = $1`,
    [req.params.token]
  );
  if (!row) return res.status(404).json({ error: 'This link is not valid' });
  res.json({ day: row.day, dayLabel: DAY_LABELS[row.day], recipeTitle: row.recipeTitle, rating: row.rating, respondedAt: row.respondedAt });
}));

publicRouter.post('/meal-rating/:token', ah(async (req, res) => {
  const rating = (req.body || {}).rating;
  if (!RATING_VALUES.includes(rating)) return res.status(400).json({ error: 'rating must be one of: ' + RATING_VALUES.join(', ') });
  const row = await dbGet('SELECT * FROM meal_ratings WHERE token = $1', [req.params.token]);
  if (!row) return res.status(404).json({ error: 'This link is not valid' });
  await dbRun('UPDATE meal_ratings SET rating = $1, "respondedAt" = $2 WHERE token = $3', [rating, new Date().toISOString(), req.params.token]);
  res.json({ ok: true });
}));

module.exports = { router, publicRouter };
