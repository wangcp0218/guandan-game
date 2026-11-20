import './env';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { setupSocketHandlers } from './handlers/socketHandlers';

const app = express();
const basePath = (process.env.PUBLIC_BASE_PATH || '').replace(/\/+$/, '');
app.use(cors());
app.use(express.json());

// Compiled entry: server/dist/server/src/index.js.
const clientDist = path.resolve(__dirname, '../../../../client/dist');
if (basePath) app.get('/', (_req, res) => res.redirect(`${basePath}/`));
app.use(basePath || '/', express.static(clientDist, { index: false }));
app.get([`${basePath}/`, `${basePath}/lobby`, `${basePath}/game/:roomId`], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(clientDist, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  path: `${basePath}/socket.io`,
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

setupSocketHandlers(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`OOWSP Game Server running on port ${PORT}`);
});

export default server;
