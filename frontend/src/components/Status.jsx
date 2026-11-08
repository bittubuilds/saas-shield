import Icon from './Icon.jsx';

export function Loading({ label = 'Loading…' }) {
  return <div className="state" role="status"><span className="spinner" />{label}</div>;
}
export function ErrorState({ message, onRetry }) {
  return (
    <div className="state state-error" role="alert">
      <Icon name="alert" size={28} />
      <p>{message}</p>
      {onRetry && <button className="btn btn-ghost" onClick={onRetry}>Try again</button>}
    </div>
  );
}
export function Empty({ children }) { return <div className="state">{children}</div>; }
