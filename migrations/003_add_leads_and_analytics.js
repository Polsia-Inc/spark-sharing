module.exports = {
  name: 'add_leads_and_analytics',
  up: async (client) => {
    // Leads table for email capture
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        source VARCHAR(100) DEFAULT 'direct',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source)`);

    // Page views table
    await client.query(`
      CREATE TABLE IF NOT EXISTS page_views (
        id SERIAL PRIMARY KEY,
        path VARCHAR(500) NOT NULL,
        referrer TEXT,
        user_agent TEXT,
        ip_hash VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_page_views_ip_hash ON page_views(ip_hash)`);

    // Events table for tracking business actions
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        metadata JSONB DEFAULT '{}',
        ip_hash VARCHAR(64),
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC)`);
  }
};
