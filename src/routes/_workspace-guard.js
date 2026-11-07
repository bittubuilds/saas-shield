'use strict';
// Single place that turns :workspaceId into an authorised workspace.
//
// This is Express middleware itself. It resolves requireWorkspace() lazily on
// first use, because auth.js pulls in the routers and a top-level require here
// would close the cycle.
//
// History: this used to export a factory that returned the middleware, while
// every route mounted it as `requireWorkspaceRoute()`. The factory was never
// called, so an authenticated request reached a function that returned another
// function and never called next(): the response hung until the client timed
// out. The HTTP tests in tests/ai-api.test.js caught it.
module.exports = function workspaceGuard(req, res, next) {
  // eslint-disable-next-line global-require
  const { requireWorkspace } = require('../auth');
  return requireWorkspace()(req, res, next);
};
