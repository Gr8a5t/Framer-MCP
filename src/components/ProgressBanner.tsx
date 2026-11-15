import { Loader2, X } from 'lucide-react'
import type { EngineProgress } from '../types/media'

interface ProgressBannerProps {
  progress: EngineProgress
  onCancel: () => void
}

export function ProgressBanner({ progress, onCancel }: ProgressBannerProps) {
  if (progress.phase === 'idle') return null

  const pct = Math.round(Math.min(100, Math.max(0, progress.ratio * 100)))

  return (
    <div className="progress-card" role="status" aria-live="polite">
      <div className="progress-header">
        <div className="progress-title-row">
          <Loader2 size={16} className="spin-icon" />
          <span className="progress-message">{progress.message}</span>
        </div>
        <div className="progress-actions">
          <span className="mono-pill">{pct}%</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
          >
            <X size={14} />
            Cancel
          </button>
        </div>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

