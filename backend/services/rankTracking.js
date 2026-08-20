const serpAnalysis = require('./serpAnalysis');

// Same bare-host normalization as services/aeoTracking.js's normalizeDomain,
// duplicated locally rather than shared — both are five-line pure functions
// used for a single domain-identity comparison each.
function normalizeDomain(domain) {
  return domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

// A result "is" the tracked domain if its URL's host is the domain itself or
// a subdomain of it — any page on the site counts toward the domain's rank,
// not just an exact host match, since SERPs commonly rank a blog/docs
// subdomain instead of the bare domain.
function hostMatchesDomain(url, bareDomain) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  return host === bareDomain || host.endsWith(`.${bareDomain}`);
}

// position is the domain's best rank among the top 10 organic results
// (services/serpAnalysis.js getTopResults' own depth cap) for that keyword,
// or null when the domain doesn't appear there at all — "unranked", not zero.
async function checkPosition(keyword, domain, locationCode, languageCode) {
  const results = await serpAnalysis.getTopResults(keyword, locationCode, languageCode);
  const bareDomain = normalizeDomain(domain);
  const match = results.find((r) => hostMatchesDomain(r.url, bareDomain));
  return { position: match ? match.rank : null };
}

module.exports = { checkPosition, normalizeDomain };
