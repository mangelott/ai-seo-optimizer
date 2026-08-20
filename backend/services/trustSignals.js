const axios = require('axios');

// Common contact/about and privacy-policy paths, checked directly via HTTP
// (no crawling/link parsing) — this is a quick hygiene checklist, not the
// core product, so it doesn't need to be exhaustive.
const CONTACT_PATHS = ['/contact', '/about', '/sobre', '/contacto'];
const PRIVACY_PATHS = ['/privacy-policy', '/privacy', '/politica-de-privacidade', '/privacidade'];

// Same string-concatenation approach as services/crawlability.js's
// toBaseUrl: preserves whatever scheme the caller passed (so tests can use
// a path-prefixed http:// base to run several fixture "sites" off one fake
// server), defaulting to https when none is given.
function toBaseUrl(domain) {
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  return base.replace(/\/+$/, '');
}

// Always forces the https scheme, regardless of what the caller passed —
// this check exists specifically to answer "does this host serve over
// HTTPS", not "what did checkTrustSignals happen to be called with".
function toHttpsUrl(domain) {
  const host = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${host}`;
}

async function checkHttpsActive(domain) {
  try {
    await axios.get(toHttpsUrl(domain), { timeout: 10000, validateStatus: () => true });
    return true;
  } catch {
    return false;
  }
}

// Checks candidate paths in order and stops at the first one that exists,
// to avoid firing every candidate request against every audited domain.
async function findFirstExistingPage(baseUrl, paths) {
  for (const path of paths) {
    try {
      const response = await axios.get(`${baseUrl}${path}`, { timeout: 8000, validateStatus: () => true });
      if (response.status === 200) return { found: true, url: `${baseUrl}${path}` };
    } catch {
      // try the next candidate
    }
  }
  return { found: false, url: null };
}

async function checkTrustSignals(domain) {
  const baseUrl = toBaseUrl(domain);
  const [httpsActive, contactPage, privacyPolicy] = await Promise.all([
    checkHttpsActive(domain),
    findFirstExistingPage(baseUrl, CONTACT_PATHS),
    findFirstExistingPage(baseUrl, PRIVACY_PATHS),
  ]);

  return { httpsActive, contactPage, privacyPolicy };
}

module.exports = { checkTrustSignals, checkHttpsActive, findFirstExistingPage };
