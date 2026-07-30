function scoreContent(content) {
  let score = 100;
  const issues = [];

  if (!content.title || content.titleLength === 0) {
    score -= 15;
    issues.push('missing_title');
  } else if (content.titleLength > 60) {
    score -= 5;
    issues.push('title_too_long');
  }

  if (!content.metaDescription) {
    score -= 15;
    issues.push('missing_meta_description');
  } else if (content.metaDescriptionLength > 160) {
    score -= 5;
    issues.push('meta_description_too_long');
  }

  if (content.h1Count === 0) {
    score -= 10;
    issues.push('missing_h1');
  } else if (content.h1Count > 1) {
    score -= 5;
    issues.push('multiple_h1');
  }

  if (content.imagesMissingAlt > 0) {
    score -= Math.min(20, content.imagesMissingAlt * 2);
    issues.push('images_missing_alt');
  }

  if (content.wordCount < 300) {
    score -= 10;
    issues.push('thin_content');
  }

  return { score: Math.max(0, Math.round(score)), issues };
}

module.exports = { scoreContent };
