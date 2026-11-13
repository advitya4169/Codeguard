const STATUS_STYLES = {
  queued: 'bg-amber-400',
  processing: 'bg-cg-accent',
  completed: 'bg-emerald-400',
  failed: 'bg-cg-severity-critical',
  stale: 'bg-cg-muted',
  pending: 'bg-amber-400',
  published: 'bg-emerald-400',
  duplicate: 'bg-emerald-400',
  uncertain: 'bg-orange-400',
  not_needed: 'bg-cg-muted',
};

const DEFAULT_LABELS = {
  queued: 'Queued',
  processing: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  stale: 'Superseded',
  pending: 'Pending',
  published: 'Published',
  duplicate: 'Already published',
  uncertain: 'Needs verification',
  not_needed: 'Not applicable',
};

export default function StatusBadge({ status, label }) {
  const displayLabel = label || DEFAULT_LABELS[status] || status || 'Unknown status';
  const dotColor = STATUS_STYLES[status] || 'bg-cg-muted';

  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-cg-primary">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
      {displayLabel}
    </span>
  );
}
