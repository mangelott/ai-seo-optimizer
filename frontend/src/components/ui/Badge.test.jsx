import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Badge from './Badge';
import styles from './Badge.module.css';

describe('Badge', () => {
  it('renders children text', () => {
    const { getByText } = render(<Badge variant="high">Alto</Badge>);
    expect(getByText('Alto')).toBeInTheDocument();
  });

  it('defaults to the neutral variant', () => {
    const { getByText } = render(<Badge>Default</Badge>);
    expect(getByText('Default')).toHaveClass(styles.neutral);
  });

  it.each(['high', 'medium', 'low', 'highSolid', 'mediumSolid', 'lowSolid', 'success', 'category', 'plan'])(
    'applies the %s variant class',
    (variant) => {
      const { getByText } = render(<Badge variant={variant}>x</Badge>);
      expect(getByText('x')).toHaveClass(styles[variant]);
    }
  );
});
