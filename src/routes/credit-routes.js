'use strict';
const express = require('express');
const credits = require('../credits');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// The user's own credit state. Never workspace-scoped: a second workspace must not
// look like a second balance.
router.get('/credits', (req, res) => {
  res.json({
    ...credits.balance(req.user.id),
    jobs: credits.listJobs(req.user.id, 10),
    ledger: credits.ledgerFor(req.user.id, 20)
  });
});

module.exports = router;
