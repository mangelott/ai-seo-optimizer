import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import '../i18n';
import i18n from '../i18n';
import { ThemeProvider } from '../context/ThemeContext';

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return { default: api, API_BASE_URL: 'http://localhost:4000/api' };
});

import api from '../api/client';
import Settings from './Settings';

function resolved(data) {
  return Promise.resolve({ data });
}

function rejected(error) {
  return Promise.reject({ response: { data: { error } } });
}

const DEFAULT_ME = { id: 1, name: 'Ana', email: 'ana@example.com', plan: 'starter' };

function setupApiDefaults({
  me = DEFAULT_ME,
  domains = [],
  gscStatus = { connected: false },
  team = { team: null, members: [] },
  gscSites = [],
} = {}) {
  api.get.mockImplementation((path) => {
    if (path === '/auth/me') return resolved(me);
    if (path === '/domains') return resolved(domains);
    if (path === '/gsc/status') return resolved(gscStatus);
    if (path === '/teams/me') return resolved(team);
    if (path === '/gsc/sites') return resolved(gscSites);
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <ThemeProvider>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/" element={<div>landing-page-marker</div>} />
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
  window.history.pushState({}, '', '/settings');

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

describe('Settings: profile', () => {
  it('loads and displays the current name and email', async () => {
    setupApiDefaults();
    renderSettings();
    expect(await screen.findByDisplayValue('Ana')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ana@example.com')).toBeInTheDocument();
  });

  it('saves profile changes and shows a success message', async () => {
    setupApiDefaults();
    api.patch.mockResolvedValue({ data: {} });
    renderSettings();

    const nameInput = await screen.findByDisplayValue('Ana');
    fireEvent.change(nameInput, { target: { value: 'Ana Maria' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/auth/me', { name: 'Ana Maria', email: 'ana@example.com' });
    });
    expect(await screen.findByText('Save ✓')).toBeInTheDocument();
  });
});

describe('Settings: password', () => {
  it('submits current/new password and shows success', async () => {
    setupApiDefaults();
    api.post.mockResolvedValue({ data: { ok: true } });
    renderSettings();

    await screen.findByDisplayValue('Ana');
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-pass' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-123' } });
    fireEvent.click(screen.getByText('Update password'));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/auth/change-password', {
        currentPassword: 'old-pass',
        newPassword: 'new-password-123',
      });
    });
    expect(await screen.findByText('Save ✓')).toBeInTheDocument();
  });

  it('shows the server error message when the password update fails', async () => {
    setupApiDefaults();
    api.post.mockImplementation(() => rejected('Current password is incorrect'));
    renderSettings();

    await screen.findByDisplayValue('Ana');
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-123' } });
    fireEvent.click(screen.getByText('Update password'));

    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
  });
});

describe('Settings: Google Search Console', () => {
  it('shows the connect button when not connected', async () => {
    setupApiDefaults({ gscStatus: { connected: false } });
    renderSettings();
    expect(await screen.findByText('Connect Google Search Console')).toBeInTheDocument();
    expect(screen.queryByText('Disconnect')).not.toBeInTheDocument();
  });

  it('redirects to the backend connect endpoint with the stored token', async () => {
    setupApiDefaults({ gscStatus: { connected: false } });
    renderSettings();
    await screen.findByText('Connect Google Search Console');

    const originalLocation = window.location;
    delete window.location;
    window.location = { href: '' };

    fireEvent.click(screen.getByText('Connect Google Search Console'));
    expect(window.location.href).toBe('http://localhost:4000/api/gsc/connect?token=fake-token');

    window.location = originalLocation;
  });

  it('shows Disconnect when connected, and reverts to Connect after disconnecting', async () => {
    setupApiDefaults({ gscStatus: { connected: true } });
    api.delete.mockResolvedValue({ data: { ok: true } });
    renderSettings();

    expect(await screen.findByText('Disconnect')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/gsc/disconnect'));
    expect(await screen.findByText('Connect Google Search Console')).toBeInTheDocument();
  });

  it('shows a success notice and strips the ?gsc=connected query param after an OAuth redirect', async () => {
    window.history.pushState({}, '', '/settings?gsc=connected');
    setupApiDefaults();
    renderSettings();

    expect(await screen.findByText('Google Search Console connected successfully.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('shows an error notice after a failed OAuth redirect', async () => {
    window.history.pushState({}, '', '/settings?gsc=error');
    setupApiDefaults();
    renderSettings();
    expect(await screen.findByText("Couldn't connect Google Search Console. Please try again.")).toBeInTheDocument();
  });
});

describe('Settings: monitored domains', () => {
  const domain = { id: 5, domain: 'https://example.com', recurring_enabled: false, auto_fix_enabled: false, wp_url: null };

  it('renders the domain hostname without the protocol', async () => {
    setupApiDefaults({ domains: [domain] });
    renderSettings();
    expect(await screen.findByText('example.com')).toBeInTheDocument();
  });

  it('removes a domain and drops it from the list', async () => {
    setupApiDefaults({ domains: [domain] });
    api.delete.mockResolvedValue({ data: { ok: true } });
    renderSettings();

    await screen.findByText('example.com');
    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/domains/5'));
    await waitFor(() => expect(screen.queryByText('example.com')).not.toBeInTheDocument());
  });

  it('enabling recurring audits sends the default interval and delivery', async () => {
    setupApiDefaults({ domains: [domain] });
    api.patch.mockResolvedValue({ data: { ...domain, recurring_enabled: true, recurring_interval_days: 7, recurring_delivery: 'in_app' } });
    renderSettings();

    await screen.findByText('example.com');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Recurring audits' }));

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/domains/5', {
        recurringEnabled: true,
        recurringIntervalDays: 7,
        recurringDelivery: 'in_app',
      });
    });
  });

  it('shows interval and delivery controls once recurring is enabled, and changing them calls the API', async () => {
    const recurringDomain = { ...domain, recurring_enabled: true, recurring_interval_days: 7, recurring_delivery: 'in_app' };
    setupApiDefaults({ domains: [recurringDomain] });
    api.patch.mockResolvedValue({ data: { ...recurringDomain, recurring_interval_days: 14 } });
    renderSettings();

    await screen.findByText('example.com');
    const intervalInput = screen.getByDisplayValue('7');
    fireEvent.change(intervalInput, { target: { value: '14' } });

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/domains/5', {
        recurringEnabled: true,
        recurringIntervalDays: 14,
        recurringDelivery: 'in_app',
      });
    });
  });

  it('does not call the API when the interval is changed to an invalid value', async () => {
    const recurringDomain = { ...domain, recurring_enabled: true, recurring_interval_days: 7, recurring_delivery: 'in_app' };
    setupApiDefaults({ domains: [recurringDomain] });
    renderSettings();

    await screen.findByText('example.com');
    fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '0' } });

    expect(api.patch).not.toHaveBeenCalled();
  });

  it('changing the delivery preference calls the API with the new value', async () => {
    const recurringDomain = { ...domain, recurring_enabled: true, recurring_interval_days: 7, recurring_delivery: 'in_app' };
    setupApiDefaults({ domains: [recurringDomain] });
    api.patch.mockResolvedValue({ data: recurringDomain });
    renderSettings();

    await screen.findByText('example.com');
    fireEvent.change(screen.getByDisplayValue('In-app only'), { target: { value: 'email' } });

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/domains/5', {
        recurringEnabled: true,
        recurringIntervalDays: 7,
        recurringDelivery: 'email',
      });
    });
  });

  it('only shows the GSC property picker for a domain once GSC is connected', async () => {
    setupApiDefaults({ domains: [domain], gscStatus: { connected: false } });
    renderSettings();
    await screen.findByText('example.com');
    expect(screen.queryByText('Search Console property')).not.toBeInTheDocument();
  });

  it('linking a GSC property calls the API with the selected site', async () => {
    setupApiDefaults({
      domains: [domain],
      gscStatus: { connected: true },
      gscSites: [{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }],
    });
    api.patch.mockResolvedValue({ data: { ...domain, gsc_site_url: 'https://example.com/' } });
    renderSettings();

    await screen.findByText('Search Console property');
    fireEvent.change(screen.getByDisplayValue('Not linked'), { target: { value: 'https://example.com/' } });

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/gsc/domains/5', { siteUrl: 'https://example.com/' });
    });
  });
});

describe('Settings: WordPress auto-fix', () => {
  const domain = { id: 7, domain: 'https://wp-site.com', recurring_enabled: false, auto_fix_enabled: false, wp_url: null };

  it('shows the connection form and a plugin download link when not connected', async () => {
    setupApiDefaults({ domains: [domain] });
    renderSettings();
    await screen.findByText('wp-site.com');
    expect(screen.getByText('Download the companion plugin').closest('a')).toHaveAttribute(
      'href',
      '/ai-seo-optimizer-connector.php'
    );
    expect(screen.getByLabelText('Site URL')).toBeInTheDocument();
  });

  it('connects successfully and switches to the connected view', async () => {
    setupApiDefaults({ domains: [domain] });
    api.patch.mockResolvedValue({
      data: { id: 7, domain: domain.domain, wp_url: 'https://wp-site.com', wp_username: 'admin', auto_fix_enabled: false },
    });
    renderSettings();

    await screen.findByText('wp-site.com');
    fireEvent.change(screen.getByLabelText('Site URL'), { target: { value: 'https://wp-site.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Application Password'), { target: { value: 'app-pass-1234' } });
    fireEvent.click(screen.getByText('Connect'));

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/wordpress/domains/7/connect', {
        wpUrl: 'https://wp-site.com',
        wpUsername: 'admin',
        wpAppPassword: 'app-pass-1234',
      });
    });
    expect(await screen.findByText('Connected to https://wp-site.com')).toBeInTheDocument();
  });

  it('shows an inline error and stays on the form when connecting fails', async () => {
    setupApiDefaults({ domains: [domain] });
    api.patch.mockImplementation(() => rejected('Could not authenticate with that WordPress site.'));
    renderSettings();

    await screen.findByText('wp-site.com');
    fireEvent.change(screen.getByLabelText('Site URL'), { target: { value: 'https://wp-site.com' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Application Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('Connect'));

    expect(await screen.findByText('Could not authenticate with that WordPress site.')).toBeInTheDocument();
    expect(screen.getByLabelText('Site URL')).toBeInTheDocument();
  });

  it('toggles auto-fix for an already-connected domain', async () => {
    const connectedDomain = { ...domain, wp_url: 'https://wp-site.com', wp_username: 'admin' };
    setupApiDefaults({ domains: [connectedDomain] });
    api.patch.mockResolvedValue({ data: { ...connectedDomain, auto_fix_enabled: true } });
    renderSettings();

    await screen.findByText('Connected to https://wp-site.com');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable auto-fix' }));

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/wordpress/domains/7/toggle', { autoFixEnabled: true });
    });
  });

  it('disconnects and reverts to the connection form', async () => {
    const connectedDomain = { ...domain, wp_url: 'https://wp-site.com', wp_username: 'admin' };
    setupApiDefaults({ domains: [connectedDomain] });
    api.delete.mockResolvedValue({ data: { ok: true } });
    renderSettings();

    await screen.findByText('Connected to https://wp-site.com');
    fireEvent.click(screen.getByText('Disconnect'));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/wordpress/domains/7/disconnect'));
    expect(await screen.findByLabelText('Site URL')).toBeInTheDocument();
  });
});

describe('Settings: team (Agency plan only)', () => {
  it('is not rendered at all for a non-Agency plan', async () => {
    setupApiDefaults({ me: { ...DEFAULT_ME, plan: 'starter' } });
    renderSettings();
    await screen.findByDisplayValue('Ana');
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
  });

  it('shows the create-team form for an Agency user with no team yet', async () => {
    setupApiDefaults({ me: { ...DEFAULT_ME, plan: 'agency' }, team: { team: null, members: [] } });
    renderSettings();
    expect(await screen.findByText('Team')).toBeInTheDocument();
    expect(screen.getByText('Create team')).toBeInTheDocument();
  });

  it('creates a team and switches to the management view', async () => {
    setupApiDefaults({ me: { ...DEFAULT_ME, plan: 'agency' }, team: { team: null, members: [] } });
    api.post.mockResolvedValue({ data: { team: { id: 1, name: 'My Agency', isOwner: true } } });
    renderSettings();

    await screen.findByText('Create team');
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'My Agency' } });
    fireEvent.click(screen.getByText('Create team'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/teams', { name: 'My Agency' }));
    expect(await screen.findByText('My Agency')).toBeInTheDocument();
  });

  it('shows the error when team creation fails (e.g. not Agency plan on the server)', async () => {
    setupApiDefaults({ me: { ...DEFAULT_ME, plan: 'agency' }, team: { team: null, members: [] } });
    api.post.mockImplementation(() => rejected('Creating a team requires the Agency plan'));
    renderSettings();

    await screen.findByText('Create team');
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'My Agency' } });
    fireEvent.click(screen.getByText('Create team'));

    expect(await screen.findByText('Creating a team requires the Agency plan')).toBeInTheDocument();
  });

  it('a non-owner member sees a read-only member list with no management controls', async () => {
    setupApiDefaults({
      me: { ...DEFAULT_ME, plan: 'agency' },
      team: {
        team: { id: 1, name: 'Client Agency', isOwner: false },
        members: [{ id: 1, invited_email: 'owner@example.com', accepted_at: '2026-01-01' }],
      },
    });
    renderSettings();

    expect(await screen.findByText('Client Agency')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Invite')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete team')).not.toBeInTheDocument();
    expect(screen.queryByText('Remove')).not.toBeInTheDocument();
  });

  it('the owner sees invite, white-label, and delete controls, and pending members are marked', async () => {
    setupApiDefaults({
      me: { ...DEFAULT_ME, plan: 'agency' },
      team: {
        team: { id: 1, name: 'My Agency', isOwner: true },
        members: [{ id: 9, invited_email: 'pending@example.com', accepted_at: null }],
      },
    });
    renderSettings();

    expect(await screen.findByText('pending@example.com (pending)')).toBeInTheDocument();
    expect(screen.getByText('Invite')).toBeInTheDocument();
    expect(screen.getByText('Delete team')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('invites a member and reloads the team', async () => {
    setupApiDefaults({
      me: { ...DEFAULT_ME, plan: 'agency' },
      team: { team: { id: 1, name: 'My Agency', isOwner: true }, members: [] },
    });
    api.post.mockResolvedValue({ data: { ok: true } });
    renderSettings();

    await screen.findByText('My Agency');
    fireEvent.change(screen.getByLabelText('Invite by email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByText('Invite'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/teams/invite', { email: 'new@example.com' }));
    // loadTeam() re-fetches /teams/me after a successful invite.
    await waitFor(() => expect(api.get.mock.calls.filter((c) => c[0] === '/teams/me').length).toBeGreaterThanOrEqual(2));
  });

  it('removes a member and reloads the team', async () => {
    setupApiDefaults({
      me: { ...DEFAULT_ME, plan: 'agency' },
      team: {
        team: { id: 1, name: 'My Agency', isOwner: true },
        members: [{ id: 42, invited_email: 'gone@example.com', accepted_at: '2026-01-01' }],
      },
    });
    api.delete.mockResolvedValue({ data: { ok: true } });
    renderSettings();

    await screen.findByText('gone@example.com');
    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/teams/members/42'));
  });

  it('updates white-label branding on blur', async () => {
    const team = { id: 1, name: 'My Agency', isOwner: true, white_label_logo_url: '', white_label_brand_color: '#5b4fd6' };
    setupApiDefaults({ me: { ...DEFAULT_ME, plan: 'agency' }, team: { team, members: [] } });
    api.patch.mockResolvedValue({ data: { team: { ...team, white_label_logo_url: 'https://logo.example/l.png' } } });
    renderSettings();

    await screen.findByText('My Agency');
    const logoInput = screen.getByLabelText('Logo URL');
    fireEvent.change(logoInput, { target: { value: 'https://logo.example/l.png' } });
    fireEvent.blur(logoInput);

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/teams', { whiteLabelLogoUrl: 'https://logo.example/l.png' });
    });
  });

  it('deletes the team when the confirm dialog is accepted', async () => {
    const team = { id: 1, name: 'My Agency', isOwner: true };
    setupApiDefaults({ me: { ...DEFAULT_ME, plan: 'agency' }, team: { team, members: [] } });
    api.delete.mockResolvedValue({ data: { ok: true } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings();

    await screen.findByText('My Agency');
    fireEvent.click(screen.getByText('Delete team'));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/teams'));
    expect(await screen.findByText('Create team')).toBeInTheDocument();
  });

  it('does not delete the team when the confirm dialog is dismissed', async () => {
    const team = { id: 1, name: 'My Agency', isOwner: true };
    setupApiDefaults({ me: { ...DEFAULT_ME, plan: 'agency' }, team: { team, members: [] } });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSettings();

    await screen.findByText('My Agency');
    fireEvent.click(screen.getByText('Delete team'));

    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.getByText('My Agency')).toBeInTheDocument();
  });
});

describe('Settings: danger zone', () => {
  it('does not delete the account when the confirm dialog is dismissed', async () => {
    setupApiDefaults();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSettings();

    await screen.findByDisplayValue('Ana');
    fireEvent.click(screen.getByText('Delete account'));

    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.queryByText('landing-page-marker')).not.toBeInTheDocument();
  });

  it('deletes the account, clears the token, and navigates home when confirmed', async () => {
    setupApiDefaults();
    api.delete.mockResolvedValue({ data: { ok: true } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings();

    await screen.findByDisplayValue('Ana');
    fireEvent.click(screen.getByText('Delete account'));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/me'));
    expect(await screen.findByText('landing-page-marker')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
  });
});
