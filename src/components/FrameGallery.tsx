import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Maximize2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  formatBytes,
  formatTimestamp,
  getFileExtension,
  getMimeTypeForImageExt,
} from '../lib/format'
import type { FrameItem } from '../types/media'

interface FrameGalleryProps {
  frames: FrameItem[]
  title?: string
}

const PAGE_SIZE = 24

function createFrameBlobUrl(frame: FrameItem): string {
  const mime = getMimeTypeForImageExt(getFileExtension(frame.name))
  const blob = new Blob([frame.data.slice()], { type: mime })
  return URL.createObjectURL(blob)
}

export function FrameGallery({
  frames,
  title = 'Frame Preview',
}: FrameGalleryProps) {
  const [page, setPage] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  const totalPages = Math.max(1, Math.ceil(frames.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const startIndex = safePage * PAGE_SIZE
  const visibleFrames = useMemo(
    () => frames.slice(startIndex, startIndex + PAGE_SIZE),
    [frames, startIndex],
  )

  // Only allocate object URLs for the currently visible page of thumbnails.
  const pageUrls = useMemo(
    () => visibleFrames.map((frame) => createFrameBlobUrl(frame)),
    [visibleFrames],
  )

  useEffect(() => {
    return () => {
      for (const url of pageUrls) {
        URL.revokeObjectURL(url)
      }
    }
  }, [pageUrls])

  const selectedFrame =
    selectedIndex !== null && selectedIndex >= 0 && selectedIndex < frames.length
      ? frames[selectedIndex]
      : null

  const selectedUrl = useMemo(
    () => (selectedFrame ? createFrameBlobUrl(selectedFrame) : null),
    [selectedFrame],
  )

  useEffect(() => {
    return () => {
      if (selectedUrl) {
        URL.revokeObjectURL(selectedUrl)
      }
    }
  }, [selectedUrl])

  useEffect(() => {
    if (selectedIndex === null) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedIndex(null)
      } else if (event.key === 'ArrowLeft') {
        setSelectedIndex((prev) =>
          prev !== null && prev > 0 ? prev - 1 : prev,
        )
      } else if (event.key === 'ArrowRight') {
        setSelectedIndex((prev) =>
          prev !== null && prev < frames.length - 1 ? prev + 1 : prev,
        )
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedIndex, frames.length])

  if (frames.length === 0) return null

  return (
    <section className="gallery-section" aria-label={title}>
      <div className="gallery-header">
        <div>
          <h3 className="gallery-title">{title}</h3>
          <p className="gallery-subtitle">
            Showing frames {startIndex + 1}–
            {Math.min(startIndex + PAGE_SIZE, frames.length)} of{' '}
            {frames.length}. Click any frame to inspect.
          </p>
        </div>

        {totalPages > 1 ? (
          <div className="pagination-controls">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setPage(0)}
              disabled={safePage === 0}
              aria-label="First page"
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="mono-pill">
              Page {safePage + 1} / {totalPages}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setPage(totalPages - 1)}
              disabled={safePage >= totalPages - 1}
              aria-label="Last page"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="frame-grid">
        {visibleFrames.map((frame, offset) => {
          const globalIndex = startIndex + offset
          return (
            <button
              key={frame.id}
              type="button"
              className="frame-card"
              onClick={() => setSelectedIndex(globalIndex)}
              title={`Inspect ${frame.name}`}
            >
              <div className="frame-thumb-wrap">
                <img
                  src={pageUrls[offset]}
                  alt={frame.name}
                  className="frame-thumb"
                  loading="lazy"
                />
                <span className="frame-index-badge">
                  #{String(globalIndex + 1).padStart(3, '0')}
                </span>
                <span className="frame-zoom-badge">
                  <Maximize2 size={12} />
                </span>
              </div>
              <div className="frame-meta">
                <span className="frame-name" title={frame.name}>
                  {frame.name}
                </span>
                <span className="frame-submeta">
                  {frame.timestampSec !== undefined
                    ? formatTimestamp(frame.timestampSec)
                    : formatBytes(frame.size)}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {selectedFrame && selectedUrl && selectedIndex !== null ? (
        <div
          className="lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Inspecting ${selectedFrame.name}`}
          onClick={() => setSelectedIndex(null)}
        >
          <div
            className="lightbox-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="lightbox-header">
              <div className="lightbox-title-group">
                <span className="mono-pill">
                  Frame {selectedIndex + 1} / {frames.length}
                </span>
                <strong className="lightbox-filename">
                  {selectedFrame.name}
                </strong>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setSelectedIndex(null)}
                aria-label="Close frame inspector"
              >
                <X size={18} />
              </button>
            </div>

            <div className="lightbox-stage">
              <img
                src={selectedUrl}
                alt={selectedFrame.name}
                className="lightbox-image"
              />
            </div>

            <div className="lightbox-footer">
              <div className="lightbox-specs">
                {selectedFrame.width && selectedFrame.height ? (
                  <span className="spec-chip">
                    {selectedFrame.width} × {selectedFrame.height}
                  </span>
                ) : null}
                <span className="spec-chip">
                  {formatBytes(selectedFrame.size)}
                </span>
                {selectedFrame.timestampSec !== undefined ? (
                  <span className="spec-chip">
                    @ {formatTimestamp(selectedFrame.timestampSec)}
                  </span>
                ) : null}
              </div>

              <div className="lightbox-nav">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={selectedIndex <= 0}
                  onClick={() =>
                    setSelectedIndex((prev) =>
                      prev !== null && prev > 0 ? prev - 1 : prev,
                    )
                  }
                >
                  <ChevronLeft size={16} />
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={selectedIndex >= frames.length - 1}
                  onClick={() =>
                    setSelectedIndex((prev) =>
                      prev !== null && prev < frames.length - 1 ? prev + 1 : prev,
                    )
                  }
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

