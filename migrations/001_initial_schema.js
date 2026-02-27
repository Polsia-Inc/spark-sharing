module.exports = {
  name: 'initial_schema',
  up: async (client) => {
    await client.query(`
      CREATE TABLE campaigns (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        social_copies JSONB DEFAULT '[]',
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE campaign_images (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        r2_key TEXT,
        alt_text VARCHAR(500),
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_campaign_images_campaign ON campaign_images(campaign_id)
    `);

    await client.query(`
      CREATE TABLE share_links (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        token VARCHAR(64) UNIQUE NOT NULL,
        recipient_name VARCHAR(255),
        recipient_email VARCHAR(255),
        views INTEGER DEFAULT 0,
        shares INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_share_links_campaign ON share_links(campaign_id)
    `);

    await client.query(`
      CREATE INDEX idx_share_links_token ON share_links(token)
    `);

    await client.query(`
      CREATE TABLE share_events (
        id SERIAL PRIMARY KEY,
        share_link_id INTEGER REFERENCES share_links(id) ON DELETE CASCADE,
        platform VARCHAR(50) NOT NULL,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_share_events_link ON share_events(share_link_id)
    `);
  }
};
