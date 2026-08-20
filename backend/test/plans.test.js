const test = require('node:test');
const assert = require('node:assert/strict');
const { PLANS } = require('../config/plans');

const EXPECTED_PLAN_KEYS = ['free', 'starter', 'pro', 'agency'];
const VALID_CATEGORIES = ['technical', 'content', 'keywords', 'backlinks'];

test('has exactly the four expected plans', () => {
  assert.deepEqual(Object.keys(PLANS).sort(), EXPECTED_PLAN_KEYS.sort());
});

test('every plan only references valid categories', () => {
  for (const [key, plan] of Object.entries(PLANS)) {
    for (const category of plan.categories) {
      assert.ok(VALID_CATEGORIES.includes(category), `${key} has invalid category "${category}"`);
    }
  }
});

test('free plan uses a lifetime limit, not a monthly one', () => {
  assert.equal(PLANS.free.auditsPerMonth, 0);
  assert.equal(PLANS.free.lifetimeFullAudits, 1);
});

test('paid plans increase in scope: starter < pro < agency', () => {
  assert.ok(PLANS.starter.categories.length < PLANS.pro.categories.length);
  assert.equal(PLANS.pro.categories.length, VALID_CATEGORIES.length);
  assert.equal(PLANS.agency.categories.length, VALID_CATEGORIES.length);
});

test('only free plan omits a Stripe price id', () => {
  assert.equal(PLANS.free.stripePriceId, undefined);
  for (const key of ['starter', 'pro', 'agency']) {
    assert.ok('stripePriceId' in PLANS[key], `${key} should reference a Stripe price env var`);
  }
});

test('agency plan is unlimited on both axes', () => {
  assert.equal(PLANS.agency.auditsPerMonth, null);
  assert.equal(PLANS.agency.maxDomains, null);
});

test('AEO tracking is capped on every plan, never unlimited — each check is a real paid API call', () => {
  for (const plan of Object.values(PLANS)) {
    assert.ok(Number.isFinite(plan.aeoQueriesPerMonth), `${plan.name} must define a finite aeoQueriesPerMonth`);
  }
});

test('only Pro and Agency include AEO tracking', () => {
  assert.equal(PLANS.free.aeoQueriesPerMonth, 0);
  assert.equal(PLANS.starter.aeoQueriesPerMonth, 0);
  assert.ok(PLANS.pro.aeoQueriesPerMonth > 0);
  assert.ok(PLANS.agency.aeoQueriesPerMonth > PLANS.pro.aeoQueriesPerMonth);
});

test('backlink gap analysis is Agency only — it is the most expensive backlinks API call', () => {
  assert.equal(PLANS.free.backlinkGapAnalysis, false);
  assert.equal(PLANS.starter.backlinkGapAnalysis, false);
  assert.equal(PLANS.pro.backlinkGapAnalysis, false);
  assert.equal(PLANS.agency.backlinkGapAnalysis, true);
});

test('rank tracking is capped on every plan, never unlimited — each check is a real paid SERP API call', () => {
  for (const plan of Object.values(PLANS)) {
    assert.ok(Number.isFinite(plan.rankTrackingChecksPerMonth), `${plan.name} must define a finite rankTrackingChecksPerMonth`);
  }
});

test('only Pro and Agency include rank tracking, at the same total paid-provider-call budget as AEO tracking', () => {
  assert.equal(PLANS.free.rankTrackingChecksPerMonth, 0);
  assert.equal(PLANS.starter.rankTrackingChecksPerMonth, 0);
  assert.ok(PLANS.pro.rankTrackingChecksPerMonth > 0);
  assert.ok(PLANS.agency.rankTrackingChecksPerMonth > PLANS.pro.rankTrackingChecksPerMonth);
  // AEO hits 2 providers/check, rank tracking hits 1, so double the queries
  // buys the same total provider-call volume on each plan.
  assert.equal(PLANS.pro.rankTrackingChecksPerMonth, PLANS.pro.aeoQueriesPerMonth * 2);
  assert.equal(PLANS.agency.rankTrackingChecksPerMonth, PLANS.agency.aeoQueriesPerMonth * 2);
});
