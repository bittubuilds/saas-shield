import Icon from './Icon.jsx';

/**
 * Glass icon: a tilted colour tile behind a frosted-glass tile that holds the icon.
 * Hover (or keyboard focus) inside the parent .card makes the two layers slide apart.
 * tone: 'indigo' | 'violet' | 'purple' | 'blue' (colours defined in styles.css)
 */
export default function GlassIcon({ icon, tone = 'violet', size = 26 }) {
  return (
    <span className={`glass-icon tone-${tone}`} aria-hidden="true">
      <span className="gi-back" />
      <span className="gi-front"><Icon name={icon} size={size} /></span>
    </span>
  );
}
