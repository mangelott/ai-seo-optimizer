export const SEVERITY_LEVELS = ['high', 'medium', 'low'];

export function severityLabelKey(level) {
  const cap = level.charAt(0).toUpperCase() + level.slice(1);
  return `report.severity${cap}`;
}
