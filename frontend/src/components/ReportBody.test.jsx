import { describe, it, expect, beforeEach, vi } from 'vitest';
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

function contentGapAudit(contentGapResult) {
  return { ...BASE_AUDIT, content_gap_result: contentGapResult };
}

describe('ReportBody — topic coverage tab', () => {
  it('does not show a "Topic coverage" tab when the audit has no content gap result', () => {
    render(<ReportBody audit={BASE_AUDIT} />);
    expect(screen.queryByText('Topic coverage')).not.toBeInTheDocument();
  });

  it('does not show the tab when content_gap_result is an empty array', () => {
    render(<ReportBody audit={contentGapAudit([])} />);
    expect(screen.queryByText('Topic coverage')).not.toBeInTheDocument();
  });

  it('shows missing subtopics grouped by keyword, sorted as provided, with coverage counts', () => {
    const audit = contentGapAudit([
      {
        keyword: 'best coffee lisbon',
        competitorCount: 8,
        missingSubtopics: [
          { topic: 'Delivery times', competitorsCovering: 6, competitorUrls: [] },
          { topic: 'Pricing', competitorsCovering: 3, competitorUrls: [] },
        ],
      },
    ]);
    render(<ReportBody audit={audit} />);

    fireEvent.click(screen.getByText('Topic coverage'));

    expect(screen.getByText('best coffee lisbon')).toBeInTheDocument();
    expect(screen.getByText('Delivery times')).toBeInTheDocument();
    expect(screen.getByText('Covered by 6 of 8 competitors')).toBeInTheDocument();
    expect(screen.getByText('Pricing')).toBeInTheDocument();
    expect(screen.getByText('Covered by 3 of 8 competitors')).toBeInTheDocument();
  });

  it('shows an empty state for a keyword with no missing subtopics', () => {
    const audit = contentGapAudit([{ keyword: 'well covered keyword', competitorCount: 5, missingSubtopics: [] }]);
    render(<ReportBody audit={audit} />);

    fireEvent.click(screen.getByText('Topic coverage'));

    expect(screen.getByText('well covered keyword')).toBeInTheDocument();
    expect(screen.getByText(/covers everything the top-ranking competitors do/)).toBeInTheDocument();
  });

  it('hides the severity filter row while the topic coverage tab is active', () => {
    const audit = contentGapAudit([{ keyword: 'kw', competitorCount: 1, missingSubtopics: [] }]);
    render(<ReportBody audit={audit} />);
    expect(screen.getByText('All (0)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Topic coverage'));
    expect(screen.queryByText(/^All \(/)).not.toBeInTheDocument();
  });

  it('renders correctly in Portuguese', async () => {
    await i18n.changeLanguage('pt');
    const audit = contentGapAudit([
      { keyword: 'melhor café lisboa', competitorCount: 4, missingSubtopics: [{ topic: 'Preços', competitorsCovering: 3, competitorUrls: [] }] },
    ]);
    render(<ReportBody audit={audit} />);

    fireEvent.click(screen.getByText('Cobertura de tema'));

    expect(screen.getByText('melhor café lisboa')).toBeInTheDocument();
    expect(screen.getByText('Coberto por 3 de 4 concorrentes')).toBeInTheDocument();
  });
});

describe('ReportBody — AI visibility (AEO) tab', () => {
  it('does not show the tab when aeoAvailable is falsy', () => {
    render(<ReportBody audit={BASE_AUDIT} aeoAvailable={false} />);
    expect(screen.queryByText('AI visibility')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no tracked queries yet', () => {
    render(<ReportBody audit={BASE_AUDIT} aeoAvailable aeoData={{ score: null, queries: [] }} />);
    fireEvent.click(screen.getByText('AI visibility'));
    expect(screen.getByText(/No queries tracked yet/)).toBeInTheDocument();
    expect(screen.getByText('Not enough checks yet')).toBeInTheDocument();
  });

  it('shows the score and per-provider citation badges for tracked queries', () => {
    const aeoData = {
      score: 50,
      queries: [
        {
          id: 1,
          query: 'best coffee lisbon',
          lastCheckedAt: '2026-01-01T00:00:00.000Z',
          citedByAny: true,
          results: [
            { provider: 'chatgpt', cited: true },
            { provider: 'perplexity', cited: false },
          ],
        },
        {
          id: 2,
          query: 'never checked query',
          lastCheckedAt: null,
          citedByAny: false,
          results: [],
        },
      ],
    };
    render(<ReportBody audit={BASE_AUDIT} aeoAvailable aeoData={aeoData} />);
    fireEvent.click(screen.getByText('AI visibility'));

    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('AEO Score')).toBeInTheDocument();
    expect(screen.getByText('best coffee lisbon')).toBeInTheDocument();
    expect(screen.getByText('ChatGPT: Cited')).toBeInTheDocument();
    expect(screen.getByText('Perplexity: Not cited')).toBeInTheDocument();
    expect(screen.getByText('never checked query')).toBeInTheDocument();
    expect(screen.getByText('ChatGPT: Not checked yet')).toBeInTheDocument();
  });

  it('calls onAddAeoQuery with the trimmed input value on submit', () => {
    const onAdd = vi.fn().mockResolvedValue();
    render(<ReportBody audit={BASE_AUDIT} aeoAvailable aeoData={{ score: null, queries: [] }} onAddAeoQuery={onAdd} />);
    fireEvent.click(screen.getByText('AI visibility'));

    fireEvent.change(screen.getByPlaceholderText('e.g. best coffee shops in Lisbon'), { target: { value: '  new query  ' } });
    fireEvent.click(screen.getByText('Track query'));

    expect(onAdd).toHaveBeenCalledWith('new query');
  });

  it('calls onDeleteAeoQuery when Remove is clicked', () => {
    const onDelete = vi.fn();
    const aeoData = { score: 0, queries: [{ id: 7, query: 'q', lastCheckedAt: null, citedByAny: false, results: [] }] };
    render(<ReportBody audit={BASE_AUDIT} aeoAvailable aeoData={aeoData} onDeleteAeoQuery={onDelete} />);
    fireEvent.click(screen.getByText('AI visibility'));

    fireEvent.click(screen.getByText('Remove'));
    expect(onDelete).toHaveBeenCalledWith(7);
  });

  it('renders correctly in Portuguese', async () => {
    await i18n.changeLanguage('pt');
    render(<ReportBody audit={BASE_AUDIT} aeoAvailable aeoData={{ score: null, queries: [] }} />);
    fireEvent.click(screen.getByText('Visibilidade em IA'));
    expect(screen.getByText(/Ainda não há queries monitorizadas/)).toBeInTheDocument();
  });
});
