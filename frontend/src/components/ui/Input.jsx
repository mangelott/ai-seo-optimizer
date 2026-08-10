import styles from './Input.module.css';

export function Label({ children, ...props }) {
  return (
    <label className={styles.label} {...props}>
      {children}
    </label>
  );
}

export default function Input({ error = false, className = '', ...props }) {
  const classes = [styles.input, error ? styles.error : '', className].filter(Boolean).join(' ');
  return <input className={classes} {...props} />;
}
