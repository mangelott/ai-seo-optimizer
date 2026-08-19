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
  },
};

module.exports = { PLANS };
