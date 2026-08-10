import styles from './Badge.module.css';

export default function Badge({ variant = 'neutral', className = '', children, ...props }) {
  const classes = [styles.badge, styles[variant], className].filter(Boolean).join(' ');
  return (
    <span className={classes} {...props}>
      {children}
    </span>
  );
}
