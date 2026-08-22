import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Plugin, ViteDevServer } from 'vite';

const VOICE_STREAM_PATH = '/api/voice-stream';
const MAX_QUEUED_MESSAGES = 8;

function readPath(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
}

function sendFailure(client: WebSocket, code: string): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify({ type: 'recognition_failed', code, at: Date.now() }));
}

function closeSocket(socket: WebSocket): void {
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

function forwardRawData(
  target: WebSocket,
  data: RawData,
  isBinary: boolean,
): void {
  if (target.readyState !== WebSocket.OPEN) return;
  target.send(data, { binary: isBinary });
}

function attachVoiceStreamBridge(
  server: ViteDevServer,
  targetUrl: string,
): () => void {
  const httpServer = server.httpServer;
  if (!httpServer) {
    throw new Error('Vite HTTP server is not available for voice streaming.');
  }

  const webSocketServer = new WebSocketServer({ noServer: true });
  const handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    if (readPath(request) !== VOICE_STREAM_PATH) return;

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      let target: WebSocket | null = null;
      let targetOpen = false;
      let closed = false;
      const queuedMessages: Array<{ data: RawData; isBinary: boolean }> = [];

      const closeBoth = () => {
        if (closed) return;
        closed = true;
        closeSocket(client);
        if (target) closeSocket(target);
      };

      try {
        target = new WebSocket(targetUrl);
      } catch {
        sendFailure(client, 'voice-transport-unavailable');
        closeBoth();
        return;
      }

      target.on('open', () => {
        targetOpen = true;
        for (const message of queuedMessages.splice(0)) {
          forwardRawData(target as WebSocket, message.data, message.isBinary);
        }
      });
      target.on('message', (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        client.send(data, { binary: isBinary });
      });
      target.on('error', () => {
        if (!closed) sendFailure(client, 'stt-unavailable');
        closeBoth();
      });
      target.on('close', () => {
        if (!closed) sendFailure(client, 'voice-transport-closed');
        closeBoth();
      });

      client.on('message', (data, isBinary) => {
        if (closed) return;
        if (!targetOpen) {
          if (queuedMessages.length >= MAX_QUEUED_MESSAGES) {
            sendFailure(client, 'voice-transport-backpressure');
            closeBoth();
            return;
          }
          queuedMessages.push({ data, isBinary });
          return;
        }
        forwardRawData(target as WebSocket, data, isBinary);
      });
      client.on('error', closeBoth);
      client.on('close', () => {
        closed = true;
        if (target) closeSocket(target);
      });
    });
  };

  httpServer.on('upgrade', handleUpgrade);
  return () => {
    httpServer.off('upgrade', handleUpgrade);
    webSocketServer.close();
  };
}

export function voiceStreamProxyPlugin(targetUrl: string): Plugin {
  return {
    name: 'vayria-voice-stream-proxy',
    configureServer(server) {
      const detach = attachVoiceStreamBridge(server, targetUrl);
      server.httpServer?.once('close', detach);
    },
  };
}
