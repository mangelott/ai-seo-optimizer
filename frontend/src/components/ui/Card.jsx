import styles from './Card.module.css';

export default function Card({
  hover = false,
  hoverSoft = false,
  clickable = false,
  noPadding = false,
  className = '',
  style,
  children,
  ...props
}) {
  const classes = [
    styles.card,
    hover ? styles.hover : '',
    hoverSoft ? styles.hoverSoft : '',
    clickable ? styles.clickable : '',
    noPadding ? styles.noPadding : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={style} {...props}>
      {children}
    </div>
  );
}
