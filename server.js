const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { query } = require('./lib/db');
const { uploadToR2, deleteFromR2 } = require('./lib/r2');
const { runMigrations } = require('./lib/migrate');

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ===== BOT DETECTION =====
const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /facebookexternalhit/i, /twitterbot/i,
  /whatsapp/i, /linkedinbot/i, /slackbot/i, /googlebot/i, /bingbot/i,
  /yandex/i, /baiduspider/i, /duckduckbot/i, /gptbot/i, /claudebot/i,
  /anthropic-ai/i, /openai/i, /screenshot/i, /preview/i, /curl/i,
  /wget/i, /python-requests/i, /axios/i, /postman/i, /insomnia/i,
  /lighthouse/i, /pagespeed/i, /gtmetrix/i, /pingdom/i, /uptimerobot/i,
  /headless/i, /phantom/i, /selenium/i, /webdriver/i
];

function isBot(userAgent) {
  if (!userAgent || userAgent.trim() === '') return true;
  return BOT_PATTERNS.some(p => p.test(userAgent));
}

function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256').update(ip + 'spark-salt').digest('hex').substring(0, 16);
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || '';
}

// ===== ANALYTICS HELPERS =====
async function trackPageView(req) {
  try {
    const ua = req.headers['user-agent'] || '';
    if (isBot(ua)) return;
    const ipHash = hashIP(getClientIP(req));
    await query(
      'INSERT INTO page_views (path, referrer, user_agent, ip_hash) VALUES ($1, $2, $3, $4)',
      [req.path, req.headers['referer'] || null, ua, ipHash]
    );
  } catch (err) {
    console.error('[analytics] Page view error:', err.message);
  }
}

async function trackEvent(eventType, req, metadata = {}) {
  try {
    const ua = req.headers['user-agent'] || '';
    const ipHash = hashIP(getClientIP(req));
    await query(
      'INSERT INTO events (event_type, metadata, ip_hash, user_agent) VALUES ($1, $2, $3, $4)',
      [eventType, JSON.stringify(metadata), ipHash, ua]
    );
  } catch (err) {
    console.error('[analytics] Event error:', err.message);
  }
}

// ===== BODY PARSERS =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== HEALTH CHECK =====
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ===== PAGE VIEW TRACKING (BEFORE static files) =====
app.use((req, res, next) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/health') &&
    !req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)$/i)
  ) {
    // Fire and forget
    trackPageView(req).catch(() => {});
  }
  next();
});

// ===== STATIC FILES =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== SHARE PAGE ROUTES (must be before static catch-all) =====
// Universal campaign link (new)
app.get('/s/campaign/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// Individual share token link (legacy)
app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// ===== EMAIL CAPTURE (LEADS) =====
app.post('/api/leads', async (req, res) => {
  try {
    const { email, source } = req.body;
    if (!email || !email.includes('@') || !email.includes('.')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const result = await query(
      `INSERT INTO leads (email, source) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [cleanEmail, source || 'direct']
    );

    // Track the signup event
    trackEvent('lead_captured', req, { email: cleanEmail, source: source || 'direct' }).catch(() => {});

    if (result.rows.length > 0) {
      res.json({ success: true, message: "You're in! We'll be in touch soon." });
    } else {
      res.json({ success: true, message: "You're already on the list!" });
    }
  } catch (err) {
    console.error('[leads] Error:', err.message);
    res.status(500).json({ error: 'Failed to join. Please try again.' });
  }
});

// Lead stats for analytics dashboard
app.get('/api/leads/stats', async (req, res) => {
  try {
    const [total, bySource, recent] = await Promise.all([
      query('SELECT COUNT(*) as count FROM leads'),
      query('SELECT source, COUNT(*) as count FROM leads GROUP BY source ORDER BY count DESC'),
      query('SELECT email, source, created_at FROM leads ORDER BY created_at DESC LIMIT 50')
    ]);

    res.json({
      total: parseInt(total.rows[0].count),
      by_source: bySource.rows,
      recent: recent.rows
    });
  } catch (err) {
    console.error('[leads] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch lead stats' });
  }
});

// ===== CLIENT-SIDE EVENT TRACKING =====
app.post('/api/track', async (req, res) => {
  try {
    const { event_type, metadata } = req.body;
    if (!event_type) return res.status(400).json({ error: 'event_type required' });

    const validEvents = [
      'share_link_open', 'share_click_linkedin', 'share_click_x',
      'campaign_created', 'copy_text_clicked', 'download_image',
      'lead_captured', 'page_scroll', 'cta_click'
    ];

    if (!validEvents.includes(event_type)) {
      return res.status(400).json({ error: 'Invalid event type' });
    }

    await trackEvent(event_type, req, metadata || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Tracking failed' });
  }
});

// ===== CAMPAIGN CRUD =====

// List campaigns
app.get('/api/campaigns', async (req, res) => {
  try {
    const result = await query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM campaign_images WHERE campaign_id = c.id) as image_count,
        (SELECT COUNT(*) FROM share_links WHERE campaign_id = c.id) as link_count,
        (SELECT COALESCE(SUM(views), 0) FROM share_links WHERE campaign_id = c.id) as total_views,
        (SELECT COALESCE(SUM(shares), 0) FROM share_links WHERE campaign_id = c.id) as total_shares
      FROM campaigns c
      ORDER BY c.created_at DESC
    `);
    res.json({ campaigns: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single campaign with images and links
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!campaign.rows[0]) return res.status(404).json({ error: 'Campaign not found' });

    const images = await query(
      'SELECT * FROM campaign_images WHERE campaign_id = $1 ORDER BY sort_order',
      [req.params.id]
    );
    const links = await query(
      'SELECT * FROM share_links WHERE campaign_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({
      ...campaign.rows[0],
      images: images.rows,
      links: links.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create campaign
app.post('/api/campaigns', async (req, res) => {
  try {
    const { name, description, social_copies } = req.body;
    if (!name) return res.status(400).json({ error: 'Campaign name is required' });

    const slug = generateSlug(name);
    const result = await query(
      `INSERT INTO campaigns (name, slug, description, social_copies) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, slug, description || '', JSON.stringify(social_copies || [])]
    );

    // Track campaign creation
    trackEvent('campaign_created', req, { campaign_name: name, campaign_id: result.rows[0].id }).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update campaign
app.put('/api/campaigns/:id', async (req, res) => {
  try {
    const { name, description, social_copies, status } = req.body;
    const result = await query(
      `UPDATE campaigns SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        social_copies = COALESCE($3, social_copies),
        status = COALESCE($4, status),
        updated_at = NOW()
      WHERE id = $5 RETURNING *`,
      [name, description, social_copies ? JSON.stringify(social_copies) : null, status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete campaign
app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    await query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== IMAGE UPLOAD =====

// Upload images to campaign
app.post('/api/campaigns/:id/images', upload.array('images', 10), async (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = await query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
    if (!campaign.rows[0]) return res.status(404).json({ error: 'Campaign not found' });

    const uploaded = [];
    for (const file of (req.files || [])) {
      const r2File = await uploadToR2(file.buffer, file.originalname, file.mimetype);
      const result = await query(
        `INSERT INTO campaign_images (campaign_id, image_url, r2_key, alt_text, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [campaignId, r2File.url, r2File.key, req.body.alt_text || file.originalname, uploaded.length]
      );
      uploaded.push(result.rows[0]);
    }
    res.json({ images: uploaded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete image
app.delete('/api/campaigns/:id/images/:imageId', async (req, res) => {
  try {
    const img = await query('SELECT * FROM campaign_images WHERE id = $1 AND campaign_id = $2', [req.params.imageId, req.params.id]);
    if (!img.rows[0]) return res.status(404).json({ error: 'Image not found' });

    if (img.rows[0].r2_key) {
      await deleteFromR2(img.rows[0].r2_key).catch(() => {});
    }
    await query('DELETE FROM campaign_images WHERE id = $1', [req.params.imageId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SHARE LINK ENGINE =====

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100) + '-' + Date.now().toString(36);
}

// Generate share links (bulk)
app.post('/api/campaigns/:id/links', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = await query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
    if (!campaign.rows[0]) return res.status(404).json({ error: 'Campaign not found' });

    const { recipients } = req.body; // [{name, email}]
    if (!recipients || !recipients.length) {
      return res.status(400).json({ error: 'At least one recipient is required' });
    }

    const created = [];
    for (const r of recipients) {
      const token = generateToken();
      const result = await query(
        `INSERT INTO share_links (campaign_id, token, recipient_name, recipient_email)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [campaignId, token, r.name || '', r.email || '']
      );
      created.push(result.rows[0]);
    }
    res.json({ links: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List share links for campaign
app.get('/api/campaigns/:id/links', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM share_links WHERE campaign_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ links: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SHARE PAGE API =====

// Get share data by campaign slug (universal link)
app.get('/api/share/campaign/:slug', async (req, res) => {
  try {
    const campaign = await query('SELECT * FROM campaigns WHERE slug = $1', [req.params.slug]);
    if (!campaign.rows[0]) return res.status(404).json({ error: 'Campaign not found' });

    const images = await query(
      'SELECT * FROM campaign_images WHERE campaign_id = $1 ORDER BY sort_order',
      [campaign.rows[0].id]
    );

    // Track share link open event
    trackEvent('share_link_open', req, {
      campaign_id: campaign.rows[0].id,
      campaign_name: campaign.rows[0].name,
      link_type: 'universal'
    }).catch(() => {});

    await query('UPDATE campaigns SET updated_at = NOW() WHERE id = $1', [campaign.rows[0].id]);

    res.json({
      campaign: campaign.rows[0],
      images: images.rows,
      recipient: { name: '', email: '' },
      isUniversalLink: true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get share data by token (legacy per-recipient links)
app.get('/api/share/:token', async (req, res) => {
  try {
    const link = await query('SELECT * FROM share_links WHERE token = $1', [req.params.token]);
    if (!link.rows[0]) return res.status(404).json({ error: 'Share link not found' });

    const shareLink = link.rows[0];

    // Increment views
    await query('UPDATE share_links SET views = views + 1 WHERE id = $1', [shareLink.id]);

    // Track share link open event
    trackEvent('share_link_open', req, {
      campaign_id: shareLink.campaign_id,
      link_type: 'individual',
      recipient: shareLink.recipient_name
    }).catch(() => {});

    const campaign = await query('SELECT * FROM campaigns WHERE id = $1', [shareLink.campaign_id]);
    const images = await query(
      'SELECT * FROM campaign_images WHERE campaign_id = $1 ORDER BY sort_order',
      [shareLink.campaign_id]
    );

    res.json({
      campaign: campaign.rows[0],
      images: images.rows,
      recipient: {
        name: shareLink.recipient_name,
        email: shareLink.recipient_email
      },
      isUniversalLink: false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track share event (enhanced: works for both token and universal links)
app.post('/api/share-events', async (req, res) => {
  try {
    const { token, platform, image_url, campaign_slug } = req.body;

    // Track in events table regardless of link type
    trackEvent(`share_click_${platform === 'linkedin' ? 'linkedin' : 'x'}`, req, {
      platform,
      image_url: image_url || null,
      campaign_slug: campaign_slug || null,
      token: token || null
    }).catch(() => {});

    // Also track in share_events table for token-based links
    if (token) {
      const link = await query('SELECT id FROM share_links WHERE token = $1', [token]);
      if (link.rows[0]) {
        await query(
          'INSERT INTO share_events (share_link_id, platform, image_url) VALUES ($1, $2, $3)',
          [link.rows[0].id, platform, image_url || null]
        );
        await query('UPDATE share_links SET shares = shares + 1 WHERE id = $1', [link.rows[0].id]);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CAMPAIGN ANALYTICS =====
app.get('/api/campaigns/:id/analytics', async (req, res) => {
  try {
    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM share_links WHERE campaign_id = $1) as total_links,
        (SELECT COALESCE(SUM(views), 0) FROM share_links WHERE campaign_id = $1) as total_views,
        (SELECT COALESCE(SUM(shares), 0) FROM share_links WHERE campaign_id = $1) as total_shares,
        (SELECT COUNT(*) FROM share_events se JOIN share_links sl ON se.share_link_id = sl.id WHERE sl.campaign_id = $1 AND se.platform = 'linkedin') as linkedin_shares,
        (SELECT COUNT(*) FROM share_events se JOIN share_links sl ON se.share_link_id = sl.id WHERE sl.campaign_id = $1 AND se.platform = 'x') as x_shares,
        (SELECT COUNT(*) FROM share_events se JOIN share_links sl ON se.share_link_id = sl.id WHERE sl.campaign_id = $1 AND se.platform = 'copy') as copy_shares
    `, [req.params.id]);

    const topSharers = await query(`
      SELECT sl.recipient_name, sl.recipient_email, sl.views, sl.shares
      FROM share_links sl WHERE sl.campaign_id = $1
      ORDER BY sl.shares DESC LIMIT 10
    `, [req.params.id]);

    res.json({
      ...stats.rows[0],
      top_sharers: topSharers.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== METRICS ENDPOINT (JSON for monitoring) =====
app.get('/api/metrics', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [pageViews, uniqueVisitors, leads, campaigns, shareOpens, shareClicks, topPages, eventBreakdown] = await Promise.all([
      query('SELECT COUNT(*) as count FROM page_views WHERE created_at > $1', [since]),
      query('SELECT COUNT(DISTINCT ip_hash) as count FROM page_views WHERE created_at > $1', [since]),
      query('SELECT COUNT(*) as count FROM leads WHERE created_at > $1', [since]),
      query('SELECT COUNT(*) as count FROM campaigns WHERE created_at > $1', [since]),
      query("SELECT COUNT(*) as count FROM events WHERE event_type = 'share_link_open' AND created_at > $1", [since]),
      query("SELECT COUNT(*) as count FROM events WHERE event_type IN ('share_click_linkedin', 'share_click_x') AND created_at > $1", [since]),
      query('SELECT path, COUNT(*) as views FROM page_views WHERE created_at > $1 GROUP BY path ORDER BY views DESC LIMIT 10', [since]),
      query('SELECT event_type, COUNT(*) as count FROM events WHERE created_at > $1 GROUP BY event_type ORDER BY count DESC', [since])
    ]);

    res.json({
      period: `last_${days}_days`,
      generated_at: new Date().toISOString(),
      overview: {
        page_views: parseInt(pageViews.rows[0].count),
        unique_visitors: parseInt(uniqueVisitors.rows[0].count),
        leads_captured: parseInt(leads.rows[0].count),
        campaigns_created: parseInt(campaigns.rows[0].count),
        share_link_opens: parseInt(shareOpens.rows[0].count),
        share_clicks: parseInt(shareClicks.rows[0].count)
      },
      top_pages: topPages.rows,
      events: eventBreakdown.rows
    });
  } catch (err) {
    console.error('[metrics] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// ===== ADMIN PAGE ROUTES =====
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});

// ===== START SERVER =====
async function start() {
  try {
    console.log('Running migrations...');
    await runMigrations();
    console.log('Migrations complete');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Spark Sharing running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
