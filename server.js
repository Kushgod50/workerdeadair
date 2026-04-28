const express = require('express')
const cors = require('cors')
const { exec, spawn } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const fsp = require('fs').promises
const path = require('path')
const os = require('os')
const Anthropic = require('@anthropic-ai/sdk')

const execAsync = promisify(exec)
const app = express()
const PORT = process.env.PORT || 3001
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }))
app.use(express.json({ limit: '10mb' }))

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTC(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

function log(jobId, msg) { console.log(`[${jobId || 'server'}] ${msg}`) }

// ── Job store ─────────────────────────────────────────────────────────────────

const jobs = new Map()

function setJob(id, data) {
  jobs.set(id, { ...(jobs.get(id) || {}), ...data, updatedAt: Date.now() })
}

function getJob(id) { return jobs.get(id) }

// Clean up old jobs after 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  for (const [id, job] of jobs.entries()) {
    if (job.updatedAt < cutoff) {
      if (job.outputPath) fsp.unlink(job.outputPath).catch(() => {})
      jobs.delete(id)
    }
  }
}, 30 * 60 * 1000)

// ── Claude analysis ───────────────────────────────────────────────────────────

const GUIDES = {
  conservative: 'Only cut silences longer than 45 seconds and clear AFK moments.',
  moderate: 'Cut silences over 15s, AFK/BRB periods, loading screens, low-energy segments.',
  aggressive: 'Cut everything slow: silence over 5s, all filler, repetitive content.',
}

app.post('/api/analyze', async (req, res) => {
  try {
    const { url, description = '', aggressiveness = 'moderate', censorEnabled = false } = req.body
    if (!url) return res.status(400).json({ error: 'Missing URL' })
    const match = url.match(/twitch\.tv\/videos\/(\d+)/)
    if (!match) return res.status(400).json({ error: 'Invalid Twitch VOD URL' })
    const vodId = match[1]

    const guide = GUIDES[aggressiveness] || GUIDES.moderate
    const censorSection = censorEnabled
      ? '\nCENSORSHIP: Also identify every moment where profanity or slurs are spoken. For each word flag the exact timestamp with ~0.3s padding. Include in "muteWords" array.'
      : ''
    const muteShape = censorEnabled
      ? '"muteWords": [{"startSeconds":number,"endSeconds":number,"word":"[censored]","timestamp":"HH:MM:SS"}],'
      : '"muteWords": [],'

    const prompt = `Analyze this Twitch VOD for dead time to cut.
VOD: ${url}
${description ? `Notes: ${description}` : ''}
Aggressiveness: ${aggressiveness} — ${guide}
${censorSection}

Return ONLY valid JSON (no markdown):
{
  "vodTitle": "string",
  "streamer": "string",
  "totalDuration": "HH:MM:SS",
  "totalDurationSeconds": number,
  "chapters": [{"timestamp":"HH:MM:SS","seconds":number,"title":"string","type":"stream_start|highlight|game_change|topic_change|stream_end"}],
  "cuts": [{"start":"HH:MM:SS","end":"HH:MM:SS","startSeconds":number,"endSeconds":number,"reason":"string","type":"silence|afk|filler|technical|low_energy"}],
  ${muteShape}
  "estimatedSavedMinutes": number,
  "summary": "string"
}`

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    })

    const raw = resp.content[0].type === 'text' ? resp.content[0].text : ''
    const parsed = JSON.parse(raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim())
    parsed.cuts.sort((a, b) => a.startSeconds - b.startSeconds)
    return res.json({ vodId, ...parsed, muteWords: parsed.muteWords || [] })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message || 'Analysis failed' })
  }
})

// ── Start processing job ──────────────────────────────────────────────────────

app.post('/api/process', async (req, res) => {
  const { url, cuts, muteWords = [], vodTitle = 'output' } = req.body
  if (!url || !cuts) return res.status(400).json({ error: 'Missing url or cuts' })

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
  setJob(jobId, { status: 'queued', progress: 0, phase: 'Starting...', vodTitle })
  res.json({ jobId })

  processVideo(jobId, url, cuts, muteWords, vodTitle).catch(e => {
    console.error(`[${jobId}] Fatal:`, e.message)
    setJob(jobId, { status: 'error', error: e.message })
  })
})

// ── Poll status ───────────────────────────────────────────────────────────────

app.get('/api/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  // Don't send the file path to the client
  const { outputPath, ...safe } = job
  res.json(safe)
})

// ── Download ──────────────────────────────────────────────────────────────────

app.get('/api/download/:jobId', (req, res) => {
  const job = getJob(req.params.jobId)
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' })
  if (!job.outputPath || !fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'File missing' })

  const filename = `${(job.vodTitle || 'vod').replace(/[^a-z0-9]/gi,'_').toLowerCase()}_trimmed.mp4`
  const fileSize = fs.statSync(job.outputPath).size
  log(job.vodTitle, `Serving ${(fileSize/1024/1024).toFixed(1)}MB`)

  // Support range requests so browser can resume if connection drops
  const range = req.headers.range
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    const chunkSize = end - start + 1
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    res.setHeader('Content-Length', chunkSize)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    const stream = fs.createReadStream(job.outputPath, { start, end })
    stream.pipe(res)
    stream.on('error', e => { console.error('Range stream error:', e.message); res.end() })
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Length', fileSize)
    res.setHeader('Accept-Ranges', 'bytes')
    const stream = fs.createReadStream(job.outputPath)
    stream.pipe(res)
    stream.on('error', e => { console.error('Stream error:', e.message); res.end() })
    stream.on('close', () => {
      // Delay cleanup 30s to ensure browser received everything
      setTimeout(() => {
        fsp.unlink(job.outputPath).catch(() => {})
        fsp.rm(path.dirname(job.outputPath), { recursive: true, force: true }).catch(() => {})
      }, 30000)
    })
  }
})

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, jobs: jobs.size }))

// ── Core processing ───────────────────────────────────────────────────────────

async function processVideo(jobId, url, cuts, muteWords, vodTitle) {
  const tmpDir = path.join(os.tmpdir(), jobId)
  await fsp.mkdir(tmpDir, { recursive: true })
  log(jobId, `Working in ${tmpDir}`)

  try {
    // ── Step 1: Download with yt-dlp ─────────────────────────────────────────
    setJob(jobId, { status: 'downloading', phase: 'Downloading VOD from Twitch', progress: 2 })
    log(jobId, 'Starting download...')

    const inputPath = path.join(tmpDir, 'input.mp4')

    await new Promise((resolve, reject) => {
      // Use cookies-from-browser or just best available format
      // --no-check-certificate helps with some proxy issues
      // --retries 3 retries on transient failures  
      const args = [
        url,
        '--no-playlist',
        '--retries', '3',
        '--fragment-retries', '3',
        '--file-access-retries', '3',
        '--no-check-certificates',
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '-o', inputPath,
        '--newline',
        '--progress',
      ]

      log(jobId, `yt-dlp ${args.join(' ')}`)
      const proc = spawn('yt-dlp', args, { cwd: tmpDir })

      proc.stdout.on('data', (data) => {
        const line = data.toString().trim()
        if (!line) return
        console.log(`[${jobId}][yt-dlp] ${line}`)

        // Parse download percentage
        const pct = line.match(/(\d+\.?\d*)%/)
        if (pct) {
          const p = Math.min(38, Math.round(parseFloat(pct[1]) * 0.38))
          setJob(jobId, { progress: 2 + p, phase: `Downloading: ${Math.round(parseFloat(pct[1]))}%` })
        }
      })

      proc.stderr.on('data', (data) => {
        const line = data.toString().trim()
        if (line) console.error(`[${jobId}][yt-dlp stderr] ${line}`)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          log(jobId, 'yt-dlp finished successfully')
          resolve()
        } else {
          reject(new Error(`yt-dlp failed with exit code ${code}. The VOD may be subscriber-only or unavailable.`))
        }
      })

      proc.on('error', (e) => reject(new Error(`yt-dlp not found: ${e.message}. Make sure yt-dlp is installed.`)))
    })

    // Verify file exists
    if (!fs.existsSync(inputPath)) {
      throw new Error('Download completed but output file not found')
    }
    const inputSize = fs.statSync(inputPath).size
    log(jobId, `Downloaded: ${(inputSize / 1024 / 1024).toFixed(1)} MB`)

    // ── Step 2: Get video duration ────────────────────────────────────────────
    const { stdout: durOut } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    )
    const totalSeconds = parseFloat(durOut.trim())
    log(jobId, `Video duration: ${toTC(totalSeconds)}`)

    // ── Step 3: Build keep list ───────────────────────────────────────────────
    const sortedCuts = [...cuts].sort((a, b) => a.startSeconds - b.startSeconds)
    const keepSegments = []
    let cursor = 0

    for (const cut of sortedCuts) {
      if (cut.startSeconds > cursor + 1) {
        keepSegments.push({ start: cursor, end: Math.min(cut.startSeconds, totalSeconds) })
      }
      cursor = cut.endSeconds
    }
    if (cursor < totalSeconds - 1) keepSegments.push({ start: cursor, end: totalSeconds })

    if (keepSegments.length === 0) throw new Error('No segments to keep after applying cuts')
    log(jobId, `Keeping ${keepSegments.length} segments`)

    // ── Step 4: Extract segments ──────────────────────────────────────────────
    setJob(jobId, { status: 'trimming', phase: 'Cutting dead segments', progress: 42 })

    const segsDir = path.join(tmpDir, 'segs')
    await fsp.mkdir(segsDir, { recursive: true })

    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i]
      const outSeg = path.join(segsDir, `${String(i).padStart(4,'0')}.ts`)
      const dur = seg.end - seg.start
      const cmd = `ffmpeg -y -ss ${seg.start} -i "${inputPath}" -t ${dur} -c copy -avoid_negative_ts 1 "${outSeg}" 2>&1`
      await execAsync(cmd)
      const pct = 42 + Math.round(((i + 1) / keepSegments.length) * 22)
      setJob(jobId, { progress: pct, phase: `Cutting segment ${i + 1} of ${keepSegments.length}` })
      log(jobId, `Segment ${i+1}/${keepSegments.length}: ${toTC(seg.start)}→${toTC(seg.end)}`)
    }

    // ── Step 5: Concat ────────────────────────────────────────────────────────
    setJob(jobId, { status: 'merging', phase: 'Merging segments', progress: 66 })

    const listPath = path.join(tmpDir, 'list.txt')
    const segFiles = (await fsp.readdir(segsDir))
      .filter(f => f.endsWith('.ts'))
      .sort()
      .map(f => `file '${path.join(segsDir, f)}'`)
      .join('\n')
    await fsp.writeFile(listPath, segFiles)

    const mergedPath = path.join(tmpDir, 'merged.mp4')
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${mergedPath}" 2>&1`)
    log(jobId, 'Merge complete')

    // ── Step 6: Mute words ────────────────────────────────────────────────────
    let workingPath = mergedPath

    if (muteWords && muteWords.length > 0) {
      setJob(jobId, { status: 'censoring', phase: `Muting ${muteWords.length} flagged words`, progress: 74 })

      const remapped = muteWords.map(w => {
        let offset = 0
        for (const c of sortedCuts) {
          if (c.endSeconds <= w.startSeconds) offset += c.endSeconds - c.startSeconds
          else if (c.startSeconds < w.startSeconds) { offset += w.startSeconds - c.startSeconds; break }
        }
        return { start: Math.max(0, w.startSeconds - offset), end: Math.max(0, w.endSeconds - offset) }
      })

      const filterChain = remapped
        .map(w => `volume=enable='between(t,${w.start},${w.end})':volume=0`)
        .join(',')

      const mutedPath = path.join(tmpDir, 'muted.mp4')
      await execAsync(`ffmpeg -y -i "${mergedPath}" -af "${filterChain}" -c:v copy "${mutedPath}" 2>&1`)
      await fsp.unlink(mergedPath).catch(() => {})
      workingPath = mutedPath
      log(jobId, `Muted ${muteWords.length} words`)
    }

    // ── Step 7: Add chapter markers ───────────────────────────────────────────
    setJob(jobId, { status: 'finalizing', phase: 'Embedding chapter markers', progress: 88 })

    const metaLines = [';FFMETADATA1', '']
    let outputTime = 0
    keepSegments.forEach((seg, i) => {
      const dur = seg.end - seg.start
      metaLines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(outputTime * 1000)}`, `END=${Math.round((outputTime + dur) * 1000) - 1}`, `title=Segment ${i + 1}`, '')
      outputTime += dur
    })

    const metaPath = path.join(tmpDir, 'meta.txt')
    await fsp.writeFile(metaPath, metaLines.join('\n'))

    const outputPath = path.join(tmpDir, 'output.mp4')
    await execAsync(`ffmpeg -y -i "${workingPath}" -i "${metaPath}" -map_metadata 1 -codec copy "${outputPath}" 2>&1`)

    // Cleanup intermediates
    await fsp.unlink(inputPath).catch(() => {})
    await fsp.rm(segsDir, { recursive: true, force: true }).catch(() => {})
    await fsp.unlink(workingPath).catch(() => {})
    await fsp.unlink(metaPath).catch(() => {})
    await fsp.unlink(listPath).catch(() => {})

    const outSize = fs.statSync(outputPath).size
    log(jobId, `Done! Output: ${(outSize / 1024 / 1024).toFixed(1)} MB`)

    setJob(jobId, {
      status: 'done',
      phase: 'Complete ✓',
      progress: 100,
      outputPath,
      vodTitle,
      fileSizeMB: (outSize / 1024 / 1024).toFixed(1),
    })

  } catch (e) {
    log(jobId, `Error: ${e.message}`)
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    setJob(jobId, { status: 'error', error: e.message, phase: 'Failed' })
  }
}

app.listen(PORT, () => log(null, `Worker running on port ${PORT}`))
