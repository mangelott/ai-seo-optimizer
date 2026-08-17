import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import '../i18n';
import i18n from '../i18n';
import FixCard from './FixCard';

const SAMPLE_FIX = {
  category: 'technical',
  severity: 'high',
  title: 'Missing alt attributes',
  what: '23 images on the site have no alt text.',
  why: 'Hurts accessibility and image SEO.',
  currentValue: '0 images with alt text',
  suggestedFix: 'Add a descriptive alt attribute to every product image.',
  snippet: '<img src="shoe.jpg" alt="Blue running shoe">',
  cmsAutoApplicable: true,
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('FixCard', () => {
  it('shows index, severity, category, and title when collapsed', () => {
    render(<FixCard fix={SAMPLE_FIX} index={0} expanded={false} onToggle={() => {}} />);
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Technical')).toBeInTheDocument();
    expect(screen.getByText('Missing alt attributes')).toBeInTheDocument();
  });

  it('does not render the expanded detail panel when collapsed', () => {
    render(<FixCard fix={SAMPLE_FIX} index={0} expanded={false} onToggle={() => {}} />);
    expect(screen.queryByText(SAMPLE_FIX.what)).not.toBeInTheDocument();
  });

  it('calls onToggle when the header is clicked', () => {
    const onToggle = vi.fn();
    render(<FixCard fix={SAMPLE_FIX} index={0} expanded={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByText('Missing alt attributes'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('renders what/why/before/after/snippet when expanded', () => {
    render(<FixCard fix={SAMPLE_FIX} index={0} expanded onToggle={() => {}} />);
    expect(screen.getByText(SAMPLE_FIX.what)).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_FIX.why)).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_FIX.currentValue)).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_FIX.suggestedFix)).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_FIX.snippet)).toBeInTheDocument();
  });

  it('copies the snippet to the clipboard and shows transient "Copied!" feedback', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<FixCard fix={SAMPLE_FIX} index={0} expanded onToggle={() => {}} />);

    fireEvent.click(screen.getByText('Copy fix'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SAMPLE_FIX.snippet);
    expect(await screen.findByText('Copied! ✓')).toBeInTheDocument();

    vi.advanceTimersByTime(1800);
    expect(await screen.findByText('Copy fix')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('falls back to suggestedFix for the copy action when there is no snippet', () => {
    const fixWithoutSnippet = { ...SAMPLE_FIX, snippet: null };
    render(<FixCard fix={fixWithoutSnippet} index={0} expanded onToggle={() => {}} />);
    fireEvent.click(screen.getByText('Copy fix'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SAMPLE_FIX.suggestedFix);
  });

  it('shows the disabled "Coming soon" placeholder when the fix has no wpField at all', () => {
    render(<FixCard fix={SAMPLE_FIX} index={0} expanded onToggle={() => {}} autoFixAvailable />);
    expect(screen.getByText('Apply automatically').closest('button')).toBeDisabled();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('shows a disabled "Connect WordPress" placeholder when the fix is auto-fixable but the domain has no WordPress connection', () => {
    const wpFix = { ...SAMPLE_FIX, wpField: 'post_title', wpValue: 'Better title' };
    render(<FixCard fix={wpFix} index={0} expanded onToggle={() => {}} autoFixAvailable={false} />);
    expect(screen.getByText('Apply automatically').closest('button')).toBeDisabled();
    expect(screen.getByText('Connect WordPress')).toBeInTheDocument();
  });

  it('shows a real, enabled "Apply automatically" button when the fix has a wpField and the domain has auto-fix enabled', () => {
    const wpFix = { ...SAMPLE_FIX, wpField: 'post_title', wpValue: 'Better title' };
    render(<FixCard fix={wpFix} index={0} expanded onToggle={() => {}} autoFixAvailable onApply={vi.fn()} />);
    expect(screen.getByText('Apply automatically').closest('button')).toBeEnabled();
  });

  it('calls onApply, shows an "Applying…" state, and does not toggle the card when clicked', async () => {
    const onToggle = vi.fn();
    let resolveApply;
    const onApply = vi.fn(() => new Promise((resolve) => { resolveApply = resolve; }));
    const wpFix = { ...SAMPLE_FIX, wpField: 'post_title', wpValue: 'Better title' };
    render(<FixCard fix={wpFix} index={0} expanded onToggle={onToggle} autoFixAvailable onApply={onApply} />);

    fireEvent.click(screen.getByText('Apply automatically'));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
    expect(await screen.findByText('Applying…')).toBeInTheDocument();

    resolveApply();
    await screen.findByText('Apply automatically');
  });

  it('shows "Applied ✓" instead of a button once fix.applied is true, with no way to re-trigger it', () => {
    const onApply = vi.fn();
    const appliedFix = { ...SAMPLE_FIX, wpField: 'post_title', wpValue: 'Better title', applied: true };
    render(<FixCard fix={appliedFix} index={0} expanded onToggle={() => {}} autoFixAvailable onApply={onApply} />);
    expect(screen.getByText('Applied ✓')).toBeInTheDocument();
    expect(screen.queryByText('Apply automatically')).not.toBeInTheDocument();
  });

  it('shows an inline error and resets to the enabled button when onApply rejects', async () => {
    const onApply = vi.fn().mockRejectedValue(new Error('network error'));
    const wpFix = { ...SAMPLE_FIX, wpField: 'post_title', wpValue: 'Better title' };
    render(<FixCard fix={wpFix} index={0} expanded onToggle={() => {}} autoFixAvailable onApply={onApply} />);

    fireEvent.click(screen.getByText('Apply automatically'));
    expect(await screen.findByText("Couldn't apply this fix. Check your WordPress connection and try again.")).toBeInTheDocument();
    expect(screen.getByText('Apply automatically').closest('button')).toBeEnabled();
  });

  it('clicking the copy button does not also toggle the card (stopPropagation)', () => {
    const onToggle = vi.fn();
    render(<FixCard fix={SAMPLE_FIX} index={0} expanded onToggle={onToggle} />);
    fireEvent.click(screen.getByText('Copy fix'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('renders correctly in Portuguese', async () => {
    await i18n.changeLanguage('pt');
    render(<FixCard fix={SAMPLE_FIX} index={2} expanded onToggle={() => {}} />);
    expect(screen.getByText('03')).toBeInTheDocument();
    expect(screen.getByText('Alto')).toBeInTheDocument();
    expect(screen.getByText('Copiar correção')).toBeInTheDocument();
  });
});
