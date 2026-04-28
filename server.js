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

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}))
app.use(express.json())

// ── Helpers ──────────────────────────────────────────────────────────────────

function toTC(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

function log(jobId, msg) {
  console.log(`[${jobId}] ${msg}`)
}

// In-memory job store
const jobs = new Map()

function setJob(id, data) {
  jobs.set(id, { ...jobs.get(id), ...data, updatedAt: Date.now() })
}

// ── /api/analyze — Claude analysis only, fast ─────────────────────────────

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

// ── /api/process — download + trim + mute, returns job ID ────────────────

app.post('/api/process', async (req, res) => {
  const { url, cuts, muteWords = [], vodTitle = 'output' } = req.body
  if (!url || !cuts) return res.status(400).json({ error: 'Missing url or cuts' })

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
  setJob(jobId, { status: 'queued', progress: 0, phase: 'Queued', vodTitle })
  res.json({ jobId })

  // Run async
  processVideo(jobId, url, cuts, muteWords, vodTitle).catch(e => {
    console.error(`[${jobId}] Fatal:`, e)
    setJob(jobId, { status: 'error', error: e.message })
  })
})

// ── /api/status/:jobId ────────────────────────────────────────────────────

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json(job)
})

// ── /api/download/:jobId ─────────────────────────────────────────────────

app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' })
  if (!fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'File not found' })

  const filename = `${job.vodTitle.replace(/[^a-z0-9]/gi,'_').toLowerCase()}_trimmed.mp4`
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Type', 'video/mp4')

  const stream = fs.createReadStream(job.outputPath)
  stream.pipe(res)
  stream.on('end', () => {
    // Clean up file after download
    fsp.unlink(job.outputPath).catch(() => {})
    fsp.rmdir(path.dirname(job.outputPath)).catch(() => {})
  })
})

// ── Core processing function ──────────────────────────────────────────────

async function processVideo(jobId, url, cuts, muteWords, vodTitle) {
  const tmpDir = path.join(os.tmpdir(), jobId)
  await fsp.mkdir(tmpDir, { recursive: true })

  try {
    // Step 1: Download VOD with yt-dlp
    log(jobId, 'Downloading VOD...')
    setJob(jobId, { status: 'downloading', phase: 'Downloading VOD', progress: 5 })

    const inputPath = path.join(tmpDir, 'input.mp4')
    await downloadWithYtDlp(url, inputPath, (percent) => {
      setJob(jobId, { progress: Math.round(5 + percent * 0.4), phase: `Downloading: ${percent}%` })
    })
    log(jobId, 'Download complete')

    // Step 2: Extract keep segments
    log(jobId, 'Extracting segments...')
    setJob(jobId, { status: 'trimming', phase: 'Cutting dead segments', progress: 45 })

    const sortedCuts = [...cuts].sort((a, b) => a.startSeconds - b.startSeconds)
    const keepSegments = []
    let cursor = 0
    const totalSeconds = await getVideoDuration(inputPath)

    for (const cut of sortedCuts) {
      if (cut.startSeconds > cursor + 1) keepSegments.push({ start: cursor, end: cut.startSeconds })
      cursor = cut.endSeconds
    }
    if (cursor < totalSeconds - 1) keepSegments.push({ start: cursor, end: totalSeconds })

    const segsDir = path.join(tmpDir, 'segs')
    await fsp.mkdir(segsDir, { recursive: true })

    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i]
      const outPath = path.join(segsDir, `${String(i).padStart(4,'0')}.ts`)
      await execAsync(
        `ffmpeg -y -ss ${seg.start} -i "${inputPath}" -t ${seg.end - seg.start} -c copy -avoid_negative_ts 1 "${outPath}"`
      )
      const pct = 45 + Math.round(((i+1)/keepSegments.length) * 25)
      setJob(jobId, { progress: pct, phase: `Cutting segment ${i+1}/${keepSegments.length}` })
      log(jobId, `Segment ${i+1}/${keepSegments.length}`)
    }

    // Step 3: Concatenate
    log(jobId, 'Concatenating...')
    setJob(jobId, { status: 'merging', phase: 'Merging segments', progress: 72 })

    const listPath = path.join(tmpDir, 'list.txt')
    const segFiles = (await fsp.readdir(segsDir))
      .filter(f => f.endsWith('.ts'))
      .sort()
      .map(f => `file '${path.join(segsDir, f)}'`)
      .join('\n')
    await fsp.writeFile(listPath, segFiles)

    const mergedPath = path.join(tmpDir, 'merged.mp4')
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${mergedPath}"`)

    // Step 4: Mute words (if any)
    let processedPath = mergedPath
    if (muteWords && muteWords.length > 0) {
      log(jobId, `Muting ${muteWords.length} words...`)
      setJob(jobId, { status: 'censoring', phase: `Muting ${muteWords.length} flagged words`, progress: 82 })

      // Remap mute timestamps to output file
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
      await execAsync(`ffmpeg -y -i "${mergedPath}" -af "${filterChain}" -c:v copy "${mutedPath}"`)
      processedPath = mutedPath
    }

    // Step 5: Add chapter markers
    log(jobId, 'Adding chapter markers...')
    setJob(jobId, { status: 'finalizing', phase: 'Adding chapter markers', progress: 90 })

    const outputPath = path.join(tmpDir, 'output.mp4')
    // Build basic chapter metadata from cut points
    const chapterMeta = buildChapterMeta(keepSegments)
    const metaPath = path.join(tmpDir, 'chapters.txt')
    await fsp.writeFile(metaPath, chapterMeta)
    await execAsync(`ffmpeg -y -i "${processedPath}" -i "${metaPath}" -map_metadata 1 -codec copy "${outputPath}"`)

    // Cleanup intermediate files
    await fsp.unlink(inputPath).catch(() => {})
    await fsp.rm(segsDir, { recursive: true }).catch(() => {})
    await fsp.unlink(mergedPath).catch(() => {})
    if (processedPath !== mergedPath) await fsp.unlink(processedPath).catch(() => {})
    await fsp.unlink(metaPath).catch(() => {})
    await fsp.unlink(listPath).catch(() => {})

    log(jobId, 'Done!')
    setJob(jobId, {
      status: 'done',
      phase: 'Complete',
      progress: 100,
      outputPath,
      vodTitle,
    })

  } catch (e) {
    // Cleanup on error
    await fsp.rm(tmpDir, { recursive: true }).catch(() => {})
    throw e
  }
}

async function downloadWithYtDlp(url, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--output', outputPath,
      '--newline',
      url,
    ]

    const proc = spawn('yt-dlp', args)
    proc.stdout.on('data', (data) => {
      const line = data.toString()
      const match = line.match(/(\d+\.?\d*)%/)
      if (match && onProgress) onProgress(Math.round(parseFloat(match[1])))
    })
    proc.stderr.on('data', d => console.error('[yt-dlp]', d.toString()))
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`yt-dlp exited with code ${code}`))
    })
  })
}

async function getVideoDuration(inputPath) {
  const { stdout } = await execAsync(
    `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
  )
  return parseFloat(stdout.trim())
}

function buildChapterMeta(keepSegments) {
  const lines = [';FFMETADATA1', '']
  let outputTime = 0
  keepSegments.forEach((seg, i) => {
    const dur = seg.end - seg.start
    const startMs = Math.round(outputTime * 1000)
    const endMs = Math.round((outputTime + dur) * 1000) - 1
    lines.push('[CHAPTER]')
    lines.push('TIMEBASE=1/1000')
    lines.push(`START=${startMs}`)
    lines.push(`END=${endMs}`)
    lines.push(`title=Segment ${i + 1}`)
    lines.push('')
    outputTime += dur
  })
  return lines.join('\n')
}

// ── Health check ──────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`VOD Trimmer worker running on port ${PORT}`))
