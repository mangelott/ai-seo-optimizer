const PLANS = {
  free: {
    name: 'Free',
    lifetimeFullAudits: 1,
    auditsPerMonth: 0,
    maxDomains: 1,
    categories: ['technical', 'content'],
    siteWideCrawl: false,
    aeoQueriesPerMonth: 0,
    backlinkGapAnalysis: false,
    rankTrackingChecksPerMonth: 0,
  },
  starter: {
    name: 'Starter',
    stripePriceId: process.env.STRIPE_PRICE_STARTER,
    auditsPerMonth: 10,
    maxDomains: 1,
    categories: ['technical', 'content'],
    siteWideCrawl: false,
    aeoQueriesPerMonth: 0,
    backlinkGapAnalysis: false,
    rankTrackingChecksPerMonth: 0,
  },
  pro: {
    name: 'Pro',
    stripePriceId: process.env.STRIPE_PRICE_PRO,
    auditsPerMonth: 100,
    maxDomains: 10,
    categories: ['technical', 'content', 'keywords', 'backlinks'],
    siteWideCrawl: true,
    // Each check queries both ChatGPT and Perplexity (2 paid API calls), so this
    // caps real per-query cost — unlike `categories`, which only gates DataForSEO
    // calls already covered by the subscription price.
    aeoQueriesPerMonth: 20,
    // Domain Intersection is the most expensive DataForSEO backlinks call
    // (one lookup per competitor domain), so it's gated separately from the
    // `backlinks` category (which only covers the flat-rate summary call) and
    // kept Agency-only for now.
    backlinkGapAnalysis: false,
    // jobs/rankTracking.js checks daily (positions move faster than AI-assistant
    // citations), so a per-domain headcount alone doesn't bound cost the way
    // aeoQueriesPerMonth does — Pro allows up to 10 domains, so a per-domain cap
    // would scale with domain count instead of staying a flat monthly budget like
    // every other quota in this file. Capped as total checks/month instead — the
    // same "provider calls spent" budget as aeoQueriesPerMonth, doubled because
    // rank tracking hits one provider (DataForSEO) per check where AEO hits two
    // (OpenAI + Perplexity) per check. The per-domain list itself is still capped,
    // but only by a small fixed constant for readability (MAX_TRACKED_KEYWORDS_PER_DOMAIN
    // in routes/trackedKeywords.js) — cost is bounded here, not by list size.
    rankTrackingChecksPerMonth: 40,
  },
  agency: {
    name: 'Agency',
    stripePriceId: process.env.STRIPE_PRICE_AGENCY,
    auditsPerMonth: null,
    maxDomains: null,
    categories: ['technical', 'content', 'keywords', 'backlinks'],
    siteWideCrawl: true,
    aeoQueriesPerMonth: 100,
    backlinkGapAnalysis: true,
    rankTrackingChecksPerMonth: 200,
  },
};

module.exports = { PLANS };
