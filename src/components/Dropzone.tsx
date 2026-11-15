import { UploadCloud } from 'lucide-react'
import { useId, useRef, useState } from 'react'

interface DropzoneProps {
  accept: string
  title: string
  subtitle: string
  hint?: string
  disabled?: boolean
  error?: string | null
  onFileSelected: (file: File) => void
}

export function Dropzone({
  accept,
  title,
  subtitle,
  hint,
  disabled = false,
  error = null,
  onFileSelected,
}: DropzoneProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const handleFiles = (fileList: FileList | null) => {
    if (disabled || !fileList || fileList.length === 0) return
    onFileSelected(fileList[0])
  }

  return (
    <div className="dropzone-wrapper">
      <label
        htmlFor={inputId}
        className={`dropzone ${isDragging ? 'is-dragging' : ''} ${disabled ? 'is-disabled' : ''}`}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragEnter={(event) => {
          event.preventDefault()
          if (!disabled) setIsDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setIsDragging(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsDragging(false)
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragging(false)
          handleFiles(event.dataTransfer.files)
        }}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept}
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            handleFiles(event.target.files)
            event.target.value = ''
          }}
        />
        <div className="dropzone-icon">
          <UploadCloud size={26} />
        </div>
        <div className="dropzone-title">{title}</div>
        <div className="dropzone-subtitle">{subtitle}</div>
        {hint ? <div className="dropzone-hint">{hint}</div> : null}
      </label>

      {error ? (
        <div className="alert-banner is-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

