import { Controller, Delete, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { McpGuard, type McpRequest } from './mcp.guard';
import { McpService } from './mcp.service';

/** JSON-RPC is owned by the SDK; treating it as a REST DTO would strip protocol fields. */
@ApiExcludeController()
@UseGuards(McpGuard)
@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post()
  post(@Req() req: McpRequest, @Res() res: Response) { return this.mcp.handle(req, res); }

  @Get()
  get(@Res() res: Response) { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'Stateless MCP does not offer a GET event stream' }); }

  @Delete()
  delete(@Res() res: Response) { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'Stateless MCP has no sessions to delete' }); }
}
