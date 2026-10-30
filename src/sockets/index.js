const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const logger = require('../utils/logger');

let io = null;

/**
 * Sets up Socket.IO on the same HTTP server as Express. Clients authenticate
 * by passing their access token: `io(URL, { auth: { token } })`. Every
 * socket is placed in a room scoped to that user (`user:<id>`), so emitting
 * to `user:<brokerId>` reaches only that broker's connected clients —
 * mirroring the "never mix sessions" requirement from the WhatsApp module.
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientUrl, credentials: true },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Missing auth token'));
      const payload = jwt.verify(token, env.jwt.accessSecret);
      socket.userId = payload.sub;
      socket.role = payload.role;
      next();
    } catch (err) {
      next(new Error('Invalid or expired auth token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    logger.info(`[socket] Client connected: user:${socket.userId}`);

    socket.on('disconnect', () => {
      logger.info(`[socket] Client disconnected: user:${socket.userId}`);
    });
  });

  return io;
}

/** Used by services (e.g. WhatsApp session manager) to push events to a specific user. */
function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized — call initSocket(server) first');
  return io;
}

module.exports = { initSocket, emitToUser, getIO };
