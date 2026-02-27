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

// ===== STATIC FILES =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== SHARE PAGE ROUTE (must be before static catch-all) =====
app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
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

    const result = await query(
      `INSERT INTO campaigns (name, description, social_copies) VALUES ($1, $2, $3) RETURNING *`,
      [name, description || '', JSON.stringify(social_copies || [])]
    );
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

// Get share data by token
app.get('/api/share/:token', async (req, res) => {
  try {
    const link = await query('SELECT * FROM share_links WHERE token = $1', [req.params.token]);
    if (!link.rows[0]) return res.status(404).json({ error: 'Share link not found' });

    const shareLink = link.rows[0];

    // Increment views
    await query('UPDATE share_links SET views = views + 1 WHERE id = $1', [shareLink.id]);

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
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track share event
app.post('/api/share-events', async (req, res) => {
  try {
    const { token, platform, image_url } = req.body;
    const link = await query('SELECT id FROM share_links WHERE token = $1', [token]);
    if (!link.rows[0]) return res.status(404).json({ error: 'Share link not found' });

    await query(
      'INSERT INTO share_events (share_link_id, platform, image_url) VALUES ($1, $2, $3)',
      [link.rows[0].id, platform, image_url || null]
    );
    await query('UPDATE share_links SET shares = shares + 1 WHERE id = $1', [link.rows[0].id]);

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

// ===== ADMIN PAGE ROUTES =====
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
