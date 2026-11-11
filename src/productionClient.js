/**
 * Serve the built Vite application from the Express origin in production.
 * Using the same origin keeps Better Auth cookies, Google OAuth callbacks and
 * Socket.IO consistent without cross-site cookie workarounds.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const distDirectory = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const htmlFile = path.join(distDirectory, 'index.html');

export function mountProductionClient(app) {
  if (process.env.NODE_ENV !== 'production') return;
  if (!existsSync(htmlFile)) {
    console.warn('AEVORA client build missing at', htmlFile, 'Run npm run build in client/ before starting production.');
  }
  app.use(express.static(distDirectory, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get('*', (req, res, next) => {
    // API and Socket.IO paths never fall back to the React application.
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();
    if (!req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(htmlFile, (error) => { if (error) next(error); });
  });
}
