const axios = require('axios');
const cheerio = require('cheerio');

async function analyzeContent(url) {
  const { data: html } = await axios.get(url, { timeout: 10000 });
  const $ = cheerio.load(html);

  const title = $('title').text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get();
  const wordCount = $('body').text().trim().split(/\s+/).length;
  const images = $('img');
  const imagesMissingAlt = images.filter((_, el) => !$(el).attr('alt')).length;

  return {
    title,
    titleLength: title.length,
    metaDescription,
    metaDescriptionLength: metaDescription.length,
    h1Count: h1s.length,
    h1s,
    wordCount,
    imageCount: images.length,
    imagesMissingAlt,
  };
}

module.exports = { analyzeContent };
