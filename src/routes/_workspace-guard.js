'use strict';
// Single place that turns :workspaceId into an authorised workspace.
module.exports = function requireWorkspaceRoute() {
  // eslint-disable-next-line global-require
  const { requireWorkspace } = require('../auth');
  return requireWorkspace();
};
