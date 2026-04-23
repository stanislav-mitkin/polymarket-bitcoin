import express from 'express';
import path from 'path';
import { getStats, getLiveStats, getRecentTrades, getPnlTimeline } from '../db/database';
import { loadModel } from '../model/trainer';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// __dirname resolves correctly in both modes:
//   tsx (dev):  src/dashboard/  → src/dashboard/public/
//   node dist:  dist/dashboard/ → dist/dashboard/public/
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (_req, res) => {
  try {
    res.json(getStats());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/stats/live', (_req, res) => {
  try {
    res.json(getLiveStats());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/trades', (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit ?? '100'));
    res.json(getRecentTrades(limit));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/model', (_req, res) => {
  try {
    const model = loadModel();
    if (!model) return res.json({ active: false });
    res.json({
      active: true,
      trainedAt: model.trainedAt,
      trainingSamples: model.trainingSamples,
      trainAcc: model.metrics.trainAcc,
      valAcc: model.metrics.valAcc,
      valLoss: model.metrics.valLoss,
      featureImportances: model.metrics.featureImportances,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/pnl-timeline', (_req, res) => {
  try {
    res.json(getPnlTimeline());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export function startDashboard(): void {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Dashboard] Running at http://localhost:${PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Dashboard] Port ${PORT} already in use. Run: lsof -ti :${PORT} | xargs kill -9`);
    } else {
      console.error('[Dashboard] Server error:', err);
    }
  });
}
