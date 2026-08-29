const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('../config');
const routes = require('./routes');
const logger = require('../monitoring/logger');

function createAdminServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // API key auth for admin routes
  app.use('/api', (req, res, next) => {
    // Health endpoint is public
    if (req.path === '/health') return next();

    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== config.admin.apiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  app.use('/api', routes);

  // Serve admin UI
  app.use(express.static(path.join(__dirname, '../../admin-ui')));
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../admin-ui/index.html'));
  });

  const server = app.listen(config.admin.port, () => {
    logger.info(`Admin server running on port ${config.admin.port}`);
  });

  return server;
}

module.exports = { createAdminServer };
