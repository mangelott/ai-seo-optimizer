import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ScoreRing from './ScoreRing';

function getCircles(container) {
  return container.querySelectorAll('circle');
}

describe('ScoreRing', () => {
  it('renders the score number and a full-circle track + progress circle', () => {
    const { container, getByText } = render(<ScoreRing score={82} size={140} strokeWidth={12} />);
    expect(getByText('82')).toBeInTheDocument();
    expect(getCircles(container)).toHaveLength(2);
  });

  it('a score of 0 has a dash offset equal to the full circumference (empty ring)', () => {
    const { container } = render(<ScoreRing score={0} size={100} strokeWidth={10} />);
    const [, progress] = getCircles(container);
    const radius = (100 - 10) / 2;
    const circumference = 2 * Math.PI * radius;
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference, 5);
  });

  it('a score of 100 has a dash offset of 0 (full ring)', () => {
    const { container } = render(<ScoreRing score={100} size={100} strokeWidth={10} />);
    const [, progress] = getCircles(container);
    expect(Number(progress.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 5);
  });

  it('clamps out-of-range scores instead of drawing a broken ring', () => {
    const over = render(<ScoreRing score={150} size={100} strokeWidth={10} />);
    const [, overProgress] = getCircles(over.container);
    expect(Number(overProgress.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 5);

    const under = render(<ScoreRing score={-20} size={100} strokeWidth={10} />);
    const [, underProgress] = getCircles(under.container);
    const radius = (100 - 10) / 2;
    const circumference = 2 * Math.PI * radius;
    expect(Number(underProgress.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference, 5);
  });

  it('colorMode="accent" always uses the accent color regardless of score', () => {
    const { container } = render(<ScoreRing score={10} size={100} strokeWidth={10} colorMode="accent" />);
    const [, progress] = getCircles(container);
    expect(progress.getAttribute('stroke')).toBe('var(--accent)');
  });

  it('colorMode="score" (default) uses danger color for a low score', () => {
    const { container } = render(<ScoreRing score={10} size={100} strokeWidth={10} />);
    const [, progress] = getCircles(container);
    expect(progress.getAttribute('stroke')).toBe('var(--danger)');
  });

  it('colorMode="score" uses success color for a high score', () => {
    const { container } = render(<ScoreRing score={90} size={100} strokeWidth={10} />);
    const [, progress] = getCircles(container);
    expect(progress.getAttribute('stroke')).toBe('var(--success)');
  });
});
