const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { ah, isNonEmptyString, newId } = require('../helpers');
const { assertFamilyMember } = require('./families');

const router = express.Router();

async function highFivesOf(todoId) {
  return dbAll(
    `SELECT high_fives.id, high_fives."createdAt", users.id as "fromUserId", users.name as "fromUserName"
     FROM high_fives JOIN users ON users.id = high_fives."fromUserId"
     WHERE high_fives."todoId" = $1 ORDER BY high_fives."createdAt" ASC`,
    [todoId]
  );
}

router.get('/todos', ah(async (req, res) => {
  const { familyId, assignedTo, status } = req.query;
  if (!familyId) return res.status(400).json({ error: 'familyId is required' });
  if (!(await assertFamilyMember(req, res, familyId))) return;
  let where = '"familyId" = $1';
  const params = [familyId];
  if (assignedTo) { where += ' AND "assignedTo" = $' + (params.length + 1); params.push(assignedTo); }
  if (status) { where += ' AND status = $' + (params.length + 1); params.push(status); }
  const rows = await dbAll(`SELECT * FROM todos WHERE ${where} ORDER BY (status='pending') DESC, "dueAt" ASC NULLS LAST, "createdAt" DESC`, params);
  for (const t of rows) t.highFives = await highFivesOf(t.id);
  res.json({ todos: rows });
}));

router.post('/todos', ah(async (req, res) => {
  const b = req.body || {};
  if (!isNonEmptyString(b.familyId)) return res.status(400).json({ error: 'familyId is required' });
  if (!isNonEmptyString(b.title)) return res.status(400).json({ error: 'A title is required' });
  if (!isNonEmptyString(b.assignedTo)) return res.status(400).json({ error: 'assignedTo (a user id) is required' });
  if (!(await assertFamilyMember(req, res, b.familyId))) return;
  const assignee = await dbGet('SELECT 1 FROM family_members WHERE "familyId" = $1 AND "userId" = $2', [b.familyId, b.assignedTo]);
  if (!assignee) return res.status(400).json({ error: 'assignedTo must be a member of this family' });

  const id = newId('todo');
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO todos (id,"familyId","assignedTo",title,notes,"dueAt","reminderOffsetHours","reminderChannel",status,"createdBy","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
    [id, b.familyId, b.assignedTo, b.title.trim(), b.notes || null, b.dueAt || null,
      Number.isFinite(b.reminderOffsetHours) ? b.reminderOffsetHours : null,
      ['app', 'sms', 'both'].includes(b.reminderChannel) ? b.reminderChannel : 'app', req.user.id, now]
  );
  const todo = await dbGet('SELECT * FROM todos WHERE id = $1', [id]);
  todo.highFives = [];
  res.status(201).json({ todo });
}));

async function loadTodo(req, res) {
  const todo = await dbGet('SELECT * FROM todos WHERE id = $1', [req.params.id]);
  if (!todo) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!(await assertFamilyMember(req, res, todo.familyId))) return null;
  return todo;
}

router.patch('/todos/:id', ah(async (req, res) => {
  const todo = await loadTodo(req, res);
  if (!todo) return;
  const b = req.body || {};
  const status = ['pending', 'complete', 'failed'].includes(b.status) ? b.status : todo.status;
  const completedAt = (status === 'complete' || status === 'failed') ? new Date().toISOString() : null;
  await dbRun(
    `UPDATE todos SET title=$1, notes=$2, "dueAt"=$3, "assignedTo"=$4, status=$5, "completedAt"=$6 WHERE id=$7`,
    [b.title || todo.title, b.notes !== undefined ? b.notes : todo.notes, b.dueAt !== undefined ? b.dueAt : todo.dueAt,
      b.assignedTo || todo.assignedTo, status, completedAt, todo.id]
  );
  const updated = await dbGet('SELECT * FROM todos WHERE id = $1', [todo.id]);
  updated.highFives = await highFivesOf(todo.id);
  res.json({ todo: updated });
}));

router.delete('/todos/:id', ah(async (req, res) => {
  const todo = await loadTodo(req, res);
  if (!todo) return;
  if (todo.createdBy !== req.user.id) return res.status(403).json({ error: 'Only the creator can delete this task' });
  await dbRun('DELETE FROM high_fives WHERE "todoId" = $1', [todo.id]);
  await dbRun('DELETE FROM todos WHERE id = $1', [todo.id]);
  res.json({ ok: true });
}));

// A family member celebrating another member's completed task.
router.post('/todos/:id/high-five', ah(async (req, res) => {
  const todo = await loadTodo(req, res);
  if (!todo) return;
  if (todo.status !== 'complete') return res.status(400).json({ error: 'Only completed tasks can get a high-five' });
  if (todo.assignedTo === req.user.id) return res.status(400).json({ error: "You can't high-five your own task" });
  await dbRun('INSERT INTO high_fives (id,"todoId","fromUserId","toUserId","createdAt") VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("todoId","fromUserId") DO NOTHING',
    [newId('hf'), todo.id, req.user.id, todo.assignedTo, new Date().toISOString()]);
  res.json({ highFives: await highFivesOf(todo.id) });
}));

module.exports = { router };
