import styles from './Switch.module.css';

export default function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <label className={styles.track} aria-label={label}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.slider} />
    </label>
  );
}
