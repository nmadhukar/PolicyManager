import type { INestApplication } from '@nestjs/common';
import express from 'express';
import { McpService } from './mcp.service';

/** Call with Nest bodyParser:false BEFORE app.init/listen; REST retains the default 100 KiB cap. */
export function installMcpBodyParsing(app: INestApplication): void {
  const { config } = app.get(McpService);
  app.use('/api/mcp', (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!config.enabled) { res.status(404).json({ message: 'Not Found' }); return; }
    next();
  }, express.json({ limit: config.maxRequestBytes }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
}
