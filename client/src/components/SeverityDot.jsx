const SEVERITY_STYLES = {
  critical: 'bg-cg-severity-critical',
  high: 'bg-cg-severity-high',
  medium: 'bg-cg-severity-medium',
  low: 'bg-cg-severity-low',
  suggestion: 'bg-cg-severity-suggestion',
};

const SEVERITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  suggestion: 'Suggestion',
};

export default function SeverityDot({ severity, showLabel = false }) {
  const label = SEVERITY_LABELS[severity] || 'Other';

  return (
    <span className="inline-flex items-center gap-2 text-xs text-cg-muted">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_STYLES[severity] || 'bg-cg-muted'}`}
        aria-hidden="true"
      />
      {showLabel && <span>{label}</span>}
      {!showLabel && <span className="sr-only">{label} severity</span>}
    </span>
  );
}
