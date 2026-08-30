import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from 'dotenv'

// Import logic for Chrome Extension endpoints
import { getPendingVideos, removePendingVideos, getAllChannels, removeTrackedChannel, addTrackedChannel, getCategories, saveCategory, deleteCategory, renameCategory, getAllAnalyses, getDailyCost, updatePendingVideos, updateAllChannels, getCategorisationPromptDetails, saveCategorisationPrompt, addPendingVideo, isVideoProcessed, getFailedVideos, saveFailedVideo, clearFailedVideo } from '../trigger/youtube-pipeline/kv-client'
import { processVideos } from '../trigger/youtube-pipeline/process-video'
import { completeText } from '../trigger/youtube-pipeline/llm-client'
import { classifyChannel } from '../trigger/youtube-pipeline/classify-channel'
import { resolveChannelInfo, resolveVideoDuration, getTranscriptSample, fetchTranscriptCues, fetchVideoDescription, isPlaceholderChannelName, resolveVideoIdentity } from '../trigger/utils'
import { subscribeSingleChannel, unsubscribeSingleChannel } from '../trigger/youtube-pipeline/pubsub-manager'
import { loadUserSecrets, saveUserSecrets, secretsStatus } from '../trigger/youtube-pipeline/secrets'

config()
loadUserSecrets()

type Job = {
    status: "working" | "done" | "failed"
    results?: Array<{ videoId: string; title: string; status: string; error?: string }>
    error?: string
}
const jobs = new Map<string, Job>()

const app = new Hono()

// Enable CORS for Chrome Extension requests
app.use('/api/extension/*', async (c, next) => {
    if (c.req.header('Access-Control-Request-Private-Network') === 'true') {
        c.header('Access-Control-Allow-Private-Network', 'true')
    }
    await next()
})
app.use('/api/extension/*', cors({
    origin: (origin) => {
        if (!origin) return 'http://localhost:3000'
        if (origin.startsWith('chrome-extension://') || origin.startsWith('http://localhost:')) {
            return origin
        }
        return 'http://localhost:3000'
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
}))

// === CHROME EXTENSION ENDPOINTS ===

app.get('/api/extension/health', (c) => {
    loadUserSecrets()
    const secrets = secretsStatus()
    return c.json({ success: true, ok: true, ...secrets })
})

app.get('/api/extension/secrets', (c) => {
    loadUserSecrets()
    return c.json({ success: true, ...secretsStatus() })
})

app.post('/api/extension/secrets', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}))
        const patch: { OPENROUTER_API_KEY?: string; GOOGLE_API_KEY?: string } = {}
        if (typeof body.openrouterApiKey === "string" && body.openrouterApiKey.trim()) {
            patch.OPENROUTER_API_KEY = body.openrouterApiKey.trim()
        }
        if (typeof body.googleApiKey === "string" && body.googleApiKey.trim()) {
            patch.GOOGLE_API_KEY = body.googleApiKey.trim()
        }
        if (!patch.OPENROUTER_API_KEY && !patch.GOOGLE_API_KEY) {
            return c.json({ success: false, error: "Paste an OpenRouter key to save" }, 400)
        }
        saveUserSecrets(patch)
        return c.json({ success: true, ...secretsStatus() })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.get('/api/extension/identity/:videoId', async (c) => {
    try {
        const videoId = c.req.param("videoId")
        const identity = await resolveVideoIdentity(videoId)
        if (!identity) return c.json({ success: false, error: "not found" }, 404)
        let channelId: string | undefined
        if (identity.authorUrl) {
            const info = await resolveChannelInfo(identity.authorUrl).catch(() => null)
            if (info?.id) channelId = info.id
        }
        return c.json({ success: true, ...identity, channelId })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.get('/api/extension/bootstrap', (c) => {
    const workerUrl = process.env.WORKER_BASE_URL || ''
    const token = process.env.WORKER_API_SECRET || ''
    if (!workerUrl || !token) {
        return c.json({ success: false, error: 'Worker credentials missing in .env' }, 500)
    }
    return c.json({ success: true, workerUrl, token })
})

// 1. Get the pending queue
app.get('/api/extension/queue', async (c) => {
    try {
        const pending = await getPendingVideos()
        return c.json({ success: true, queue: pending })
    } catch (e) {
        console.error('Error fetching queue:', e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 2. Discard a pending video
app.post('/api/extension/discard', async (c) => {
    try {
        const { videoId } = await c.req.json()
        if (!videoId) return c.json({ success: false, error: 'Missing videoId' }, 400)
        
        await removePendingVideos([videoId])
        return c.json({ success: true })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 3. Process a video (from queue OR directly from Youtube)
app.post('/api/extension/process', async (c) => {
    try {
        const body = await c.req.json()
        
        // Ensure it's formatted as an array for the task
        const videos = body.videos ? body.videos : [body]
        
        console.log(`[Extension] Processing ${videos.length} video(s)`)
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        jobs.set(jobId, { status: "working" })
        processVideos({ videos }).then(async (result) => {
            jobs.set(jobId, { status: "done", results: result.results })
            for (const item of result.results || []) {
                if (item.status === "error") {
                    const source = videos.find((v: any) => v.videoId === item.videoId) || {}
                    await saveFailedVideo({
                        ...source,
                        videoId: item.videoId,
                        title: item.title,
                        error: item.error,
                        failedAt: new Date().toISOString(),
                    }).catch((err) => console.error("Failed to persist error:", err))
                }
            }
        }).catch((err) => {
            console.error('[Extension] Process failed:', err)
            jobs.set(jobId, { status: "failed", error: String(err) })
        })

        return c.json({ success: true, jobId })
    } catch (e) {
        console.error('Error triggering process:', e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.get('/api/extension/process/:jobId', (c) => {
    const job = jobs.get(c.req.param('jobId'))
    if (!job) return c.json({ success: false, error: 'Unknown job' }, 404)
    return c.json({ success: true, ...job })
})

app.post('/api/extension/queue/restore', async (c) => {
    try {
        const video = await c.req.json()
        if (!video?.videoId) return c.json({ success: false, error: 'Missing videoId' }, 400)
        await addPendingVideo(video)
        return c.json({ success: true })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.post('/api/extension/queue', async (c) => {
    try {
        const body = await c.req.json()
        const videos = Array.isArray(body.videos) ? body.videos : [body]
        const pending = await getPendingVideos()
        const pendingIds = new Set(pending.map((v) => v.videoId).filter(Boolean))
        const results: Array<{ videoId?: string; status: string; error?: string }> = []

        for (const raw of videos) {
            const video = raw || {}
            const videoId = video.videoId
            if (!videoId) {
                results.push({ status: "error", error: "Missing videoId" })
                continue
            }
            if (pendingIds.has(videoId)) {
                results.push({ videoId, status: "exists" })
                continue
            }
            if (await isVideoProcessed(videoId)) {
                results.push({ videoId, status: "processed" })
                continue
            }

            let duration = video.duration
            if (!duration && video.videoUrl) {
                duration = await resolveVideoDuration(video.videoUrl) || undefined
            }

            // Manual send always queues, including Shorts. Resolve names via oEmbed so we never persist "Unknown".
            const identity = (isPlaceholderChannelName(video.channelName) || !video.title || isPlaceholderChannelName(video.title))
                ? await resolveVideoIdentity(videoId).catch(() => null)
                : null
            let channelId = video.channelId && video.channelId !== "manual_ingest" ? video.channelId : ""
            let channelName = !isPlaceholderChannelName(video.channelName) ? video.channelName : (identity?.channelName || "")
            if (!channelId && identity?.authorUrl) {
                const info = await resolveChannelInfo(identity.authorUrl).catch(() => null)
                if (info?.id) channelId = info.id
                if (info?.name && isPlaceholderChannelName(channelName)) channelName = info.name
            }

            const now = new Date().toISOString()
            const entry = {
                ...video,
                videoId,
                title: (video.title && !isPlaceholderChannelName(video.title) ? video.title : identity?.title) || videoId,
                channelId: channelId || "manual_ingest",
                channelName,
                category: video.needsCategory ? (video.category || "") : (video.category || "Strategy"),
                publishedAt: video.publishedAt || now,
                videoUrl: video.videoUrl || `https://www.youtube.com/watch?v=${videoId}`,
                addedAt: video.addedAt || now,
                duration,
                needsCategory: !!video.needsCategory,
            }
            await addPendingVideo(entry)
            pendingIds.add(videoId)
            results.push({ videoId, status: "queued" })
        }

        return c.json({ success: true, results })
    } catch (e) {
        console.error("Error queueing videos:", e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.get('/api/extension/failed', async (c) => {
    try {
        const failed = await getFailedVideos()
        return c.json({ success: true, failed })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.post('/api/extension/failed/clear', async (c) => {
    try {
        const { videoId } = await c.req.json()
        await clearFailedVideo(videoId)
        return c.json({ success: true })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.get('/api/extension/processed/:videoId', async (c) => {
    try {
        const exists = await isVideoProcessed(c.req.param('videoId'))
        return c.json({ success: true, exists })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 4. Track a channel
app.post('/api/extension/add-channel', async (c) => {
    try {
        const body = await c.req.json()
        console.log(`[Extension] Resolving channel for ${body.url}`)
        
        const info = await resolveChannelInfo(body.url)
        if (!info) {
            return c.json({ success: false, error: 'Could not resolve Channel ID from URL' }, 400)
        }

        let category = body.category;
        if (!category) {
            console.log(`[Extension] No category provided, auto-classifying: ${info.name}`);
            const result = await classifyChannel({
                channelId: info.id,
                channelName: info.name
            });
            category = result.category;
        }

        await addTrackedChannel({
            id: info.id,
            name: info.name,
            category: category
        })
        
        const subbed = await subscribeSingleChannel(info.id)
        
        return c.json({ 
            success: true, 
            channel: info,
            category: category,
            subscribed: subbed
        })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 5. List channels
app.get('/api/extension/channels', async (c) => {
    try {
        const channels = await getAllChannels()
        return c.json({ success: true, channels })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 6. Remove a channel
app.post('/api/extension/remove-channel', async (c) => {
    try {
        const { channelId } = await c.req.json()
        if (!channelId) return c.json({ success: false, error: 'Missing channelId' }, 400)
        
        await removeTrackedChannel(channelId)
        await unsubscribeSingleChannel(channelId).catch((err) => {
            console.warn(`[Extension] Unsubscribe failed for ${channelId}:`, err)
        })
        return c.json({ success: true })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 7. Get categories
app.get('/api/extension/categories', async (c) => {
    try {
        const categories = await getCategories()
        return c.json({ success: true, categories })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 8. Save/Update category
app.post('/api/extension/categories', async (c) => {
    try {
        const { name, prompt, model, visualAssets } = await c.req.json()
        if (!name || !prompt) return c.json({ success: false, error: 'Missing name or prompt' }, 400)

        await saveCategory(name, prompt, model, visualAssets)
        return c.json({ success: true })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 9. Delete category
app.post('/api/extension/categories/delete', async (c) => {
    try {
        const { name } = await c.req.json()
        if (!name) return c.json({ success: false, error: 'Missing name' }, 400)
        
        await deleteCategory(name)
        return c.json({ success: true })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 10. Rename category
app.post('/api/extension/categories/rename', async (c) => {
    try {
        const { oldName, newName } = await c.req.json()
        if (!oldName || !newName) return c.json({ success: false, error: 'Missing oldName or newName' }, 400)
        
        await renameCategory(oldName, newName)
        return c.json({ success: true })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 10b. Timed transcript cues for the history viewer
app.get('/api/extension/transcript/:videoId', async (c) => {
    try {
        const videoId = c.req.param('videoId')
        if (!videoId) return c.json({ success: false, error: 'Missing videoId' }, 400)
        const cues = await fetchTranscriptCues(videoId)
        if (!cues.length) return c.json({ success: false, error: 'No transcript' }, 404)
        return c.json({ success: true, cues })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 10c. Full description + draft resource block for the note viewer
app.get('/api/extension/description/:videoId', async (c) => {
    try {
        const videoId = c.req.param('videoId')
        if (!videoId) return c.json({ success: false, error: 'Missing videoId' }, 400)
        const description = await fetchVideoDescription(videoId)
        if (!description.trim()) return c.json({ success: false, error: 'No description' }, 404)
        return c.json({ success: true, description, descriptionBlock: description })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 11. Get history (processed videos)
app.get('/api/extension/history', async (c) => {
    try {
        const history = await getAllAnalyses()
        return c.json({ success: true, history })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 12. Get daily cost
app.get('/api/extension/cost', async (c) => {
    try {
        const costData = await getDailyCost()
        return c.json({ success: true, ...costData })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 13. Get video duration info
app.get('/api/extension/video-info', async (c) => {
    try {
        const url = c.req.query('url')
        if (!url) return c.json({ success: false, error: 'Missing url' }, 400)
        
        const duration = await resolveVideoDuration(url)
        return c.json({ success: true, duration })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 14. Update pending video category
app.post('/api/extension/queue/update-category', async (c) => {
    try {
        const { videoId, category } = await c.req.json()
        if (!videoId || !category) return c.json({ success: false, error: 'Missing videoId or category' }, 400)

        const pending = await getPendingVideos()
        const index = pending.findIndex(v => v.videoId === videoId)
        if (index === -1) {
            return c.json({ success: false, error: 'Video not found in pending queue' }, 404)
        }

        pending[index].category = category
        pending[index].needsCategory = false
        await updatePendingVideos(pending)
        return c.json({ success: true })
    } catch (e) {
        console.error('Error updating pending video category:', e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 15. Classify a video transcript using Gemini and the categorization prompt
app.post('/api/extension/classify-video', async (c) => {
    try {
        const { videoId } = await c.req.json()
        if (!videoId) return c.json({ success: false, error: 'Missing videoId' }, 400)

        // Fetch transcript sample
        const sample = await getTranscriptSample(videoId, 5000)
        if (!sample) {
            return c.json({ success: false, error: 'Could not retrieve transcript sample for video' }, 400)
        }

        const defaultPromptBase = `You are an expert Content Strategist. Based on the following transcript snippets from a YouTube channel, classify this channel into EXACTLY one of the following five categories.

CATEGORIES:
1. **Tactical**: Practical "how-to" guides, technical tutorials, software walkthroughs, coding, or step-by-step Standard Operating Procedures (SOPs).
2. **Ideation**: Brainstorming new business ideas, identifying market "white space," niche hunting, or exploring consumer trends.
3. **Strategy**: High-level frameworks, mental models, macro-economic shifts, philosophical "why" behind business decisions, or long-term industry positioning.
4. **News/Roundup**: Summaries of current events, industry headlines, weekly updates, or commentary on trending topics.
5. **second brain**: Personal Knowledge Management (PKM), productivity systems, note-taking methodologies, or "linking your thinking" workflows.

Instructions:
- Return ONLY the category name (one of: Tactical, Ideation, Strategy, News/Roundup, second brain).
- If the channel fits multiple categories, pick the most dominant one.`;

        let customPrompt = ""
        let customModel = ""
        try {
            const details = await getCategorisationPromptDetails()
            customPrompt = details.prompt
            customModel = details.model
        } catch (e) {
            console.warn('[WebApp] Failed to fetch custom prompt from KV, using default.', e)
        }

        const basePrompt = customPrompt || defaultPromptBase
        const finalModel = customModel || 'gemini-3.1-flash-lite'
        let prompt = ""
        if (basePrompt.includes("{{CONTENT_SNIPPETS}}")) {
            prompt = basePrompt.replace("{{CONTENT_SNIPPETS}}", sample)
        } else if (basePrompt.includes("{{content_snippets}}")) {
            prompt = basePrompt.replace("{{content_snippets}}", sample)
        } else {
            prompt = `${basePrompt}\n\nCONTENT SNIPPETS:\n${sample}`
        }

        const { text } = await completeText({
            model: finalModel,
            prompt,
            maxTokens: 1024,
            temperature: 0.1,
        })

        const category = text.trim().replace(/[*_]/g, "")
        const validCategories = ["Tactical", "Ideation", "Strategy", "News/Roundup", "second brain"]
        const finalCategory = validCategories.find(c => c.toLowerCase() === category.toLowerCase()) || "Strategy"

        return c.json({ success: true, category: finalCategory })
    } catch (e) {
        console.error('Error classifying video:', e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 16. Update channel configuration (name and category)
app.post('/api/extension/channels/update', async (c) => {
    try {
        const { channelId, name, category } = await c.req.json()
        if (!channelId || !name || !category) return c.json({ success: false, error: 'Missing channelId, name, or category' }, 400)

        const channels = await getAllChannels()
        const index = channels.findIndex(ch => ch.id === channelId)
        if (index === -1) {
            channels.push({ id: channelId, name, category })
        } else {
            channels[index].name = name
            channels[index].category = category
        }

        await updateAllChannels(channels)
        return c.json({ success: true })
    } catch (e) {
        console.error('Error updating channel:', e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 17. Get categorization prompt
app.get('/api/extension/categorisation-prompt', async (c) => {
    try {
        const details = await getCategorisationPromptDetails()
        return c.json({ success: true, prompt: details.prompt, model: details.model })
    } catch (e) {
        console.error('Error fetching categorization prompt:', e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// 18. Update categorization prompt
app.post('/api/extension/categorisation-prompt', async (c) => {
    try {
        const { prompt, model } = await c.req.json()
        if (typeof prompt !== 'string') return c.json({ success: false, error: 'Invalid prompt' }, 400)

        await saveCategorisationPrompt(prompt, model)
        return c.json({ success: true })
    } catch (e) {
        console.error('Error saving categorization prompt:', e)
        return c.json({ success: false, error: String(e) }, 500)
    }
})

app.post('/api/extension/backfill', async (c) => {
    try {
        const apiKey = process.env.GOOGLE_API_KEY
        if (!apiKey) return c.json({ success: false, error: 'GOOGLE_API_KEY missing' }, 500)

        const pending = await getPendingVideos()
        const channels = await getAllChannels()
        const ids = pending.map((v) => v.videoId).filter(Boolean)
        const meta = new Map<string, { title?: string; duration?: string }>()

        for (let i = 0; i < ids.length; i += 50) {
            const group = ids.slice(i, i + 50)
            const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${group.join(",")}&key=${apiKey}`
            const res = await fetch(url)
            const data: any = await res.json()
            for (const item of data.items || []) {
                const iso = item.contentDetails?.duration || ""
                const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
                let duration: string | undefined
                if (m) {
                    const sec = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)
                    const h = Math.floor(sec / 3600)
                    const min = Math.floor((sec % 3600) / 60)
                    const s = sec % 60
                    duration = h > 0 ? `${h}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${min}:${String(s).padStart(2, "0")}`
                }
                meta.set(item.id, { title: item.snippet?.title, duration })
            }
        }

        const patches = pending.map((v) => {
            const m = meta.get(v.videoId)
            return {
                ...v,
                title: (!v.title || v.title === "YouTube video feed" || v.title === "Untitled") && m?.title ? m.title : v.title,
                duration: v.duration || m?.duration,
            }
        })
        if (patches.length) await updatePendingVideos(patches)
        const keep = patches

        const named = await Promise.all(channels.map(async (ch) => {
            if (!isPlaceholderChannelName(ch.name)) return ch
            try {
                const info = await resolveChannelInfo(`https://www.youtube.com/channel/${ch.id}`)
                if (info?.name && !isPlaceholderChannelName(info.name)) {
                    return { ...ch, id: info.id || ch.id, name: info.name }
                }
            } catch {}
            return ch
        }))
        await updateAllChannels(named)

        return c.json({ success: true, pending: keep.length, channels: named.length })
    } catch (e) {
        return c.json({ success: false, error: String(e) }, 500)
    }
})

// Fallback to serve static landing page files
app.use('/*', serveStatic({ root: './landing-page' }))

const port = 3000
const hostname = process.env.HOST || '127.0.0.1'
console.log(`Extension Server is running on http://${hostname}:${port}`)

serve({
    fetch: app.fetch,
    port,
    hostname
})
