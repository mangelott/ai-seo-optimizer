import { describe, it, expect } from 'vitest';
import { SEVERITY_LEVELS, severityLabelKey } from './severity';

describe('severity', () => {
  it('exposes exactly the three severity levels used by the backend', () => {
    expect(SEVERITY_LEVELS).toEqual(['high', 'medium', 'low']);
  });

  it('maps each level to its corresponding i18n key', () => {
    expect(severityLabelKey('high')).toBe('report.severityHigh');
    expect(severityLabelKey('medium')).toBe('report.severityMedium');
    expect(severityLabelKey('low')).toBe('report.severityLow');
  });
});
