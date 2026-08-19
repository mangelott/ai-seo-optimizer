import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import '../i18n';
import i18n from '../i18n';
import ReportBody from './ReportBody';

const BASE_AUDIT = {
  domain: 'https://example.com',
  score: 82,
  crawl_status: 'completed',
  created_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:00.000Z',
  ai_recommendations: [],
};

function siteWideAudit(overrides = {}) {
  return {
    ...BASE_AUDIT,
    pages_crawled_count: 4,
    technical_result: {
      crawlType: 'site_wide',
      pagesCrawled: 4,
      pages4xx: 1,
      pages5xx: 1,
      duplicateTitles: [],
      orphanPages: ['https://example.com/contact'],
      orphanPagesCount: 1,
      brokenInternalLinks: [
        { fromUrl: 'https://example.com/', toUrl: 'https://example.com/missing', anchorText: 'Old link', statusCode: 404 },
      ],
      brokenInternalLinksCount: 1,
      ...overrides,
    },
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('ReportBody — site structure tab', () => {
  it('does not show a "Site structure" tab when the audit has no site-wide crawl', () => {
    render(<ReportBody audit={BASE_AUDIT} />);
    expect(screen.queryByText('Site structure')).not.toBeInTheDocument();
  });

  it('does not show the tab when the crawl exists but link-graph data was never computed', () => {
    const audit = siteWideAudit();
    delete audit.technical_result.orphanPages;
    delete audit.technical_result.brokenInternalLinks;
    render(<ReportBody audit={audit} />);
    expect(screen.queryByText('Site structure')).not.toBeInTheDocument();
  });

  it('shows orphan pages and broken internal links when the "Site structure" tab is selected', () => {
    render(<ReportBody audit={siteWideAudit()} />);

    fireEvent.click(screen.getByText('Site structure'));

    expect(screen.getByText('https://example.com/contact')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/missing')).toBeInTheDocument();
    expect(screen.getByText('(404)')).toBeInTheDocument();
  });

  it('shows the empty states when there are no orphan pages or broken links', () => {
    render(
      <ReportBody
        audit={siteWideAudit({ orphanPages: [], orphanPagesCount: 0, brokenInternalLinks: [], brokenInternalLinksCount: 0 })}
      />
    );

    fireEvent.click(screen.getByText('Site structure'));

    expect(screen.getByText(/No orphan pages found/)).toBeInTheDocument();
    expect(screen.getByText('No broken internal links found.')).toBeInTheDocument();
  });

  it('hides the severity filter row while the structure tab is active', () => {
    render(<ReportBody audit={siteWideAudit()} />);
    expect(screen.getByText('All (0)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Site structure'));
    expect(screen.queryByText(/^All \(/)).not.toBeInTheDocument();
  });

  it('renders correctly in Portuguese', async () => {
    await i18n.changeLanguage('pt');
    render(<ReportBody audit={siteWideAudit()} />);
    fireEvent.click(screen.getByText('Estrutura do site'));
    expect(screen.getByText('Páginas órfãs (1)')).toBeInTheDocument();
    expect(screen.getByText('Ligações internas partidas (1)')).toBeInTheDocument();
  });
});
