// Downloadable weekly/monthly summary — one PDF covering a family, a
// friend group, or a single family member's activity: calendar, to-dos,
// memories, meals and callouts/polls for the period. Generated on request
// (not cached/stored) with pdfkit, streamed straight to the response.
const express = require('express');
const PDFDocument = require('pdfkit');
const { dbGet, dbAll } = require('../db');
const { ah } = require('../helpers');
const { assertFamilyMember, assertGroupMember } = require('./families');

const router = express.Router();

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(dateStr, diff);
}
function periodRange(period, startParam) {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(startParam || '') ? startParam : new Date().toISOString().slice(0, 10);
  if (period === 'month') {
    const d = new Date(anchor + 'T00:00:00Z');
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const label = new Date(start + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    return { start, end, label };
  }
  const start = mondayOf(anchor);
  const end = addDays(start, 7);
  const label = `${fmtShort(start)} – ${fmtShort(addDays(end, -1))}`;
  return { start, end, label };
}
function fmtShort(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const isoStart = (dateStr) => dateStr + 'T00:00:00.000Z';
const isoEnd = (dateStr) => dateStr + 'T00:00:00.000Z';

const RATING_LABELS = { delicious: 'Delicious', edible: 'Edible', takeaway_next_time: 'Takeaway next time' };

// ---- data gathering ----

async function eventsIn(where, params, range) {
  return dbAll(
    `SELECT * FROM events WHERE ${where} AND "startsAt" >= $${params.length + 1} AND "startsAt" < $${params.length + 2} ORDER BY "startsAt" ASC`,
    [...params, isoStart(range.start), isoEnd(range.end)]
  );
}
async function memoriesIn(where, params, range) {
  return dbAll(
    `SELECT * FROM memories WHERE ${where} AND "createdAt" >= $${params.length + 1} AND "createdAt" < $${params.length + 2} ORDER BY date ASC`,
    [...params, isoStart(range.start), isoEnd(range.end)]
  );
}
async function calloutsIn(where, params, range) {
  return dbAll(
    `SELECT * FROM callouts WHERE ${where} AND "createdAt" >= $${params.length + 1} AND "createdAt" < $${params.length + 2} ORDER BY "createdAt" ASC`,
    [...params, isoStart(range.start), isoEnd(range.end)]
  );
}
async function pollsIn(where, params, range) {
  const polls = await dbAll(
    `SELECT * FROM polls WHERE ${where} AND "createdAt" >= $${params.length + 1} AND "createdAt" < $${params.length + 2} ORDER BY "createdAt" ASC`,
    [...params, isoStart(range.start), isoEnd(range.end)]
  );
  for (const p of polls) {
    p.results = await dbAll(
      `SELECT poll_options.label, COUNT(poll_votes."userId")::int as votes FROM poll_options
       LEFT JOIN poll_votes ON poll_votes."optionId" = poll_options.id
       WHERE poll_options."pollId" = $1 GROUP BY poll_options.id, poll_options.label, poll_options.position
       ORDER BY poll_options.position ASC`,
      [p.id]
    );
  }
  return polls;
}

async function buildFamilyData(family, range) {
  const events = await eventsIn('"familyId" = $1', [family.id], range);
  const memories = await memoriesIn('"familyId" = $1', [family.id], range);
  const callouts = await calloutsIn('"familyId" = $1', [family.id], range);
  const polls = await pollsIn('"familyId" = $1', [family.id], range);
  const completedTodos = await dbAll(
    `SELECT todos.*, users.name as "assigneeName" FROM todos JOIN users ON users.id = todos."assignedTo"
     WHERE todos."familyId" = $1 AND todos.status = 'complete' AND todos."completedAt" >= $2 AND todos."completedAt" < $3
     ORDER BY todos."completedAt" ASC`,
    [family.id, isoStart(range.start), isoEnd(range.end)]
  );
  const failedTodos = await dbAll(
    `SELECT COUNT(*)::int as n FROM todos WHERE "familyId" = $1 AND status = 'failed' AND "completedAt" >= $2 AND "completedAt" < $3`,
    [family.id, isoStart(range.start), isoEnd(range.end)]
  );
  const pendingTodos = await dbAll(
    `SELECT todos.*, users.name as "assigneeName" FROM todos JOIN users ON users.id = todos."assignedTo"
     WHERE todos."familyId" = $1 AND todos.status = 'pending' ORDER BY todos."dueAt" ASC NULLS LAST LIMIT 20`,
    [family.id]
  );
  const mealDays = await dbAll(
    `SELECT weekly_meal_days.day, weekly_meal_days."weekStart", recipes.title as "recipeTitle" FROM weekly_meal_days
     LEFT JOIN recipes ON recipes.id = weekly_meal_days."recipeId"
     WHERE weekly_meal_days."familyId" = $1 AND weekly_meal_days."weekStart" >= $2 AND weekly_meal_days."weekStart" < $3
       AND weekly_meal_days."recipeId" IS NOT NULL
     ORDER BY weekly_meal_days."weekStart" ASC`,
    [family.id, range.start, range.end]
  );
  const ratings = await dbAll(
    `SELECT meal_ratings.rating, COUNT(*)::int as n FROM meal_ratings
     JOIN weekly_meal_days ON weekly_meal_days.id = meal_ratings."weeklyMealDayId"
     WHERE weekly_meal_days."familyId" = $1 AND meal_ratings."respondedAt" >= $2 AND meal_ratings."respondedAt" < $3 AND meal_ratings.rating IS NOT NULL
     GROUP BY meal_ratings.rating`,
    [family.id, isoStart(range.start), isoEnd(range.end)]
  );
  const highFives = await dbGet(
    `SELECT COUNT(*)::int as n FROM high_fives JOIN todos ON todos.id = high_fives."todoId"
     WHERE todos."familyId" = $1 AND high_fives."createdAt" >= $2 AND high_fives."createdAt" < $3`,
    [family.id, isoStart(range.start), isoEnd(range.end)]
  );
  return {
    title: family.name, subtitle: 'Family summary', events, memories, callouts, polls,
    completedTodos, failedCount: failedTodos[0].n, pendingTodos, mealDays, ratings, highFivesCount: highFives.n
  };
}

async function buildGroupData(group, range) {
  const events = await eventsIn('"groupId" = $1', [group.id], range);
  const memories = await memoriesIn('"groupId" = $1', [group.id], range);
  const callouts = await calloutsIn('"groupId" = $1', [group.id], range);
  const polls = await pollsIn('"groupId" = $1', [group.id], range);
  return { title: group.name, subtitle: 'Friend group summary', events, memories, callouts, polls };
}

async function buildUserData(targetUser, family, range) {
  const completedTodos = await dbAll(
    `SELECT * FROM todos WHERE "familyId" = $1 AND "assignedTo" = $2 AND status = 'complete'
       AND "completedAt" >= $3 AND "completedAt" < $4 ORDER BY "completedAt" ASC`,
    [family.id, targetUser.id, isoStart(range.start), isoEnd(range.end)]
  );
  const failedCountRow = await dbGet(
    `SELECT COUNT(*)::int as n FROM todos WHERE "familyId" = $1 AND "assignedTo" = $2 AND status = 'failed'
       AND "completedAt" >= $3 AND "completedAt" < $4`,
    [family.id, targetUser.id, isoStart(range.start), isoEnd(range.end)]
  );
  const pendingTodos = await dbAll(
    `SELECT * FROM todos WHERE "familyId" = $1 AND "assignedTo" = $2 AND status = 'pending' ORDER BY "dueAt" ASC NULLS LAST LIMIT 20`,
    [family.id, targetUser.id]
  );
  const events = await dbAll(
    `SELECT events.* FROM events JOIN event_attendees ON event_attendees."eventId" = events.id
     WHERE events."familyId" = $1 AND event_attendees."userId" = $2 AND event_attendees.status = 'accepted'
       AND events."startsAt" >= $3 AND events."startsAt" < $4 ORDER BY events."startsAt" ASC`,
    [family.id, targetUser.id, isoStart(range.start), isoEnd(range.end)]
  );
  const memories = await dbAll(
    `SELECT * FROM memories WHERE "familyId" = $1 AND "createdBy" = $2 AND "createdAt" >= $3 AND "createdAt" < $4 ORDER BY date ASC`,
    [family.id, targetUser.id, isoStart(range.start), isoEnd(range.end)]
  );
  const highFivesReceived = await dbGet(
    `SELECT COUNT(*)::int as n FROM high_fives WHERE "toUserId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3`,
    [targetUser.id, isoStart(range.start), isoEnd(range.end)]
  );
  const highFivesGiven = await dbGet(
    `SELECT COUNT(*)::int as n FROM high_fives WHERE "fromUserId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3`,
    [targetUser.id, isoStart(range.start), isoEnd(range.end)]
  );
  return {
    title: targetUser.name, subtitle: `Personal summary — ${family.name}`, events, memories,
    completedTodos, failedCount: failedCountRow.n, pendingTodos,
    highFivesReceived: highFivesReceived.n, highFivesGiven: highFivesGiven.n
  };
}

// ---- PDF rendering ----

function heading(doc, text) {
  doc.moveDown(0.8);
  doc.fontSize(14).fillColor('#c2477c').text(text, { underline: false });
  doc.fillColor('#111').fontSize(11);
  doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).strokeColor('#ecd7db').stroke();
  doc.moveDown(0.4);
}
function line(doc, text) {
  doc.fontSize(10.5).fillColor('#111').text(text);
}
function emptyLine(doc, text) {
  doc.fontSize(10.5).fillColor('#7a5d6c').text(text);
}

function renderSummaryPdf(doc, data) {
  doc.fontSize(20).fillColor('#c2477c').text('The Memory Maker', { continued: false });
  doc.fontSize(16).fillColor('#111').text(data.title);
  doc.fontSize(11).fillColor('#7a5d6c').text(`${data.subtitle} · ${data.periodLabel}`);
  doc.moveDown(0.5);

  if (data.events) {
    heading(doc, `Calendar (${data.events.length})`);
    if (!data.events.length) emptyLine(doc, 'Nothing on the calendar this period.');
    for (const ev of data.events) line(doc, `• ${fmtDateTime(ev.startsAt)} — ${ev.private ? 'Busy' : ev.title}${ev.location ? ' (' + ev.location + ')' : ''}`);
  }

  if (data.completedTodos) {
    heading(doc, `To-dos — ${data.completedTodos.length} completed, ${data.failedCount} missed`);
    if (!data.completedTodos.length) emptyLine(doc, 'No completed tasks this period.');
    for (const t of data.completedTodos) line(doc, `• ${t.title}${t.assigneeName ? ' — ' + t.assigneeName : ''} (${fmtShort(t.completedAt.slice(0, 10))})`);
    if (data.pendingTodos && data.pendingTodos.length) {
      doc.moveDown(0.3);
      doc.fontSize(10.5).fillColor('#a66a1f').text(`Still open (${data.pendingTodos.length}${data.pendingTodos.length === 20 ? '+' : ''}):`);
      for (const t of data.pendingTodos) line(doc, `• ${t.title}${t.assigneeName ? ' — ' + t.assigneeName : ''}${t.dueAt ? ' (due ' + fmtShort(t.dueAt.slice(0, 10)) + ')' : ''}`);
    }
  }

  if (data.memories) {
    heading(doc, `Memories added (${data.memories.length})`);
    if (!data.memories.length) emptyLine(doc, 'No new memories this period.');
    for (const m of data.memories) line(doc, `• ${fmtShort(m.date)} — ${m.title || 'Untitled'}`);
  }

  if (data.mealDays) {
    heading(doc, `Meals planned (${data.mealDays.length})`);
    if (!data.mealDays.length) emptyLine(doc, 'No meals were planned this period.');
    for (const d of data.mealDays) line(doc, `• ${d.day.charAt(0).toUpperCase() + d.day.slice(1)} — ${d.recipeTitle}`);
    if (data.ratings && data.ratings.length) {
      doc.moveDown(0.3);
      for (const r of data.ratings) line(doc, `${RATING_LABELS[r.rating] || r.rating}: ${r.n}`);
    }
  }

  if (data.callouts) {
    heading(doc, `Call-to-actions (${data.callouts.length})`);
    if (!data.callouts.length) emptyLine(doc, 'None this period.');
    for (const c of data.callouts) line(doc, `• ${c.title} — ${c.status}`);
  }

  if (data.polls) {
    heading(doc, `Polls (${data.polls.length})`);
    if (!data.polls.length) emptyLine(doc, 'None this period.');
    for (const p of data.polls) {
      line(doc, `• ${p.question}`);
      for (const r of p.results) line(doc, `    ${r.label}: ${r.votes}`);
    }
  }

  if (data.highFivesCount !== undefined) {
    heading(doc, 'High-fives');
    line(doc, `🙌 ${data.highFivesCount} given across the family this period.`);
  }
  if (data.highFivesReceived !== undefined) {
    heading(doc, 'High-fives');
    line(doc, `🙌 Received: ${data.highFivesReceived}    Given: ${data.highFivesGiven}`);
  }
}

// GET /api/summary/export?scope=family|group|user&familyId=...&groupId=...&userId=...&period=week|month&start=YYYY-MM-DD
router.get('/summary/export', ah(async (req, res) => {
  const { scope, familyId, groupId, userId } = req.query;
  const period = req.query.period === 'month' ? 'month' : 'week';
  const range = periodRange(period, req.query.start);
  let data;

  if (scope === 'family') {
    if (!familyId) return res.status(400).json({ error: 'familyId is required' });
    if (!(await assertFamilyMember(req, res, familyId))) return;
    const family = await dbGet('SELECT * FROM families WHERE id = $1', [familyId]);
    if (!family) return res.status(404).json({ error: 'Not found' });
    data = await buildFamilyData(family, range);
  } else if (scope === 'group') {
    if (!groupId) return res.status(400).json({ error: 'groupId is required' });
    if (!(await assertGroupMember(req, res, groupId))) return;
    const group = await dbGet('SELECT * FROM friend_groups WHERE id = $1', [groupId]);
    if (!group) return res.status(404).json({ error: 'Not found' });
    data = await buildGroupData(group, range);
  } else if (scope === 'user') {
    if (!familyId) return res.status(400).json({ error: 'familyId is required for a user summary' });
    if (!(await assertFamilyMember(req, res, familyId))) return;
    const targetId = userId || req.user.id;
    const targetUser = await dbGet('SELECT id, name FROM users WHERE id = $1', [targetId]);
    if (!targetUser) return res.status(404).json({ error: 'Not found' });
    const targetInFamily = await dbGet('SELECT 1 FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [familyId, targetId]);
    if (!targetInFamily) return res.status(403).json({ error: 'That person is not a member of this family' });
    const family = await dbGet('SELECT * FROM families WHERE id = $1', [familyId]);
    data = await buildUserData(targetUser, family, range);
  } else {
    return res.status(400).json({ error: "scope must be 'family', 'group' or 'user'" });
  }

  data.periodLabel = `${period === 'month' ? 'Month' : 'Week'} of ${range.label}`;
  const filename = `memory-maker-${scope}-summary-${range.start}.pdf`;
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);
  renderSummaryPdf(doc, data);
  doc.end();
}));

module.exports = { router };
