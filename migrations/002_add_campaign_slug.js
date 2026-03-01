module.exports = {
  name: 'add_campaign_slug',
  up: async (client) => {
    // Add slug column to campaigns
    await client.query(`
      ALTER TABLE campaigns
      ADD COLUMN slug VARCHAR(255) UNIQUE
    `);

    // Generate slugs for existing campaigns
    const campaigns = await client.query('SELECT id, name FROM campaigns');
    for (const campaign of campaigns.rows) {
      const slug = generateSlug(campaign.name);
      await client.query('UPDATE campaigns SET slug = $1 WHERE id = $2', [slug, campaign.id]);
    }

    // Make slug NOT NULL after populating
    await client.query(`
      ALTER TABLE campaigns
      ALTER COLUMN slug SET NOT NULL
    `);

    // Add index for faster lookups
    await client.query(`
      CREATE INDEX idx_campaigns_slug ON campaigns(slug)
    `);
  }
};

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100) + '-' + Date.now().toString(36);
}
