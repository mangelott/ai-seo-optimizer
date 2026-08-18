const axios = require('axios');
const { client: dataForSeoClient } = require('./dataforseo');

// Overridable so integration tests can point this at a local fake PageSpeed
// Insights server instead of stubbing the whole module — same pattern as
// DATAFORSEO_API_BASE_URL in services/dataforseo.js.
const PAGESPEED_API_BASE_URL =
  process.env.PAGESPEED_API_BASE_URL || 'https://www.googleapis.com/pagespeedonline/v5';

// Google's published Core Web Vitals thresholds.
// https://web.dev/articles/defining-core-web-vitals-thresholds
const THRESHOLDS = {
  lcp: { good: 2500, needsImprovement: 4000 }, // ms
  inp: { good: 200, needsImprovement: 500 }, // ms
  cls: { good: 0.1, needsImprovement: 0.25 }, // unitless
};

function classify(metric, value) {
  if (value == null) return null;
  const t = THRESHOLDS[metric];
  if (value <= t.good) return 'good';
  if (value <= t.needsImprovement) return 'needs-improvement';
  return 'poor';
}

function buildResult({ lcp, inp, cls, performanceScore }) {
  return {
    lcp: lcp == null ? null : { value: lcp, rating: classify('lcp', lcp) },
    inp: inp == null ? null : { value: inp, rating: classify('inp', inp) },
    cls: cls == null ? null : { value: cls, rating: classify('cls', cls) },
    performanceScore: performanceScore ?? null,
  };
}

async function getFromDataForSeo(url) {
  const { data } = await dataForSeoClient.post('/on_page/lighthouse/live/json', [{ url }]);
  const result = data.tasks?.[0]?.result?.[0];
  const audits = result?.audits;
  if (!audits) throw new Error('DataForSEO Lighthouse returned no audits (account may not have access)');

  return buildResult({
    lcp: audits['largest-contentful-paint']?.numericValue ?? null,
    inp: audits['interaction-to-next-paint']?.numericValue ?? null,
    cls: audits['cumulative-layout-shift']?.numericValue ?? null,
    performanceScore:
      result.categories?.performance?.score != null
        ? Math.round(result.categories.performance.score * 100)
        : null,
  });
}

async function getFromPageSpeedInsights(url) {
  const { data } = await axios.get(`${PAGESPEED_API_BASE_URL}/runPagespeed`, {
    params: { url, key: process.env.GOOGLE_PAGESPEED_API_KEY, category: 'performance', strategy: 'mobile' },
  });

  // Prefer real-user field data (CrUX) over lab-simulated Lighthouse audits
  // when available — that's what makes these "real" Core Web Vitals.
  const fieldMetrics = data.loadingExperience?.metrics;
  const labAudits = data.lighthouseResult?.audits;

  const lcp = fieldMetrics?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? labAudits?.['largest-contentful-paint']?.numericValue ?? null;
  const inp = fieldMetrics?.INTERACTION_TO_NEXT_PAINT?.percentile ?? labAudits?.['interaction-to-next-paint']?.numericValue ?? null;
  const cls =
    fieldMetrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
      ? fieldMetrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
      : labAudits?.['cumulative-layout-shift']?.numericValue ?? null;
  const performanceScore =
    data.lighthouseResult?.categories?.performance?.score != null
      ? Math.round(data.lighthouseResult.categories.performance.score * 100)
      : null;

  return buildResult({ lcp, inp, cls, performanceScore });
}

async function getCoreWebVitals(url) {
  try {
    return await getFromDataForSeo(url);
  } catch (err) {
    console.error(
      'DataForSEO Lighthouse unavailable, falling back to PageSpeed Insights:',
      err.response?.data || err.message
    );
    return getFromPageSpeedInsights(url);
  }
}

module.exports = { getCoreWebVitals, classify, THRESHOLDS };
