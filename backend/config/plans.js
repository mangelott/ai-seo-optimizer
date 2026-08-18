const PLANS = {
  free: {
    name: 'Free',
    lifetimeFullAudits: 1,
    auditsPerMonth: 0,
    maxDomains: 1,
    categories: ['technical', 'content'],
    siteWideCrawl: false,
  },
  starter: {
    name: 'Starter',
    stripePriceId: process.env.STRIPE_PRICE_STARTER,
    auditsPerMonth: 10,
    maxDomains: 1,
    categories: ['technical', 'content'],
    siteWideCrawl: false,
  },
  pro: {
    name: 'Pro',
    stripePriceId: process.env.STRIPE_PRICE_PRO,
    auditsPerMonth: 100,
    maxDomains: 10,
    categories: ['technical', 'content', 'keywords', 'backlinks'],
    siteWideCrawl: true,
  },
  agency: {
    name: 'Agency',
    stripePriceId: process.env.STRIPE_PRICE_AGENCY,
    auditsPerMonth: null,
    maxDomains: null,
    categories: ['technical', 'content', 'keywords', 'backlinks'],
    siteWideCrawl: true,
  },
};

module.exports = { PLANS };
