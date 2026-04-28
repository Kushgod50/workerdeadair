'use client'
import { useState, useRef } from 'react'

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:3001'

const COLORS: Record<string, string> = {
  silence: '#FF6B6B', afk: '#FFB347', filler: '#9146FF',
  technical: '#60A5FA', low_energy: '#888',
}
const ICONS: Record<string, string> = {
  stream_start: '▶', highlight: '★', game_change: '◆',
  topic_change: '●', stream_end: '■',
}

function toTS(s: number) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${sec}s`
}

function dl(name: string, content: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content]))
  a.download = name
  a.click()
}

const S = {
  card: { background: '#141414', border: '1px solid #242424', borderRadius: 10, padding: 20 } as React.CSSProperties,
  label: { fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: '#555', marginBottom: 6, display: 'block' },
  input: { width: '100%', background: '#0C0C0C', border: '1px solid #242424', borderRadius: 6, padding: '10px 14px', color: '#F0F0F0', fontFamily: 'Space Mono, monospace', fontSize: 13, boxSizing: 'border-box' as const, outline: 'none' },
}

export default function Page() {
  const [url, setUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [agg, setAgg] = useState('moderate')
  const [censorEnabled, setCensorEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)
  const [tab, setTab] = useState('cuts')

  // Processing state
  const [processing, setProcessing] = useState(false)
  const [processJob, setProcessJob] = useState<any>(null)
  const pollRef = useRef<any>(null)

  async function submit(e: any) {
    e.preventDefault()
    if (!url || loading) return
    setLoading(true); setError(''); setResult(null); setProcessJob(null)
    try {
      const r = await fetch(`${WORKER_URL}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, description: notes, aggressiveness: agg, censorEnabled }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setResult(d)
      setTab('cuts')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function startProcessing() {
    if (!result || processing) return
    setProcessing(true)
    setProcessJob({ status: 'queued', phase: 'Starting...', progress: 0 })
    try {
      const r = await fetch(`${WORKER_URL}/api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          cuts: result.cuts,
          muteWords: result.muteWords || [],
          vodTitle: result.vodTitle,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)

      // Poll status
      pollRef.current = setInterval(async () => {
        const s = await fetch(`${WORKER_URL}/api/status/${d.jobId}`)
        const job = await s.json()
        setProcessJob({ ...job, jobId: d.jobId })
        if (job.status === 'done' || job.status === 'error') {
          clearInterval(pollRef.current)
          setProcessing(false)
        }
      }, 2000)
    } catch (e: any) {
      setError(e.message)
      setProcessing(false)
    }
  }

  const safe = (s: string) => s.replace(/[^a-z0-9]/gi, '_').toLowerCase()
  const hasMutes = result?.muteWords?.length > 0
  const jobDone = processJob?.status === 'done'
  const jobError = processJob?.status === 'error'

  const PHASE_ICONS: Record<string, string> = {
    downloading: '⬇', trimming: '✂', merging: '🔗',
    censoring: '🔇', finalizing: '✨', done: '✅', error: '⚠',
  }

  return (
    <main style={{ minHeight: '100vh', padding: '0 0 80px' }}>
      <div style={{ borderBottom: '1px solid #1a1a1a', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, background: '#9146FF', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>✂</div>
          <b style={{ fontSize: 15 }}>VOD Trimmer</b>
        </div>
        <span style={{ fontSize: 11, color: '#444', letterSpacing: '0.08em' }}>POWERED BY CLAUDE</span>
      </div>

      <div style={{ maxWidth: 660, margin: '0 auto', padding: '40px 20px 0' }}>

        {!result && !loading && (
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h1 style={{ fontFamily: 'Bebas Neue, sans-serif', fontSize: 'clamp(52px,12vw,90px)', letterSpacing: '0.04em', lineHeight: 1, margin: '0 0 12px' }}>
              CUT THE<br /><span style={{ color: '#9146FF' }}>DEAD AIR</span>
            </h1>
            <p style={{ color: '#555', fontSize: 14, lineHeight: 1.7, maxWidth: 420, margin: '0 auto' }}>
              Paste a Twitch VOD URL. Claude finds the dead time. Download a trimmed MP4 with chapter markers — ready for upload or editing.
            </p>
          </div>
        )}

        {/* Form */}
        <form onSubmit={submit} style={{ marginBottom: 28 }}>
          <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={S.label}>Twitch VOD URL</label>
              <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                placeholder="https://www.twitch.tv/videos/123456789"
                disabled={loading || processing} required style={S.input} />
            </div>
            <div>
              <label style={S.label}>Notes (optional)</label>
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Minecraft stream, ~4 hours"
                disabled={loading || processing} style={S.input} />
            </div>
            <div>
              <label style={S.label}>Cut aggressiveness</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {['conservative','moderate','aggressive'].map(o => (
                  <button key={o} type="button" onClick={() => setAgg(o)} disabled={loading || processing}
                    style={{ background: agg===o ? 'rgba(145,70,255,0.12)' : 'transparent', border: `1px solid ${agg===o ? '#9146FF' : '#242424'}`, borderRadius: 6, padding: '8px 4px', color: agg===o ? '#9146FF' : '#555', fontFamily: 'Space Mono, monospace', fontSize: 11, cursor: 'pointer', textTransform: 'capitalize' }}>
                    {o}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#444', marginTop: 7 }}>
                {agg === 'conservative' && '✦ Only silence 45s+, obvious AFK'}
                {agg === 'moderate' && '✦ Silence 15s+, low-energy, BRB moments'}
                {agg === 'aggressive' && '✦ Everything slow — silence 5s+, all filler'}
              </div>
            </div>

            {/* Censor toggle */}
            <div onClick={() => !loading && !processing && setCensorEnabled(v => !v)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: censorEnabled ? 'rgba(255,107,107,0.06)' : '#0C0C0C', border: `1px solid ${censorEnabled ? 'rgba(255,107,107,0.3)' : '#242424'}`, borderRadius: 8, cursor: 'pointer', userSelect: 'none' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: censorEnabled ? '#FF6B6B' : '#888', fontFamily: 'Space Mono, monospace' }}>🔇 Mute profanity &amp; slurs</div>
                <div style={{ fontSize: 11, color: '#444', marginTop: 3 }}>Claude flags curse words — silenced in the output MP4</div>
              </div>
              <div style={{ width: 42, height: 24, borderRadius: 12, background: censorEnabled ? '#FF6B6B' : '#242424', position: 'relative', flexShrink: 0, transition: 'background 0.2s' }}>
                <div style={{ position: 'absolute', top: 3, left: censorEnabled ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: 'white', transition: 'left 0.2s' }} />
              </div>
            </div>

            {error && (
              <div style={{ padding: '10px 14px', background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.2)', borderRadius: 6, fontSize: 13, color: '#FF6B6B' }}>⚠ {error}</div>
            )}

            <button type="submit" disabled={loading || processing || !url}
              style={{ background: loading || processing || !url ? '#1a1a1a' : '#9146FF', color: loading || processing || !url ? '#444' : 'white', border: 'none', borderRadius: 7, padding: '12px 20px', fontFamily: 'Space Mono, monospace', fontWeight: 700, fontSize: 13, cursor: loading || processing || !url ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Analyzing...' : result ? 'Re-analyze →' : 'Analyze VOD →'}
            </button>
          </div>
        </form>

        {/* Loading */}
        {loading && (
          <div style={{ ...S.card, textAlign: 'center', padding: '32px 20px' }}>
            <div style={{ fontSize: 28, marginBottom: 12, animation: 'spin 1s linear infinite', display: 'inline-block' }}>◌</div>
            <div style={{ fontSize: 13, color: '#9146FF' }}>Claude is scanning for dead air...</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: hasMutes ? 'repeat(4,1fr)' : 'repeat(3,1fr)', gap: 10 }}>
              {[
                { label: 'Time Saved', value: `~${result.estimatedSavedMinutes}m`, color: '#39D353' },
                { label: 'Cuts Made', value: String(result.cuts.length), color: '#9146FF' },
                { label: 'Chapters', value: String(result.chapters.length), color: '#60A5FA' },
                ...(hasMutes ? [{ label: 'Words Muted', value: String(result.muteWords.length), color: '#FF6B6B' }] : []),
              ].map(s => (
                <div key={s.label} style={{ ...S.card, padding: '14px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 30, fontWeight: 700, color: s.color, fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.04em' }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* VOD info */}
            <div style={{ ...S.card, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{result.vodTitle}</div>
                <div style={{ fontSize: 12, color: '#555' }}>{result.streamer} · {result.totalDuration}</div>
              </div>
              <a href={`https://www.twitch.tv/videos/${result.vodId}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 12, color: '#9146FF', textDecoration: 'none' }}>View VOD ↗</a>
            </div>

            {/* Summary */}
            <div style={{ ...S.card, padding: '14px 16px', borderLeft: '3px solid #9146FF' }}>
              <span style={S.label}>AI Summary</span>
              <div style={{ fontSize: 13, lineHeight: 1.7, color: '#ccc' }}>{result.summary}</div>
            </div>

            {/* Timeline */}
            <div style={{ ...S.card, padding: '14px 16px' }}>
              <span style={S.label}>VOD Timeline</span>
              <div style={{ height: 28, background: '#1E3A2E', borderRadius: 4, position: 'relative', overflow: 'hidden', border: '1px solid #1a1a1a' }}>
                {result.cuts.map((c: any, i: number) => (
                  <div key={i} title={`${c.start}→${c.end}: ${c.reason}`}
                    style={{ position: 'absolute', top: 0, bottom: 0, left: `${(c.startSeconds/result.totalDurationSeconds)*100}%`, width: `${Math.max(((c.endSeconds-c.startSeconds)/result.totalDurationSeconds)*100, 0.3)}%`, background: COLORS[c.type]||'#9146FF', opacity: 0.75, cursor: 'pointer' }} />
                ))}
                {result.muteWords?.map((w: any, i: number) => (
                  <div key={`m${i}`} title={`Muted at ${w.timestamp}`}
                    style={{ position: 'absolute', top: 0, bottom: 0, width: 3, left: `${(w.startSeconds/result.totalDurationSeconds)*100}%`, background: '#FF6B6B', zIndex: 2 }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: '#555', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 10, height: 10, background: '#1E3A2E', display: 'inline-block', borderRadius: 2 }}/>kept
                </span>
                {Object.entries(COLORS).map(([k,v]) => (
                  <span key={k} style={{ fontSize: 11, color: '#555', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, background: v, display: 'inline-block', borderRadius: 2 }}/>{k}
                  </span>
                ))}
              </div>
            </div>

            {/* Tabs */}
            <div style={{ background: '#141414', border: '1px solid #242424', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', borderBottom: '1px solid #1a1a1a', overflowX: 'auto' }}>
                {[
                  { id: 'cuts', label: `✂ Cuts (${result.cuts.length})` },
                  { id: 'chapters', label: `◆ Chapters (${result.chapters.length})` },
                  ...(hasMutes ? [{ id: 'mutes', label: `🔇 Muted (${result.muteWords.length})` }] : []),
                ].map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    style={{ background: 'transparent', border: 'none', borderBottom: tab===t.id ? '2px solid #9146FF' : '2px solid transparent', padding: '11px 18px', color: tab===t.id ? '#9146FF' : '#555', fontFamily: 'Space Mono, monospace', fontSize: 12, cursor: 'pointer', fontWeight: tab===t.id ? 700 : 400, whiteSpace: 'nowrap' }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div style={{ maxHeight: 280, overflowY: 'auto', padding: 14 }}>
                {tab === 'cuts' && result.cuts.map((c: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: '#0C0C0C', borderRadius: 5, marginBottom: 6, borderLeft: `3px solid ${COLORS[c.type]||'#9146FF'}` }}>
                    <span style={{ fontSize: 10, color: COLORS[c.type], fontWeight: 700, minWidth: 75, textTransform: 'uppercase' }}>{c.type}</span>
                    <span style={{ fontSize: 11, color: '#555', minWidth: 110 }}>{c.start}→{c.end}</span>
                    <span style={{ fontSize: 12, color: '#888', flex: 1 }}>{c.reason}</span>
                    <span style={{ fontSize: 11, color: '#444' }}>-{toTS(c.endSeconds-c.startSeconds)}</span>
                  </div>
                ))}
                {tab === 'chapters' && result.chapters.map((c: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: '#0C0C0C', borderRadius: 5, marginBottom: 6 }}>
                    <span style={{ fontSize: 16 }}>{ICONS[c.type]||'●'}</span>
                    <span style={{ fontSize: 11, color: '#555', minWidth: 75 }}>{c.timestamp}</span>
                    <span style={{ fontSize: 13, color: '#ddd' }}>{c.title}</span>
                  </div>
                ))}
                {tab === 'mutes' && result.muteWords?.map((w: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: '#0C0C0C', borderRadius: 5, marginBottom: 6, borderLeft: '3px solid #FF6B6B' }}>
                    <span style={{ fontSize: 18 }}>🔇</span>
                    <span style={{ fontSize: 11, color: '#555', minWidth: 75 }}>{w.timestamp}</span>
                    <span style={{ fontSize: 12, color: '#888' }}>Profanity flagged — {(w.endSeconds - w.startSeconds).toFixed(1)}s muted</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── DOWNLOAD MP4 SECTION ── */}
            <div style={{ ...S.card, padding: '20px' }}>
              <span style={S.label}>Get trimmed MP4</span>

              {!processJob && (
                <>
                  <div style={{ fontSize: 13, color: '#888', marginBottom: 14, lineHeight: 1.7 }}>
                    Click below to download the actual trimmed video. The worker will download your VOD, cut the dead segments, {hasMutes ? 'mute flagged words, ' : ''}and add chapter markers — then hand you the MP4.
                  </div>
                  <div style={{ fontSize: 11, color: '#444', marginBottom: 14, padding: '8px 12px', background: '#0C0C0C', borderRadius: 6 }}>
                    ⏱ Estimated time: ~{Math.max(2, Math.round(result.totalDurationSeconds / 300))}–{Math.max(5, Math.round(result.totalDurationSeconds / 120))} min depending on VOD size
                  </div>
                  <button onClick={startProcessing}
                    style={{ background: '#9146FF', color: 'white', border: 'none', borderRadius: 7, padding: '12px 20px', fontFamily: 'Space Mono, monospace', fontWeight: 700, fontSize: 13, cursor: 'pointer', width: '100%' }}>
                    ⬇ Generate &amp; Download MP4
                  </button>
                </>
              )}

              {processJob && !jobDone && !jobError && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <span style={{ fontSize: 20 }}>{PHASE_ICONS[processJob.status] || '⚙'}</span>
                    <span style={{ fontSize: 13, color: '#ccc' }}>{processJob.phase}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9146FF', fontFamily: 'Space Mono, monospace' }}>{processJob.progress}%</span>
                  </div>
                  <div style={{ height: 6, background: '#0C0C0C', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: 'linear-gradient(90deg,#7C3AED,#9146FF)', borderRadius: 3, width: `${processJob.progress}%`, transition: 'width 0.5s' }} />
                  </div>
                  <div style={{ fontSize: 11, color: '#444', marginTop: 8 }}>
                    {processJob.status === 'downloading' && 'Downloading VOD from Twitch — this is the slowest step for long streams'}
                    {processJob.status === 'trimming' && 'Cutting segments with FFmpeg stream copy — no re-encoding, very fast'}
                    {processJob.status === 'merging' && 'Stitching segments together'}
                    {processJob.status === 'censoring' && 'Muting flagged words in audio track'}
                    {processJob.status === 'finalizing' && 'Embedding chapter markers into MP4'}
                  </div>
                </div>
              )}

              {jobDone && (
                <div>
                  <div style={{ fontSize: 13, color: '#39D353', marginBottom: 14 }}>✅ Your trimmed MP4 is ready!</div>
                  <a href={`${WORKER_URL}/api/download/${processJob.jobId}`} download
                    style={{ display: 'block', background: '#39D353', color: '#0C0C0C', border: 'none', borderRadius: 7, padding: '12px 20px', fontFamily: 'Space Mono, monospace', fontWeight: 700, fontSize: 13, cursor: 'pointer', width: '100%', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
                    ⬇ Download {safe(result.vodTitle)}_trimmed.mp4
                  </a>
                  <div style={{ fontSize: 11, color: '#444', marginTop: 8 }}>
                    File will be deleted from the server after download.
                  </div>
                </div>
              )}

              {jobError && (
                <div style={{ padding: '10px 14px', background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.2)', borderRadius: 6, fontSize: 13, color: '#FF6B6B' }}>
                  ⚠ {processJob.error || 'Processing failed. Try again.'}
                  <button onClick={() => { setProcessJob(null); setProcessing(false) }}
                    style={{ display: 'block', marginTop: 8, background: 'transparent', border: '1px solid #FF6B6B', color: '#FF6B6B', borderRadius: 5, padding: '6px 12px', fontFamily: 'Space Mono, monospace', fontSize: 11, cursor: 'pointer' }}>
                    Try again
                  </button>
                </div>
              )}
            </div>

            {/* Text file downloads still available */}
            <details style={{ ...S.card, padding: '14px 16px' }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#555', fontFamily: 'Space Mono, monospace', userSelect: 'none' }}>
                Also available: EDL / Chapter text files
              </summary>
              <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { label: 'EDL File', desc: 'Premiere / DaVinci', ext: 'edl', content: buildEDL(result.cuts, result.vodTitle, result.totalDurationSeconds), icon: '🎬' },
                  { label: 'Chapters', desc: 'YouTube / text', ext: 'txt', content: buildChaptersTxt(result.chapters, result.cuts), icon: '📍' },
                ].map((d, i) => (
                  <button key={i} onClick={() => dl(`${safe(result.vodTitle)}.${d.ext}`, d.content)}
                    style={{ background: 'transparent', border: '1px solid #242424', borderRadius: 7, padding: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 16 }}>{d.icon}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#ddd', fontFamily: 'Space Mono, monospace' }}>{d.label}</span>
                    <span style={{ fontSize: 10, color: '#555', fontFamily: 'Space Mono, monospace' }}>{d.desc}</span>
                  </button>
                ))}
              </div>
            </details>

          </div>
        )}
      </div>
    </main>
  )
}

// Client-side EDL/chapters builders for the text download fallback
function toTC(s: number) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}
function toTC_EDL(s: number) { return toTC(s) + ':00' }
function buildEDL(cuts: any[], title: string, total: number) {
  const sorted = [...cuts].sort((a, b) => a.startSeconds - b.startSeconds)
  const keep: {start:number,end:number}[] = []
  let cur = 0
  for (const c of sorted) { if (c.startSeconds > cur+1) keep.push({start:cur,end:c.startSeconds}); cur = c.endSeconds }
  if (cur < total-1) keep.push({start:cur,end:total})
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', '']
  let rec = 0
  keep.forEach((seg, i) => {
    const dur = seg.end - seg.start
    lines.push(`${String(i+1).padStart(3,'0')}  AX       V     C        ${toTC_EDL(seg.start)} ${toTC_EDL(seg.end)} ${toTC_EDL(rec)} ${toTC_EDL(rec+dur)}`)
    lines.push(`* FROM CLIP NAME: ${title}`); lines.push(''); rec += dur
  })
  return lines.join('\n')
}
function buildChaptersTxt(chapters: any[], cuts: any[]) {
  const lines = ['CHAPTERS\n']
  for (const ch of chapters) {
    let offset = 0
    for (const c of cuts) { if (c.endSeconds <= ch.seconds) offset += c.endSeconds - c.startSeconds; else if (c.startSeconds < ch.seconds) { offset += ch.seconds - c.startSeconds; break } }
    lines.push(`${toTC(Math.max(0, ch.seconds - offset))}  ${ch.title}`)
  }
  return lines.join('\n')
}
