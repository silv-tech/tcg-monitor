const BaseAdapter = require('./base');

class EBGamesAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
  }

  async fetchProducts() {
    // EB Games site rebuilt on Odoo with Cloudflare WAF — old selectors broken.
    // Adapter disabled in retailers.json. This stub prevents crashes if accidentally enabled.
    throw new Error('EB Games adapter disabled — site rebuilt on Odoo, needs full rewrite');
  }
}

module.exports = EBGamesAdapter;
