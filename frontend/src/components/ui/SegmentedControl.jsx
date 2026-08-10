import styles from './SegmentedControl.module.css';

export function SegmentedControl({ options, value, onChange }) {
  return (
    <div className={styles.track}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`${styles.option} ${value === opt.value ? styles.active : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function PillFilter({ options, value, onChange }) {
  return (
    <div className={styles.pillTrack}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`${styles.pill} ${value === opt.value ? styles.pillActive : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
