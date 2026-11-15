import { FileArchive, Film, ShieldCheck } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import './App.css'
import {
  type FramesToVideoHandle,
  FramesToVideoPanel,
} from './components/FramesToVideoPanel'
import { VideoToFramesPanel } from './components/VideoToFramesPanel'
import type { WorkspaceTab } from './types/media'

export function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('video-to-frames')
  const [isBusy, setIsBusy] = useState(false)
  const [engineReady, setEngineReady] = useState(false)
  const framesToVideoRef = useRef<FramesToVideoHandle>(null)

  const handleSendZipToVideo = useCallback((zipFile: File) => {
    setActiveTab('frames-to-video')
    void framesToVideoRef.current?.loadZipFile(zipFile)
  }, [])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <Film size={20} />
          </div>
          <div>
            <h1 className="brand-title">Framer</h1>
            <p className="brand-tagline">
              Video ↔ Frames ZIP converter in your browser
            </p>
          </div>
        </div>

        <div className="topbar-status">
          <span className="status-pill">
            <ShieldCheck size={14} />
            100% Local &amp; Private
          </span>
          <span
            className={`status-pill ${engineReady ? 'is-ready' : ''}`}
            title="FFmpeg WebAssembly runs directly in your browser"
          >
            <span
              className={`status-dot ${engineReady ? 'is-success' : 'is-standby'}`}
            />
            {engineReady ? 'FFmpeg Ready' : 'FFmpeg Standby'}
          </span>
        </div>
      </header>

      <nav className="mode-switcher" aria-label="Conversion workflow">
        <button
          type="button"
          className={`mode-tab ${activeTab === 'video-to-frames' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('video-to-frames')}
          aria-pressed={activeTab === 'video-to-frames'}
        >
          <Film size={17} />
          <span>Video → Frames (.zip)</span>
        </button>

        <button
          type="button"
          className={`mode-tab ${activeTab === 'frames-to-video' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('frames-to-video')}
          aria-pressed={activeTab === 'frames-to-video'}
        >
          <FileArchive size={17} />
          <span>Frames (.zip) → Video</span>
        </button>
      </nav>

      <main className="workspace-main">
        <div hidden={activeTab !== 'video-to-frames'}>
          <VideoToFramesPanel
            isBusy={isBusy}
            onBusyChange={setIsBusy}
            onEngineStatusChange={setEngineReady}
            onSendZipToVideo={handleSendZipToVideo}
          />
        </div>

        <div hidden={activeTab !== 'frames-to-video'}>
          <FramesToVideoPanel
            ref={framesToVideoRef}
            isBusy={isBusy}
            onBusyChange={setIsBusy}
            onEngineStatusChange={setEngineReady}
          />
        </div>
      </main>
    </div>
  )
}

export default App
