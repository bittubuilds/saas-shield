'use strict';
// Authentication mode.
//
// Email verification is only required when this deployment can actually deliver
// mail to arbitrary users. A Resend test sender cannot, and neither can a
// deployment with no provider at all - requiring verification there would lock
// every new account out of the product.
//
// An explicit AUTH_REQUIRE_EMAIL_VERIFICATION always wins, so a deployment can
// force either behaviour. Nothing here touches password hashing, sessions,
// authorization or rate limits: it only decides whether a new account starts
// verified or has to confirm an address first.

function emailCanReachRealUsers(emailConfig) {
  const em = emailConfig || {};
  const providerReady =
    (em.provider === 'resend' && Boolean(em.resendApiKey)) ||
    (em.provider === 'webhook' && Boolean(em.webhookUrl)) ||
    Boolean(em.devSinkFile);
  if (!providerReady) return false;
  // Resend's shared test sender only ever reaches the account owner.
  if (/@resend\.dev>?$/i.test(String(em.from || ''))) return false;
  return true;
}

function apply(config) {
  const reachable = emailCanReachRealUsers(config.email);
  if (process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === undefined) {
    config.auth.requireEmailVerification = reachable;
  }
  config.auth.mode = config.auth.requireEmailVerification ? 'verified' : 'instant';
  config.auth.emailReachable = reachable;
  config.auth.modeSource = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === undefined
    ? 'derived'
    : 'AUTH_REQUIRE_EMAIL_VERIFICATION';
  return config.auth;
}

module.exports = { apply, emailCanReachRealUsers };
