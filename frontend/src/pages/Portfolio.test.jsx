import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import '../i18n';
import i18n from '../i18n';
import { ThemeProvider } from '../context/ThemeContext';

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: api, API_BASE_URL: 'http://localhost:4000/api' };
});

import api from '../api/client';
import Portfolio from './Portfolio';

function resolved(data) {
  return Promise.resolve({ data });
}

const AGENCY_ME = { id: 1, name: 'Ana', email: 'ana@example.com', plan: 'agency' };

function setupApiDefaults({ me = AGENCY_ME, portfolio = [] } = {}) {
  api.get.mockImplementation((path) => {
    if (path === '/auth/me') return resolved(me);
    if (path === '/teams/portfolio') return resolved(portfolio);
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
}

function renderPortfolio() {
  return render(
    <MemoryRouter initialEntries={['/portfolio']}>
      <ThemeProvider>
        <Routes>
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/history" element={<div>history-page-marker</div>} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 'fake-token');

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe('Portfolio: Agency gate', () => {
  it('shows an upsell message and never calls the portfolio endpoint on a non-Agency plan', async () => {
    setupApiDefaults({ me: { ...AGENCY_ME, plan: 'starter' } });
    renderPortfolio();

    expect(await screen.findByText(/Portfolio is an Agency plan feature/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/teams/portfolio');
  });

  it('renders the table for an Agency plan', async () => {
    setupApiDefaults({
      portfolio: [{ domain: 'https://a-site.com', latestScore: 60, previousScore: 80, trend: -20, alerts: [{ type: 'score_drop', delta: -20 }] }],
    });
    renderPortfolio();

    expect(await screen.findByText('a-site.com')).toBeInTheDocument();
  });
});

describe('Portfolio: table', () => {
  const ROWS = [
    { domain: 'https://a-site.com', latestScore: 60, previousScore: 80, trend: -20, alerts: [{ type: 'score_drop', delta: -20 }] },
    { domain: 'https://b-site.com', latestScore: 90, previousScore: null, trend: null, alerts: [] },
    { domain: 'https://c-site.com', latestScore: 55, previousScore: 50, trend: 5, alerts: [] },
  ];

  it('shows the empty state when there are no monitored domains', async () => {
    setupApiDefaults({ portfolio: [] });
    renderPortfolio();
    expect(await screen.findByText('No monitored domains yet. Add one from the dashboard to see it here.')).toBeInTheDocument();
  });

  it('sorts by domain by default', async () => {
    setupApiDefaults({ portfolio: ROWS });
    renderPortfolio();

    await screen.findByText('a-site.com');
    const rows = screen.getAllByText(/-site\.com$/).map((el) => el.textContent);
    expect(rows).toEqual(['a-site.com', 'b-site.com', 'c-site.com']);
  });

  it('sorts by score descending after clicking the Score header twice', async () => {
    setupApiDefaults({ portfolio: ROWS });
    renderPortfolio();

    await screen.findByText('a-site.com');
    fireEvent.click(screen.getByRole('button', { name: /^Score/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Score/ }));

    const rows = screen.getAllByText(/-site\.com$/).map((el) => el.textContent);
    expect(rows).toEqual(['b-site.com', 'a-site.com', 'c-site.com']);
  });

  it('shows a score-drop alert badge only for the domain with an active alert', async () => {
    setupApiDefaults({ portfolio: ROWS });
    renderPortfolio();

    await screen.findByText('a-site.com');
    expect(screen.getByText('Score dropped 20')).toBeInTheDocument();
  });

  it('navigates to that domain\'s history when a row is clicked', async () => {
    setupApiDefaults({ portfolio: ROWS });
    renderPortfolio();

    const row = (await screen.findByText('a-site.com')).closest('div');
    fireEvent.click(row);

    expect(await screen.findByText('history-page-marker')).toBeInTheDocument();
  });
});
