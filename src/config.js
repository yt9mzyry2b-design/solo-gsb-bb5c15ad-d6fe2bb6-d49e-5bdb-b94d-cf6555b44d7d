'use strict';

const path = require('path');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.LC_DATA_DIR || path.join(__dirname, '..', 'data'),
  dbFile: process.env.LC_DB_FILE || null,
};
