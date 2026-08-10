function scoreColor(score) {
  if (score >= 70) return 'var(--success)';
  if (score >= 50) return 'var(--warning)';
  return 'var(--danger)';
}

export default function ScoreRing({
  score,
  size = 140,
  strokeWidth = 12,
  colorMode = 'score',
  showLabel = true,
  labelSuffix,
  fontSize,
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);
  const color = colorMode === 'accent' ? 'var(--accent)' : scoreColor(score);
  const center = size / 2;
  const numberSize = fontSize || size * 0.24;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${center} ${center})`}
      />
      {showLabel && (
        <>
          <text
            x={center}
            y={center + numberSize * 0.15}
            textAnchor="middle"
            fontSize={numberSize}
            fontWeight="700"
            fill="var(--text)"
            fontFamily="Geist Mono"
          >
            {score}
          </text>
          {labelSuffix && (
            <text
              x={center}
              y={center + numberSize * 0.7}
              textAnchor="middle"
              fontSize={numberSize * 0.35}
              fill="var(--text-faint)"
              fontFamily="Geist Mono"
            >
              {labelSuffix}
            </text>
          )}
        </>
      )}
    </svg>
  );
}
