import styles from './Button.module.css';

export default function Button({
  variant = 'primary',
  size = 'md',
  full = false,
  className = '',
  children,
  ...props
}) {
  const classes = [
    styles.base,
    styles[variant],
    size === 'sm' ? styles.sm : '',
    full ? styles.full : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} {...props}>
      {children}
    </button>
  );
}
